// Sincronización con un Gist secreto de GitHub.
import { merge, normalizeState } from './store.js';

const API = 'https://api.github.com';
const FILE = 'planning-semanal.json';
const TOKEN_KEY = 'planning-semanal:token';
const GIST_KEY = 'planning-semanal:gist';
const DEBOUNCE_MS = 1500;
const POLL_MS = 45_000;

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
  }

  get token() { return ls.get(TOKEN_KEY); }
  get gistId() { return ls.get(GIST_KEY); }
  get configured() { return !!this.token; }

  start() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.syncNow();
    });
    window.addEventListener('online', () => this.syncNow());
    window.addEventListener('focus', () => this.syncNow());
    setInterval(() => {
      if (document.visibilityState === 'visible') this.syncNow();
    }, POLL_MS);
    if (this.configured) this.syncNow();
    else this.onStatus('off');
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
    try {
      const user = await this.request('/user');
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
    this.onStatus('off');
  }

  async syncNow({ throwOnError = false } = {}) {
    if (!this.configured) return;
    if (this.running) { this.again = true; return; }
    this.running = true;
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

  async request(path, { method = 'GET', body } = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(API + path, {
      method,
      headers,
      cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* ignorar */ }
      throw new HttpError(res.status, msg || res.statusText);
    }
    return res.status === 204 ? null : res.json();
  }

  /** Busca un gist del usuario con nuestro archivo; si no hay, lo crea. */
  async locateGist() {
    for (let page = 1; page <= 10; page++) {
      const list = await this.request(`/gists?per_page=100&page=${page}`);
      const found = list.find((g) => g.files && g.files[FILE]);
      if (found) { ls.set(GIST_KEY, found.id); return found.id; }
      if (list.length < 100) break;
    }
    const created = await this.request('/gists', {
      method: 'POST',
      body: {
        description: 'Planning semanal — datos de la app (no borrar)',
        public: false,
        files: { [FILE]: { content: serialize(this.getState()) } },
      },
    });
    ls.set(GIST_KEY, created.id);
    return created.id;
  }

  async pull() {
    const gist = await this.request(`/gists/${this.gistId}`);
    const file = gist.files && gist.files[FILE];
    if (!file) return normalizeState(null);
    let content = file.content;
    if (file.truncated && file.raw_url) {
      const res = await fetch(file.raw_url, { cache: 'no-store' });
      content = await res.text();
    }
    try { return normalizeState(JSON.parse(content)); }
    catch { return normalizeState(null); }
  }

  async push(state) {
    await this.request(`/gists/${this.gistId}`, {
      method: 'PATCH',
      body: { files: { [FILE]: { content: serialize(state) } } },
    });
  }
}

function serialize(state) {
  return JSON.stringify(state);
}

function describeError(err) {
  if (err instanceof TypeError || !navigator.onLine) return 'Sin conexión: los cambios se guardan aquí y se subirán después.';
  if (err.status === 401) return 'El token no es válido o ha caducado.';
  if (err.status === 403) return 'GitHub ha rechazado la petición (¿el token tiene el permiso «gist»?).';
  if (err.status === 404) return 'No se encuentra el gist (¿el token tiene el permiso «gist»?).';
  return err.message || 'Error desconocido.';
}
