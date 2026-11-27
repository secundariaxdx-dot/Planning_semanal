// Apuntes en Google Drive.
//
// Los archivos se suben a TU Google Drive, en la carpeta «Planning semanal · Apuntes»,
// con una subcarpeta por asignatura. Así están en todos tus dispositivos y también se
// pueden abrir desde Drive. El permiso que se pide (drive.file) solo deja a la app ver
// los archivos que ella misma ha creado, no el resto de tu Drive.
//
// Drive es la fuente de verdad: aquí solo se guarda una lista en caché para verla sin
// conexión. Borrar un apunte lo manda a la papelera de Drive (se puede recuperar 30 días).

import { GCalError } from './gcal.js';

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'Planning semanal · Apuntes';
const FIELDS = 'id,name,mimeType,size,webViewLink,modifiedTime,parents,appProperties';
const CACHE_KEY = 'planning-semanal:drive-files';

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Errores de Drive con mensajes propios (los genéricos hablan del calendario). */
function driveError(e) {
  if (!(e instanceof GCalError)) return new GCalError('http', 'No se pudo completar la operación en Google Drive.');
  if (e.kind === 'setup') return new GCalError('setup', 'La API de Google Drive no está activada en tu proyecto de Google Cloud (mira Ajustes → Google).', e.status);
  if (e.kind === 'perm' || e.kind === 'denied') return new GCalError('perm', 'Falta el permiso de Google Drive. Pulsa «Activar apuntes en Drive» y marca la casilla de Drive.', e.status);
  if (e.kind === 'gone') return new GCalError('gone', 'Ese archivo ya no está en Drive.', e.status);
  if (e.kind === 'offline') return new GCalError('offline', 'Sin conexión con Google Drive.');
  if (e.kind === 'http') return new GCalError('http', `Google Drive respondió con un error (${e.status}).`, e.status);
  return e;
}

export class GDrive {
  constructor(gcal, { onChange }) {
    this.gcal = gcal;
    this.onChange = onChange;
    this.files = new Map(); // subjectId → [archivo]
    this.uploads = [];      // { id, subjectId, name, pct, error? }
    this.loadedAt = 0;
    this.lastError = '';
    this.folders = new Map(); // 'root' | subjectId → id de carpeta
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) this.files.set(k, v);
    } catch { /* sin caché */ }
  }

  /** off: Google sin conectar · ask: falta activar Drive · on */
  get status() {
    if (!this.gcal.connected) return 'off';
    if (!this.gcal.wantDrive || !this.gcal.driveOk) return 'ask';
    return 'on';
  }

  filesOf(subjectId) { return this.files.get(subjectId) || []; }

  #saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(this.files))); } catch { /* sin espacio */ }
  }

  async #api(url, init = {}, interactive = false) {
    try { return await this.gcal.api(url, init, { interactive }); } catch (e) { throw driveError(e); }
  }

  /** Activa Drive (pide el permiso: llamar desde un clic). */
  async enable() {
    await this.gcal.enableDrive();
    await this.load(true);
  }

  forget() {
    this.files.clear();
    this.folders.clear();
    try { localStorage.removeItem(CACHE_KEY); } catch { /* ignorar */ }
  }

  // ---------- lectura

  /** Descarga la lista de apuntes (de todas las asignaturas, en una sola petición). */
  async load(interactive = false) {
    if (this.status !== 'on') return false;
    const gen = this.gcal.gen;
    const found = new Map();
    try {
      let pageToken = '';
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({
          q: "appProperties has { key='planningKind' and value='apunte' } and trashed=false",
          fields: `nextPageToken,files(${FIELDS})`,
          pageSize: '1000',
          orderBy: 'name_natural',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const data = await (await this.#api(`${FILES}?${params}`, {}, interactive)).json();
        for (const f of data.files || []) {
          const sid = f.appProperties?.subjectId;
          if (!sid) continue;
          if (!found.has(sid)) found.set(sid, []);
          found.get(sid).push(slim(f));
        }
        pageToken = data.nextPageToken;
        if (!pageToken) break;
      }
    } catch (e) {
      this.lastError = e.message;
      this.onChange();
      return false;
    }
    if (gen !== this.gcal.gen) return false; // se desconectó mientras tanto
    this.files = found;
    this.loadedAt = Date.now();
    this.lastError = '';
    this.#saveCache();
    this.onChange();
    return true;
  }

  // ---------- carpetas

  async #findFolder(props) {
    const cond = Object.entries(props).map(([k, v]) => `appProperties has { key='${k}' and value='${q(v)}' }`).join(' and ');
    const params = new URLSearchParams({ q: `${cond} and mimeType='${FOLDER}' and trashed=false`, fields: 'files(id,name)', pageSize: '5' });
    const data = await (await this.#api(`${FILES}?${params}`, {}, true)).json();
    return data.files?.[0] || null;
  }

  async #createFolder(name, parent, props) {
    const res = await this.#api(`${FILES}?fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}), appProperties: props }),
    }, true);
    return res.json();
  }

  async #rootFolder() {
    if (this.folders.has('root')) return this.folders.get('root');
    const props = { planningKind: 'root' };
    const f = (await this.#findFolder(props)) || (await this.#createFolder(ROOT_NAME, null, props));
    this.folders.set('root', f.id);
    return f.id;
  }

  async #subjectFolder(subject) {
    const name = subject.name.trim() || 'Asignatura';
    let id = this.folders.get(subject.id);
    if (!id) {
      const props = { planningKind: 'subject', subjectId: subject.id };
      const f = await this.#findFolder(props);
      if (f) {
        id = f.id;
        if (f.name !== name) { // la asignatura cambió de nombre: la carpeta también
          await this.#api(`${FILES}/${f.id}?fields=id`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
          }, true).catch(() => {});
        }
      } else {
        id = (await this.#createFolder(name, await this.#rootFolder(), props)).id;
      }
      this.folders.set(subject.id, id);
    }
    return id;
  }

  // ---------- escritura

  /** Sube varios archivos a la carpeta de la asignatura, uno tras otro. */
  async uploadMany(fileList, subject) {
    const items = [...fileList].map((file) => ({ id: Math.random().toString(36).slice(2), subjectId: subject.id, name: file.name, pct: 0, file }));
    this.uploads.push(...items);
    this.onChange();
    let ok = 0;
    let lastError = null;
    for (const item of items) {
      try {
        const f = await this.#upload(item, subject);
        if (!this.files.has(subject.id)) this.files.set(subject.id, []);
        const list = this.files.get(subject.id).filter((x) => x.id !== f.id);
        list.push(f);
        list.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
        this.files.set(subject.id, list);
        this.#saveCache();
        ok++;
      } catch (e) {
        lastError = driveError(e);
      }
      this.uploads = this.uploads.filter((u) => u !== item);
      this.onChange();
    }
    if (lastError) throw Object.assign(lastError, { uploaded: ok, total: items.length });
    return ok;
  }

  async #upload(item, subject) {
    const { file } = item;
    const parent = await this.#subjectFolder(subject);
    const meta = { name: file.name, parents: [parent], appProperties: { planningKind: 'apunte', subjectId: subject.id } };
    const type = file.type || 'application/octet-stream';

    // Subida reanudable: sirve para archivos grandes y permite ver el progreso.
    const start = await this.#api(`${UPLOAD}?uploadType=resumable&fields=${FIELDS}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': type,
        'X-Upload-Content-Length': String(file.size),
      },
      body: JSON.stringify(meta),
    }, true);
    const location = start.headers.get('Location');
    if (!location) throw new GCalError('http', 'Google Drive no devolvió la dirección de subida.');
    const token = await this.gcal.accessToken({ interactive: true });

    const created = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', location);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', type);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        item.pct = Math.round((e.loaded / e.total) * 100);
        document.querySelectorAll(`[data-upload="${item.id}"] .up-bar > span`).forEach((n) => { n.style.width = `${item.pct}%`; });
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new GCalError('http', 'Respuesta extraña de Google Drive.')); }
        } else if (xhr.status === 401) reject(new GCalError('auth', 'La sesión de Google ha caducado. Pulsa «Reconectar» y vuelve a subirlo.', 401));
        else if (xhr.status === 403) reject(new GCalError('perm', 'Google Drive rechazó la subida (permiso o espacio insuficiente).', 403));
        else reject(new GCalError('http', `Google Drive respondió con un error (${xhr.status}).`, xhr.status));
      };
      xhr.onerror = () => reject(new GCalError('offline', 'Se cortó la conexión durante la subida.'));
      xhr.send(file);
    });
    return slim(created);
  }

  /** Manda el archivo a la papelera de Drive (recuperable durante 30 días). */
  async trash(file, subjectId) {
    try {
      await this.#api(`${FILES}/${file.id}?fields=id`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
      }, true);
    } catch (e) {
      if (e.kind !== 'gone') throw e;
    }
    this.files.set(subjectId, this.filesOf(subjectId).filter((f) => f.id !== file.id));
    this.#saveCache();
    this.onChange();
  }
}

function slim(f) {
  return {
    id: f.id,
    name: f.name || 'Sin nombre',
    mimeType: f.mimeType || '',
    size: Number(f.size) || 0,
    link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
    folder: f.parents?.[0] || '',
    modified: f.modifiedTime || '',
  };
}
