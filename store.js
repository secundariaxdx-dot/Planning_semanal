// Modelo de datos y fusión (merge) para la sincronización.
//
// Estructura:
// {
//   version: 2,
//   weeks: {
//     "2026-11-09": {                       // clave = lunes de la semana
//       tasks: { [id]: { id, text, done, day (0-6), order, updatedAt, deleted? } },
//       goals: { [id]: { id, text, done, order, updatedAt, deleted? } },
//       notes: { text, updatedAt }
//     }
//   }
// }
//
// Cada elemento lleva su propia marca de tiempo; al fusionar dos copias
// gana la versión más reciente de cada elemento. Los borrados se guardan
// como "deleted: true" para que no reaparezcan al sincronizar.

export const emptyState = () => ({ version: 2, weeks: {} });
export const emptyWeek = () => ({ tasks: {}, goals: {}, notes: { text: '', updatedAt: 0 } });

export function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || !raw.weeks || typeof raw.weeks !== 'object') return state;
  for (const [key, w] of Object.entries(raw.weeks)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !w || typeof w !== 'object') continue;
    const week = emptyWeek();
    for (const kind of ['tasks', 'goals']) {
      const src = w[kind] && typeof w[kind] === 'object' ? w[kind] : {};
      for (const [id, it] of Object.entries(src)) {
        if (!it || typeof it !== 'object') continue;
        const item = {
          id,
          text: String(it.text ?? ''),
          done: !!it.done,
          order: Number.isFinite(it.order) ? it.order : 0,
          updatedAt: Number.isFinite(it.updatedAt) ? it.updatedAt : 0,
        };
        if (kind === 'tasks') item.day = Math.min(6, Math.max(0, Math.trunc(Number(it.day) || 0)));
        if (it.deleted) item.deleted = true;
        week[kind][id] = item;
      }
    }
    if (w.notes && typeof w.notes === 'object') {
      week.notes = {
        text: String(w.notes.text ?? ''),
        updatedAt: Number.isFinite(w.notes.updatedAt) ? w.notes.updatedAt : 0,
      };
    }
    state.weeks[key] = week;
  }
  return state;
}

/**
 * Fusiona `local` y `remote`.
 * Devuelve { merged, localChanged, remoteChanged }:
 *  - localChanged: el resultado contiene algo más nuevo que lo que había en local
 *  - remoteChanged: el resultado contiene algo más nuevo que lo que había en remoto
 */
export function merge(local, remote) {
  const merged = emptyState();
  let localChanged = false;
  let remoteChanged = false;
  const keys = new Set([...Object.keys(local.weeks), ...Object.keys(remote.weeks)]);

  for (const key of keys) {
    const a = local.weeks[key] || emptyWeek();
    const b = remote.weeks[key] || emptyWeek();
    const out = emptyWeek();

    for (const kind of ['tasks', 'goals']) {
      const ids = new Set([...Object.keys(a[kind]), ...Object.keys(b[kind])]);
      for (const id of ids) {
        const x = a[kind][id];
        const y = b[kind][id];
        if (x && (!y || x.updatedAt >= y.updatedAt)) {
          out[kind][id] = x;
          if (!y || x.updatedAt > y.updatedAt) remoteChanged = true;
        } else {
          out[kind][id] = y;
          localChanged = true;
        }
      }
    }

    if (a.notes.updatedAt >= b.notes.updatedAt) {
      out.notes = a.notes;
      if (a.notes.updatedAt > b.notes.updatedAt) remoteChanged = true;
    } else {
      out.notes = b.notes;
      localChanged = true;
    }

    merged.weeks[key] = out;
  }

  return { merged, localChanged, remoteChanged };
}

/** Marca de tiempo estrictamente creciente respecto a la anterior. */
export const stamp = (prev = 0) => Math.max(Date.now(), prev + 1);

export const uid = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
