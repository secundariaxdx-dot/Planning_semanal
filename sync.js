// Sincronización con un Gist secreto de GitHub.
import { merge, normalizeState, prune } from './store.js';

const API = 'https://api.github.com';
const FILE = 'planning-semanal.json';
const TOKEN_KEY = 'planning-semanal:token';
const GIST_KEY = 'planning-semanal:gist';
const DEBOUNCE_MS = 1500;
const POLL_MS = 45_000;
const MIN_AUTO_GAP_MS = 4000;

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignorar */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignorar */ } },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class GistSync {
  /**
   * @param {object} opts
   * @param {() => object} opts.getState     devuelve el estado local actual
   * @param {(s: object) => void} opts.setState  sustituye el estado local por el fusionado
   * @param {(state: string, detail?: string) => void} opts.onStatus
   */
  constructor({ getState, setState, onStatus }) {
    this.getState = getState;
    this.setState = setState;
    this.onStatus = onStatus;
    this.running = false;
    this.again = false;
    this.timer = null;
    this.lastSync = null;
    this.lastStart = 0;
    // Última copia descargada: { etag, content }. Permite preguntar a GitHub
    // «¿ha cambiado?» y recibir un 304 sin datos si no ha cambiado.
    this.remote = null;
    this.conditional = true;
  }

  get token() { return ls.get(TOKEN_KEY); }
  get gistId() { return ls.get(GIST_KEY); }
  get configured() { return !!this.token; }

  start() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.auto();
    });
    window.addEventListener('online', () => this.auto());
    window.addEventListener('focus', () => this.auto());
    setInterval(() => {
      if (document.visibilityState === 'visible') this.auto();
    }, POLL_MS);
    if (this.configured) this.syncNow();
    else this.onStatus('off');
  }

  /** Sincronización automática: se salta si acaba de lanzarse otra. */
  auto() {
    if (Date.now() - this.lastStart < MIN_AUTO_GAP_MS) return;
    this.syncNow();
  }

  /** Programa una sincronización poco después de un cambio local. */
  schedule() {
    if (!this.configured) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow(), DEBOUNCE_MS);
  }

  async connect(token) {
    token = token.trim();
    if (!token) throw new Error('Pega un token primero.');
    const prevToken = this.token;
    ls.set(TOKEN_KEY, token);
    ls.del(GIST_KEY);
    this.remote = null;
    try {
      const { data: user } = await this.request('/user');
      await this.locateGist();
      await this.syncNow({ throwOnError: true });
      return user.login;
    } catch (err) {
      if (prevToken) ls.set(TOKEN_KEY, prevToken); else ls.del(TOKEN_KEY);
      throw err;
    }
  }

  disconnect() {
    clearTimeout(this.timer);
    ls.del(TOKEN_KEY);
    ls.del(GIST_KEY);
    this.remote = null;
    this.onStatus('off');
  }

  async syncNow({ throwOnError = false } = {}) {
    if (!this.configured) return;
    if (this.running) { this.again = true; return; }
    this.running = true;
    this.lastStart = Date.now();
    clearTimeout(this.timer);
    this.onStatus('syncing');
    try {
      if (!this.gistId) await this.locateGist();
      let remote;
      try {
        remote = await this.pull();
      } catch (err) {
        if (err.status !== 404) throw err;
        // El gist se borró: buscar otro o crear uno nuevo.
        ls.del(GIST_KEY);
        this.remote = null;
        await this.locateGist();
        remote = await this.pull();
      }
      // Fusión síncrona: no hay "await" entre leer el estado local y escribirlo,
      // así no se pierde ningún cambio hecho mientras tanto.
      const { merged, localChanged, remoteChanged } = merge(this.getState(), remote);
      if (localChanged) this.setState(merged);
      if (remoteChanged) await this.push(merged);
      this.lastSync = new Date();
      this.onStatus('ok');
    } catch (err) {
      const offline = !navigator.onLine || err instanceof TypeError;
      this.onStatus(offline ? 'offline' : 'error', describeError(err));
      if (throwOnError) throw err;
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.syncNow(); }
    }
  }

  // ---------- GitHub API ----------

  /** Devuelve { status, data, etag }. Con `etag`, GitHub puede contestar 304 (sin datos). */
  async request(path, { method = 'GET', body, etag } = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(API + path, {
      method,
      headers,
      cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 304) return { status: 304, data: null, etag };
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* ignorar */ }
      throw new HttpError(res.status, msg || res.statusText);
    }
    return {
      status: res.status,
      data: res.status === 204 ? null : await res.json(),
      etag: res.headers.get('ETag'),
    };
  }

  /** Busca un gist del usuario con nuestro archivo; si no hay, lo crea. */
  async locateGist() {
    for (let page = 1; page <= 10; page++) {
      const { data: list } = await this.request(`/gists?per_page=100&page=${page}`);
      const found = list.find((g) => g.files && g.files[FILE]);
      if (found) { ls.set(GIST_KEY, found.id); return found.id; }
      if (list.length < 100) break;
    }
    const { data: created } = await this.request('/gists', {
      method: 'POST',
      body: {
        description: 'Planning semanal — datos de la app (no borrar)',
        public: false,
        files: { [FILE]: { content: JSON.stringify(this.getState()) } },
      },
    });
    ls.set(GIST_KEY, created.id);
    return created.id;
  }

  async pull() {
    const path = `/gists/${this.gistId}`;
    const etag = this.conditional && this.remote ? this.remote.etag : null;
    let res;
    try {
      res = await this.request(path, { etag });
    } catch (err) {
      // Si el navegador rechaza la petición condicional, repetir sin ella.
      if (!etag || !(err instanceof TypeError) || !navigator.onLine) throw err;
      this.conditional = false;
      res = await this.request(path);
    }

    let content;
    if (res.status === 304) {
      content = this.remote.content;
    } else {
      const file = res.data.files && res.data.files[FILE];
      content = file ? file.content : '';
      if (file && file.truncated && file.raw_url) {
        content = await (await fetch(file.raw_url, { cache: 'no-store' })).text();
      }
      this.remote = res.etag ? { etag: res.etag, content } : null;
    }
    // Se interpreta de nuevo cada vez: la app modifica los objetos del estado
    // y la copia guardada no debe compartirlos.
    let parsed = null;
    try { parsed = JSON.parse(content); } catch { /* vacío o dañado */ }
    return prune(normalizeState(parsed));
  }

  async push(state) {
    await this.request(`/gists/${this.gistId}`, {
      method: 'PATCH',
      body: { files: { [FILE]: { content: JSON.stringify(state) } } },
    });
    this.remote = null; // el gist ha cambiado: la próxima lectura será completa
  }
}

function describeError(err) {
  if (err instanceof TypeError || !navigator.onLine) return 'Sin conexión: los cambios se guardan aquí y se subirán después.';
  if (err.status === 401) return 'El token de GitHub no es válido o ha caducado.';
  if (err.status === 403) return 'GitHub ha rechazado la petición (¿el token tiene el permiso «gist»?).';
  if (err.status === 404) return 'No se encuentra el gist (¿el token tiene el permiso «gist»?).';
  return err.message || 'Error desconocido.';
}
