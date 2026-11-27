// Integración con Google Calendar (calendario principal).
//
// - Sin servidor: el inicio de sesión usa Google Identity Services (token de acceso
//   de 1 hora, sin «refresh token»). Pasada la hora hay que pulsar «Reconectar».
// - Los eventos viven solo en Google. Aquí solo hay una caché local (para verlos sin
//   conexión), así que no puede haber eventos duplicados: se identifican por su id.
// - Los cambios hechos directamente en Google se ven al consultar de nuevo la semana
//   (al abrirla, al volver a la app y cada minuto).

const KEY = 'planning-semanal:gcal';
const CACHE_KEY = 'planning-semanal:gcal-events';
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
// Solo los archivos que crea la propia app (no da acceso al resto de tu Drive).
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const CLIENT_ID_RE = /^[\w-]+(\.[\w-]+)*\.apps\.googleusercontent\.com$/;
const MAX_CACHED_WEEKS = 8;

// ---------------------------------------------------------------- fechas

const pad = (n) => String(n).padStart(2, '0');
export const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateOfKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const addDaysKey = (k, n) => keyOf(addDays(dateOfKey(k), n));
const localDate = (key, time) => {
  const [y, m, d] = key.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
};
/** Fecha y hora con la diferencia horaria, p. ej. 2026-11-19T10:00:00+01:00. */
function isoWithOffset(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${keyOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// ---------------------------------------------------------------- errores

export class GCalError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

async function failFrom(res) {
  let reason = '';
  let detail = '';
  try {
    const j = await res.json();
    reason = j?.error?.errors?.[0]?.reason || j?.error?.status || '';
    detail = j?.error?.message || '';
  } catch { /* sin cuerpo */ }
  const s = res.status;
  if (s === 401) return new GCalError('auth', 'La sesión de Google ha caducado. Pulsa «Reconectar».', s);
  if (s === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason + detail)) {
    return new GCalError('setup', 'La API de Google Calendar no está activada en tu proyecto de Google Cloud.', s);
  }
  if (s === 403 && /rateLimit|quota/i.test(reason)) {
    return new GCalError('rate', 'Google pide ir más despacio. Inténtalo de nuevo en un momento.', s);
  }
  if (s === 403 && /insufficient|PERMISSION_DENIED/i.test(reason + detail)) {
    return new GCalError('perm', 'Google ha denegado el permiso. Desconecta y vuelve a conectar aceptando el acceso al calendario.', s);
  }
  if (s === 403) return new GCalError('denied', 'Google no permite cambiar este evento (quizá solo puede hacerlo su organizador).', s);
  if (s === 409) return new GCalError('conflict', 'Ese evento ya existe en Google Calendar.', s);
  if (s === 404 || s === 410) return new GCalError('gone', 'Ese evento ya no existe en Google Calendar.', s);
  if (s === 429) return new GCalError('rate', 'Google pide ir más despacio. Inténtalo de nuevo en un momento.', s);
  return new GCalError('http', `Google Calendar respondió con un error (${s}).`, s);
}

// ---------------------------------------------------------------- Google Identity Services

let gisPromise = null;
function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; s.remove(); reject(new GCalError('offline', 'No se pudo cargar el inicio de sesión de Google. Revisa tu conexión.')); };
    document.head.append(s);
  });
  return gisPromise;
}

// ---------------------------------------------------------------- eventos

/** Evento de la API → forma sencilla. Fechas como Date locales; fin exclusivo. */
function normalize(item) {
  if (!item || !item.id || item.status === 'cancelled' || !item.start || !item.end) return null;
  const allDay = !!item.start.date;
  const start = allDay ? dateOfKey(item.start.date) : new Date(item.start.dateTime);
  const end = allDay ? dateOfKey(item.end.date) : new Date(item.end.dateTime);
  if (Number.isNaN(+start) || Number.isNaN(+end)) return null;
  return {
    id: item.id,
    title: item.summary || '(Sin título)',
    allDay,
    start,
    end,
    recurring: !!item.recurringEventId,
    link: item.htmlLink || '',
    raw: item,
  };
}

/** Cuerpo para crear (`patch` = false) o modificar (`patch` = true) un evento. */
function bodyFrom(f, patch) {
  const body = {};
  if (f.title !== undefined) body.summary = f.title;
  const s = f.schedule;
  if (!s) return body;
  if (s.allDay) {
    body.start = { date: s.startDate };
    body.end = { date: addDaysKey(s.endDate, 1) }; // en Google, el fin de «todo el día» es exclusivo
    if (patch) { body.start.dateTime = null; body.start.timeZone = null; body.end.dateTime = null; body.end.timeZone = null; }
  } else {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    body.start = { dateTime: isoWithOffset(localDate(s.startDate, s.startTime)), timeZone };
    body.end = { dateTime: isoWithOffset(localDate(s.endDate, s.endTime)), timeZone };
    if (patch) { body.start.date = null; body.end.date = null; }
  }
  return body;
}

// ---------------------------------------------------------------- cliente

export class GCal {
  /**
   * @param {{onChange: () => void, onStatus: (state: string, detail?: string) => void}} cb
   */
  constructor({ onChange, onStatus }) {
    this.onChange = onChange;
    this.onStatus = onStatus;
    const s = readJson(KEY) || {};
    this.clientId = typeof s.clientId === 'string' ? s.clientId : '';
    this.token = typeof s.token === 'string' ? s.token : '';
    this.expiresAt = Number(s.expiresAt) || 0;
    this.connected = !!s.connected && !!this.clientId;
    this.wantDrive = !!s.wantDrive; // el usuario activó los apuntes en Drive
    this.driveOk = !!s.driveOk;     // y Google concedió el permiso
    this.state = this.connected ? (this.#tokenOk() ? 'ok' : 'reauth') : 'off';
    this.weeks = new Map(); // lunes (AAAA-MM-DD) → { at, events: Map id → evento }
    this.lastDetail = '';
    this.gen = 0; // sube al desconectar: los resultados de peticiones antiguas se descartan
    this.rev = 0; // sube con cada cambio propio: una carga anterior no lo pisa
    this.#loadCache();
  }

  /** off: sin Client ID · idle: con Client ID pero sin conectar · ok · reauth · offline · error */
  get status() {
    if (!this.clientId) return 'off';
    if (!this.connected) return 'idle';
    return this.state;
  }

  #tokenOk() { return !!this.token && Date.now() < this.expiresAt - 60_000; }

  #save() {
    writeJson(KEY, {
      clientId: this.clientId, token: this.token, expiresAt: this.expiresAt, connected: this.connected,
      wantDrive: this.wantDrive, driveOk: this.driveOk,
    });
  }

  #setState(state, detail = '') {
    if (this.state === state && this.lastDetail === detail) return;
    this.state = state;
    this.lastDetail = detail;
    this.onStatus(this.status, detail);
  }

  // ---------- conexión

  /** Guarda el Client ID (el de tu proyecto de Google Cloud). Devuelve false si no es válido. */
  setClientId(id) {
    id = String(id || '').trim();
    if (!CLIENT_ID_RE.test(id)) return false;
    if (id !== this.clientId) { this.disconnect(); this.clientId = id; this.#save(); }
    return true;
  }

  async #requestToken(prompt) {
    await loadGis();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new GCalError('auth', 'Google no ha respondido. Inténtalo de nuevo.')), 120_000);
      const done = (fn, v) => { clearTimeout(timer); fn(v); };
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: this.wantDrive ? `${SCOPE} ${DRIVE_SCOPE}` : SCOPE,
        callback: (r) => {
          if (r.error) return done(reject, new GCalError('auth', 'No se pudo conectar con Google (' + r.error + ').'));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
            return done(reject, new GCalError('perm', 'Hace falta aceptar el permiso para ver y editar eventos del calendario.'));
          }
          done(resolve, r);
        },
        error_callback: (e) => done(reject, new GCalError('auth',
          e?.type === 'popup_closed' ? 'Cerraste la ventana de Google antes de terminar.'
            : e?.type === 'popup_failed_to_open' ? 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes e inténtalo de nuevo.'
              : 'No se pudo conectar con Google.')),
      });
      client.requestAccessToken({ prompt });
    });
  }

  async #acquire(prompt, gen = this.gen) {
    const r = await this.#requestToken(prompt);
    if (gen !== this.gen) throw new GCalError('auth', 'Se desconectó mientras tanto.');
    this.token = r.access_token;
    this.expiresAt = Date.now() + (Number(r.expires_in) || 3600) * 1000;
    this.driveOk = this.wantDrive && google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE);
    this.#save();
  }

  /** Abre la ventana de Google (hay que llamarlo desde un clic). */
  async connect() {
    if (!this.clientId) throw new GCalError('setup', 'Primero pega el Client ID de Google.');
    await this.#acquire(this.connected ? '' : 'consent', this.gen);
    this.connected = true;
    this.#save();
    this.#setState('ok');
  }

  disconnect() {
    const token = this.token;
    try { if (token && globalThis.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignorar */ }
    this.gen++;
    this.token = '';
    this.expiresAt = 0;
    this.connected = false;
    this.driveOk = false;
    this.weeks.clear();
    try { localStorage.removeItem(CACHE_KEY); } catch { /* ignorar */ }
    this.state = this.clientId ? 'idle' : 'off';
    this.lastDetail = '';
    this.#save();
    this.onStatus(this.status, '');
    this.onChange();
  }

  /** Olvida también el Client ID. */
  forgetClientId() {
    this.disconnect();
    this.clientId = '';
    this.state = 'off';
    this.#save();
    this.onStatus('off', '');
  }

  // ---------- peticiones

  /** `interactive`: viene de una acción del usuario, así que puede abrir la ventana de Google. */
  async #request(url, init = {}, interactive = false, retry = true, quiet = false) {
    if (!this.connected) throw new GCalError('auth', 'Google Calendar no está conectado.');
    if (!this.#tokenOk()) {
      if (!interactive) {
        const err = new GCalError('auth', 'La sesión de Google ha caducado. Pulsa «Reconectar».');
        this.#setState('reauth', err.message);
        throw err;
      }
      const gen = this.gen;
      try { await this.#acquire('', gen); } catch (e) {
        if (e.kind !== 'offline') this.#setState('reauth', 'La sesión de Google ha caducado. Pulsa «Reconectar».');
        else this.#setState('offline', e.message);
        throw e;
      }
    }
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.token}` },
      });
    } catch {
      const err = new GCalError('offline', 'Sin conexión con Google Calendar.');
      this.#setState('offline', err.message);
      throw err;
    }
    if (res.ok) { this.#setState('ok'); return res; }
    if (res.status === 401 && retry) {
      this.token = ''; this.expiresAt = 0; this.#save();
      return this.#request(url, init, interactive, false, quiet);
    }
    const err = await failFrom(res);
    if (err.kind === 'auth') this.#setState('reauth', err.message);
    else if (!quiet && (err.kind === 'setup' || err.kind === 'perm')) this.#setState('error', err.message);
    throw err;
  }

  // ---------- acceso para otros servicios de Google (Drive)

  /** Petición autenticada a otra API de Google. Sus errores de permisos no afectan al estado del calendario. */
  api(url, init = {}, { interactive = false } = {}) {
    return this.#request(url, init, interactive, true, true);
  }

  /** Token válido (para subidas con barra de progreso). */
  async accessToken({ interactive = false } = {}) {
    if (!this.connected) throw new GCalError('auth', 'Google no está conectado.');
    if (!this.#tokenOk()) {
      if (!interactive) throw new GCalError('auth', 'La sesión de Google ha caducado. Pulsa «Reconectar».');
      await this.#acquire('', this.gen);
      this.#setState('ok');
    }
    return this.token;
  }

  /** Pide también el permiso de Drive (abre la ventana de Google: llamar desde un clic). */
  async enableDrive() {
    if (!this.connected) throw new GCalError('auth', 'Primero conecta Google en Ajustes.');
    this.wantDrive = true;
    this.#save();
    try {
      await this.#acquire('consent', this.gen);
    } catch (e) {
      this.wantDrive = false; // no estropear la conexión del calendario si Drive falla
      this.#save();
      throw e;
    }
    this.#setState('ok');
    if (!this.driveOk) throw new GCalError('perm', 'No se concedió el permiso de Google Drive. Vuelve a intentarlo marcando la casilla de Drive.');
  }

  // ---------- lectura

  /** Descarga los eventos de la semana que empieza el lunes `weekKey`. */
  async loadWeek(weekKey) {
    if (!this.connected) return false;
    const gen = this.gen;
    const rev = this.rev;
    const events = new Map();
    const timeMin = dateOfKey(weekKey).toISOString();
    const timeMax = addDays(dateOfKey(weekKey), 7).toISOString();
    try {
      let pageToken = '';
      for (let page = 0; page < 4; page++) {
        const q = new URLSearchParams({
          timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', showDeleted: 'false',
        });
        if (pageToken) q.set('pageToken', pageToken);
        const res = await this.#request(`${API}?${q}`, {}, false);
        const data = await res.json();
        for (const item of data.items || []) {
          const ev = normalize(item);
          if (ev) events.set(ev.id, ev);
        }
        pageToken = data.nextPageToken;
        if (!pageToken) break;
      }
    } catch (e) {
      if (e.kind === 'gone' || e.kind === 'http' || e.kind === 'rate') this.#setState('error', e.message);
      return false;
    }
    // Si mientras tanto se desconectó o se cambió algo, esta copia ya es vieja.
    if (gen !== this.gen || !this.connected || rev !== this.rev) return false;
    this.weeks.set(weekKey, { at: Date.now(), events });
    this.#saveCache();
    this.onChange();
    return true;
  }

  /** Eventos que ocurren el día `dateKey`, todo el día primero y luego por hora. */
  eventsOn(dateKey) {
    const monday = keyOf(addDays(dateOfKey(dateKey), -((dateOfKey(dateKey).getDay() + 6) % 7)));
    const week = this.weeks.get(monday);
    if (!week) return [];
    const d0 = dateOfKey(dateKey);
    const d1 = addDays(d0, 1);
    return [...week.events.values()]
      .filter((e) => e.start < d1 && (e.end > d0 || e.start >= d0))
      .sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start) || a.title.localeCompare(b.title));
  }

  // ---------- escritura

  /** f: { title, schedule: { allDay, startDate, startTime, endDate, endTime } } */
  async create(f) {
    const gen = this.gen;
    // `f.id` lo genera la app una vez por evento: si se reintenta, Google responde «ya existe» en vez de duplicarlo.
    const body = { ...(f.id ? { id: f.id } : {}), ...bodyFrom(f, false) };
    let res;
    try {
      res = await this.#request(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }, true);
    } catch (e) {
      if (e.kind === 'conflict') return; // ya se había creado
      throw e;
    }
    const ev = normalize(await res.json());
    if (gen === this.gen && this.connected) this.#place(ev);
  }

  /** f.title y/o f.schedule: solo se envía lo que ha cambiado. */
  async update(ev, f) {
    const gen = this.gen;
    const res = await this.#request(`${API}/${encodeURIComponent(ev.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyFrom(f, true)),
    }, true).catch((e) => { if (e.kind === 'gone' && gen === this.gen) this.#drop(ev.id); throw e; });
    const updated = normalize(await res.json());
    if (gen === this.gen && this.connected) this.#place(updated);
  }

  async remove(ev) {
    const gen = this.gen;
    try {
      await this.#request(`${API}/${encodeURIComponent(ev.id)}`, { method: 'DELETE' }, true);
    } catch (e) {
      if (e.kind !== 'gone') throw e; // si ya no existía, el resultado es el mismo
    }
    if (gen === this.gen && this.connected) this.#drop(ev.id);
  }

  #drop(id) {
    this.rev++;
    for (const w of this.weeks.values()) w.events.delete(id);
    this.#saveCache();
    this.onChange();
  }

  /** Pone el evento (sin duplicarlo) en todas las semanas guardadas que toca. */
  #place(ev) {
    if (!ev) return;
    this.rev++;
    for (const [monday, w] of this.weeks) {
      w.events.delete(ev.id);
      const m0 = dateOfKey(monday);
      if (ev.start < addDays(m0, 7) && (ev.end > m0 || ev.start >= m0)) w.events.set(ev.id, ev);
    }
    this.#saveCache();
    this.onChange();
  }

  // ---------- caché local

  #loadCache() {
    const raw = readJson(CACHE_KEY);
    if (!raw || !this.connected) return;
    for (const [week, w] of Object.entries(raw)) {
      if (!Array.isArray(w?.items)) continue;
      const events = new Map();
      for (const item of w.items) { const ev = normalize(item); if (ev) events.set(ev.id, ev); }
      this.weeks.set(week, { at: Number(w.at) || 0, events });
    }
  }

  #saveCache() {
    const keep = [...this.weeks.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHED_WEEKS);
    writeJson(CACHE_KEY, Object.fromEntries(keep.map(([k, w]) => [k, { at: w.at, items: [...w.events.values()].map((e) => e.raw) }])));
  }
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin espacio */ }
}
