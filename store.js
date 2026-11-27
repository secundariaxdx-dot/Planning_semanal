// Modelo de datos y fusión (merge) para la sincronización.
//
// Estructura:
// {
//   version: 3,
//   weeks: {
//     "2026-11-09": {                       // clave = lunes de la semana
//       tasks: { [id]: { id, text, done, day (0-6), order, updatedAt, pending?, deleted? } },
//       goals: { [id]: { id, text, done, order, updatedAt, started?, pending?, deleted? } },
//       notes: { text, html?, updatedAt }   // html = nota con formato (limpiada al mostrarla); text = texto plano
//     }
//   },
//   rules: {                                // tareas que se repiten cada semana
//     [id]: { id, text, days: [0-6…], from, until, order, updatedAt, deleted? }
//   },
//   subjects: {                             // asignaturas del modo examen
//     [id]: { id, name, color, examId, order, updatedAt, deleted? }
//   },
//   topics: {                               // temas de cada asignatura; status 0 pendiente · 1 estudiado · 2 repasado
//     [id]: { id, subjectId, text, status, order, updatedAt, deleted? }
//   },
//   exams: {                                // exámenes finales (no dependen de la semana)
//     [id]: { id, text, date: "AAAA-MM-DD", updatedAt, deleted? }
//   }
// }
//
// Cada elemento lleva su propia marca de tiempo; al fusionar dos copias
// gana la versión más reciente de cada elemento. Los borrados se guardan
// como "deleted: true" para que no reaparezcan al sincronizar.
//
// Tareas repetidas: una regla genera una tarea "virtual" por cada día elegido
// en todas las semanas entre `from` (incluida) y `until` (excluida). La tarea
// solo se guarda de verdad en la semana (con id "r:<regla>:<día>") cuando el
// usuario la toca: marcarla, moverla o quitarla esa semana.

const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;
const PRUNE_AFTER_MS = 60 * 24 * 60 * 60 * 1000; // 60 días

export const emptyState = () => ({ version: 5, weeks: {}, rules: {}, exams: {}, subjects: {}, topics: {} });
export const emptyWeek = () => ({ tasks: {}, goals: {}, notes: { text: '', updatedAt: 0 } });

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

export function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;

  if (raw.weeks && typeof raw.weeks === 'object') {
    for (const [key, w] of Object.entries(raw.weeks)) {
      if (!WEEK_KEY.test(key) || !w || typeof w !== 'object') continue;
      const week = emptyWeek();
      for (const kind of ['tasks', 'goals']) {
        const src = w[kind] && typeof w[kind] === 'object' ? w[kind] : {};
        for (const [id, it] of Object.entries(src)) {
          if (!it || typeof it !== 'object') continue;
          const item = {
            id,
            text: String(it.text ?? ''),
            done: !!it.done,
            order: num(it.order),
            updatedAt: num(it.updatedAt),
          };
          if (kind === 'tasks') item.day = Math.min(6, Math.max(0, Math.trunc(Number(it.day) || 0)));
          if (kind === 'goals' && it.started) item.started = true;
          if (it.pending) item.pending = true;
          if (it.deleted) item.deleted = true;
          week[kind][id] = item;
        }
      }
      if (w.notes && typeof w.notes === 'object') {
        week.notes = { text: String(w.notes.text ?? ''), updatedAt: num(w.notes.updatedAt) };
        if (typeof w.notes.html === 'string' && w.notes.html) week.notes.html = w.notes.html;
      }
      state.weeks[key] = week;
    }
  }

  if (raw.rules && typeof raw.rules === 'object') {
    for (const [id, r] of Object.entries(raw.rules)) {
      if (!r || typeof r !== 'object' || !WEEK_KEY.test(r.from)) continue;
      const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number))]
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        .sort((a, b) => a - b);
      const rule = {
        id,
        text: String(r.text ?? ''),
        days,
        from: r.from,
        until: WEEK_KEY.test(r.until) ? r.until : null,
        order: num(r.order),
        updatedAt: num(r.updatedAt),
      };
      if (r.deleted) rule.deleted = true;
      state.rules[id] = rule;
    }
  }

  if (raw.exams && typeof raw.exams === 'object') {
    for (const [id, x] of Object.entries(raw.exams)) {
      if (!x || typeof x !== 'object' || !WEEK_KEY.test(x.date)) continue;
      const exam = { id, text: String(x.text ?? ''), date: x.date, updatedAt: num(x.updatedAt) };
      if (x.deleted) exam.deleted = true;
      state.exams[id] = exam;
    }
  }
  if (raw.subjects && typeof raw.subjects === 'object') {
    for (const [id, x] of Object.entries(raw.subjects)) {
      if (!x || typeof x !== 'object') continue;
      const subject = {
        id,
        name: String(x.name ?? ''),
        color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#2f6fdf',
        examId: typeof x.examId === 'string' && x.examId ? x.examId : null,
        order: num(x.order),
        updatedAt: num(x.updatedAt),
      };
      if (x.deleted) subject.deleted = true;
      state.subjects[id] = subject;
    }
  }

  if (raw.topics && typeof raw.topics === 'object') {
    for (const [id, x] of Object.entries(raw.topics)) {
      if (!x || typeof x !== 'object' || typeof x.subjectId !== 'string') continue;
      const topic = {
        id,
        subjectId: x.subjectId,
        text: String(x.text ?? ''),
        status: Math.min(2, Math.max(0, Math.trunc(Number(x.status) || 0))),
        order: num(x.order),
        updatedAt: num(x.updatedAt),
      };
      if (x.deleted) topic.deleted = true;
      state.topics[id] = topic;
    }
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
  const flags = { localChanged: false, remoteChanged: false };

  const mergeMap = (a, b, out) => {
    const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const id of ids) {
      const x = a[id];
      const y = b[id];
      if (x && (!y || x.updatedAt >= y.updatedAt)) {
        out[id] = x;
        if (!y || x.updatedAt > y.updatedAt) flags.remoteChanged = true;
      } else {
        out[id] = y;
        flags.localChanged = true;
      }
    }
  };

  const keys = new Set([...Object.keys(local.weeks), ...Object.keys(remote.weeks)]);
  for (const key of keys) {
    const a = local.weeks[key] || emptyWeek();
    const b = remote.weeks[key] || emptyWeek();
    const out = emptyWeek();
    mergeMap(a.tasks, b.tasks, out.tasks);
    mergeMap(a.goals, b.goals, out.goals);
    if (a.notes.updatedAt >= b.notes.updatedAt) {
      out.notes = a.notes;
      if (a.notes.updatedAt > b.notes.updatedAt) flags.remoteChanged = true;
    } else {
      out.notes = b.notes;
      flags.localChanged = true;
    }
    merged.weeks[key] = out;
  }

  mergeMap(local.rules, remote.rules, merged.rules);
  mergeMap(local.exams, remote.exams, merged.exams);
  mergeMap(local.subjects, remote.subjects, merged.subjects);
  mergeMap(local.topics, remote.topics, merged.topics);
  return { merged, ...flags };
}

/**
 * Limpieza: quita las marcas de borrado de hace más de 60 días y las semanas
 * que se quedan vacías. Así el archivo no crece sin límite.
 * (Las marcas de tareas repetidas se conservan: sin ellas, la tarea
 * reaparecería en esa semana.)
 */
export function prune(state, now = Date.now()) {
  const cutoff = now - PRUNE_AFTER_MS;
  for (const [key, w] of Object.entries(state.weeks)) {
    for (const kind of ['tasks', 'goals']) {
      for (const [id, it] of Object.entries(w[kind])) {
        if (it.deleted && it.updatedAt < cutoff && !parseOcc(id)) delete w[kind][id];
      }
    }
    const empty = !Object.keys(w.tasks).length && !Object.keys(w.goals).length
      && w.notes.text === '' && w.notes.updatedAt < cutoff;
    if (empty) delete state.weeks[key];
  }
  for (const kind of ['exams', 'subjects', 'topics']) {
    for (const [id, x] of Object.entries(state[kind])) {
      if (x.deleted && x.updatedAt < cutoff) delete state[kind][id];
    }
  }
  return state;
}

// ---------------------------------------------------------------- tareas repetidas

export const occId = (ruleId, slot) => `r:${ruleId}:${slot}`;

export function parseOcc(id) {
  const m = /^r:(.+):([0-6])$/.exec(id);
  return m ? { ruleId: m[1], slot: Number(m[2]) } : null;
}

/** ¿La regla está activa en la semana `key`? */
export function ruleCovers(rule, key) {
  return !!rule && !rule.deleted && rule.from <= key && (!rule.until || key < rule.until);
}

/**
 * Tareas que se ven en una semana: las normales más las repetidas.
 * Las repetidas llevan { ruleId, slot, repeats } y, si aún no se han
 * guardado en la semana, { virtual: true }.
 */
export function weekTasks(state, key) {
  const stored = state.weeks[key] ? state.weeks[key].tasks : {};
  const out = [];

  for (const t of Object.values(stored)) {
    if (t.deleted) continue;
    const occ = parseOcc(t.id);
    if (!occ) { out.push(t); continue; }
    const rule = state.rules[occ.ruleId];
    const repeats = ruleCovers(rule, key) && rule.days.includes(occ.slot);
    // Si la regla ya no aplica, la tarea solo se conserva si se llegó a hacer.
    if (repeats || t.done) {
      out.push({ ...t, text: repeats ? rule.text : t.text, ruleId: occ.ruleId, slot: occ.slot, repeats });
    }
  }

  for (const rule of Object.values(state.rules)) {
    if (!ruleCovers(rule, key)) continue;
    for (const slot of rule.days) {
      const id = occId(rule.id, slot);
      if (stored[id]) continue;
      out.push({
        id, text: rule.text, done: false, day: slot, order: rule.order, updatedAt: 0,
        ruleId: rule.id, slot, repeats: true, virtual: true,
      });
    }
  }

  return out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/** Marca de tiempo estrictamente creciente respecto a la anterior. */
export const stamp = (prev = 0) => Math.max(Date.now(), prev + 1);

export const uid = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
