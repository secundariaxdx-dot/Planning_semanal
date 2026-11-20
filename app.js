import { emptyWeek, normalizeState, occId, parseOcc, prune, stamp, uid, weekTasks } from './store.js';
import { GistSync } from './sync.js';
import { GCal } from './gcal.js';

const STORAGE_KEY = 'planning-semanal:data';
const THEME_KEY = 'planning-semanal:theme';
const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const DAY_SHORT = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- estado

let state = prune(load());

function load() {
  try { return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY))); }
  catch { return normalizeState(null); }
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* sin espacio */ }
}

// ---------------------------------------------------------------- fechas

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOfKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const mondayOf = (date) => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return addDays(d, -((d.getDay() + 6) % 7));
};
const shiftWeek = (key, n) => keyOf(addDays(dateOfKey(key), 7 * n));
const fmtDay = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
const fmtMonth = new Intl.DateTimeFormat('es-ES', { month: 'short' });
const fmtTime = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

/** «9 – 15 nov», «30 nov – 6 dic»; el año solo si no es el actual. */
function weekRangeLabel(monday) {
  const sunday = addDays(monday, 6);
  const [y1, y2] = [monday.getFullYear(), sunday.getFullYear()];
  const [m1, m2] = [fmtMonth.format(monday), fmtMonth.format(sunday)];
  const [d1, d2] = [monday.getDate(), sunday.getDate()];
  if (y1 !== y2) return `${d1} ${m1} ${y1} – ${d2} ${m2} ${y2}`;
  const year = y1 === new Date().getFullYear() ? '' : ` ${y1}`;
  return m1 === m2 ? `${d1} – ${d2} ${m1}${year}` : `${d1} ${m1} – ${d2} ${m2}${year}`;
}

const thisWeekKey = () => keyOf(mondayOf(new Date()));
let currentKey = thisWeekKey();

// ---------------------------------------------------------------- mutaciones

function week(key = currentKey) {
  return state.weeks[key] || (state.weeks[key] = emptyWeek());
}
const live = (map) => Object.values(map).filter((it) => !it.deleted).sort((a, b) => a.order - b.order);
const goalsOf = (key) => live((state.weeks[key] || emptyWeek()).goals);
const dayTasks = (key, day) => weekTasks(state, key).filter((t) => t.day === day);
const findTask = (id, key = currentKey) => weekTasks(state, key).find((t) => t.id === id) || null;

function commit() {
  persist();
  render();
  sync.schedule();
}

/** Tarea guardada; si es una repetida que aún no se había tocado, la guarda ahora. */
function storedTask(id, key = currentKey) {
  const w = week(key);
  if (w.tasks[id]) return w.tasks[id];
  const occ = parseOcc(id);
  const rule = occ && state.rules[occ.ruleId];
  if (!rule) return null;
  return (w.tasks[id] = { id, text: rule.text, done: false, day: occ.slot, order: rule.order, updatedAt: 0 });
}

function addTask(day, text, key = currentKey, extra = {}) {
  const last = dayTasks(key, day).at(-1);
  const id = uid();
  week(key).tasks[id] = { id, text, done: false, day, order: last ? last.order + 1 : 0, updatedAt: stamp(), ...extra };
}

function addGoal(text, key = currentKey, extra = {}) {
  const last = goalsOf(key).at(-1);
  const id = uid();
  week(key).goals[id] = { id, text, done: false, order: last ? last.order + 1 : 0, updatedAt: stamp(), ...extra };
}

function updateItem(kind, id, patch, key = currentKey) {
  const it = kind === 'tasks' ? storedTask(id, key) : week(key).goals[id];
  if (!it) return;
  Object.assign(it, patch, { updatedAt: stamp(it.updatedAt) });
}

function removeItem(kind, id, key = currentKey) {
  updateItem(kind, id, { deleted: true, text: '' }, key);
}

/** Mueve una tarea a otro día, opcionalmente antes de otra tarea. */
function moveTask(id, day, beforeId = null) {
  const list = dayTasks(currentKey, day).filter((t) => t.id !== id);
  let order;
  const idx = beforeId ? list.findIndex((t) => t.id === beforeId) : -1;
  if (idx === -1) order = list.length ? list.at(-1).order + 1 : 0;
  else if (idx === 0) order = list[0].order - 1;
  else order = (list[idx - 1].order + list[idx].order) / 2;
  updateItem('tasks', id, { day, order });
}

// ---------- pendientes → semana siguiente

/** Lo que queda sin hacer en una semana (las tareas repetidas no cuentan: vuelven solas). */
function pendingOf(key) {
  return {
    tasks: weekTasks(state, key).filter((t) => !t.done && !t.ruleId),
    goals: goalsOf(key).filter((g) => !g.done),
  };
}

function carryTask(t, from, to) {
  addTask(t.day, t.text, to, { pending: true });
  removeItem('tasks', t.id, from);
}

function carryOver() {
  const from = currentKey;
  const to = shiftWeek(from, 1);
  const { tasks, goals } = pendingOf(from);
  const n = tasks.length + goals.length;
  if (!n) return;
  undoable(`${plural(n, 'pendiente pasado', 'pendientes pasados')} a la semana siguiente.`, [from, to], () => {
    for (const t of tasks) carryTask(t, from, to);
    for (const g of goals) {
      addGoal(g.text, to, { pending: true, ...(g.started ? { started: true } : {}) });
      removeItem('goals', g.id, from);
    }
  });
}

// ---------- tareas repetidas

/** Convierte una tarea normal en una que se repite cada semana en `days`. */
function convertToRule(id, days) {
  const w = week();
  const t = w.tasks[id];
  if (!t) return;
  const rule = { id: uid(), text: t.text, days, from: currentKey, until: null, order: Date.now(), updatedAt: stamp() };
  state.rules[rule.id] = rule;
  if (days.includes(t.day)) {
    const oid = occId(rule.id, t.day);
    w.tasks[oid] = { id: oid, text: t.text, done: t.done, day: t.day, order: t.order, updatedAt: stamp() };
  }
  removeItem('tasks', id);
}

/** Cambia los días de una tarea repetida, a partir de la semana que se está viendo. */
function changeRuleDays(rule, days, item) {
  const K = currentKey;
  if (!days.length) {
    // Deja de repetirse; la de esta semana se queda como tarea normal.
    const id = uid();
    week(K).tasks[id] = { id, text: rule.text, done: item.done, day: item.day, order: item.order, updatedAt: stamp() };
    removeItem('tasks', item.id);
    if (rule.from >= K) rule.deleted = true; else rule.until = K;
  } else if (rule.from >= K) {
    rule.days = days; // empezó esta semana: no hay historial que proteger
  } else {
    // Las semanas anteriores conservan los días de antes: la regla vieja acaba
    // aquí y una nueva toma el relevo.
    const next = {
      id: uid(), text: rule.text, days, from: K, until: rule.until, order: rule.order, updatedAt: stamp(),
    };
    state.rules[next.id] = next;
    rule.until = K;
    for (const [key, w] of Object.entries(state.weeks)) {
      if (key < K) continue;
      for (const slot of days) {
        const t = w.tasks[occId(rule.id, slot)];
        if (!t) continue;
        const nid = occId(next.id, slot);
        w.tasks[nid] = { ...t, id: nid, updatedAt: stamp() };
        if (!t.deleted) removeItem('tasks', t.id, key);
      }
    }
  }
  rule.updatedAt = stamp(rule.updatedAt);
}

// ---------- deshacer

const clone = (v) => JSON.parse(JSON.stringify(v));
const sameItem = (a, b) => {
  const strip = ({ updatedAt, ...rest }) => JSON.stringify(Object.entries(rest).sort());
  return strip(a) === strip(b);
};

function snapshot(keys) {
  return {
    weeks: Object.fromEntries(keys.map((k) => [k, state.weeks[k] ? clone(state.weeks[k]) : null])),
    rules: clone(state.rules),
  };
}

/** Devuelve las semanas y reglas de la foto a como estaban (con marcas de tiempo nuevas, para que sincronice). */
function restore(snap) {
  for (const [id, cur] of Object.entries(state.rules)) {
    const old = snap.rules[id];
    if (old) { if (!sameItem(old, cur)) state.rules[id] = { ...old, updatedAt: stamp(cur.updatedAt) }; }
    else if (!cur.deleted) state.rules[id] = { ...cur, deleted: true, updatedAt: stamp(cur.updatedAt) };
  }
  for (const [key, prev] of Object.entries(snap.weeks)) {
    const w = state.weeks[key];
    if (!w) continue;
    for (const kind of ['tasks', 'goals']) {
      for (const [id, cur] of Object.entries(w[kind])) {
        const old = prev && prev[kind][id];
        const at = stamp(cur.updatedAt);
        const occ = kind === 'tasks' ? parseOcc(id) : null;
        if (old) {
          if (!sameItem(old, cur)) w[kind][id] = { ...old, updatedAt: at };
        } else if (occ && snap.rules[occ.ruleId]) {
          // Era una repetida sin tocar: vuelve a su estado inicial.
          const rule = snap.rules[occ.ruleId];
          w[kind][id] = { id, text: rule.text, done: false, day: occ.slot, order: rule.order, updatedAt: at };
        } else if (!cur.deleted) {
          w[kind][id] = { ...cur, deleted: true, updatedAt: at };
        }
      }
    }
  }
}

/** Hace un cambio y muestra un aviso con «Deshacer». */
function undoable(message, keys, fn) {
  const snap = snapshot(keys);
  fn();
  commit();
  toast(message, { action: 'Deshacer', duration: 7000, onAction: () => { restore(snap); commit(); } });
}

// ---------------------------------------------------------------- aviso (toast)

const toastEl = $('#toast');
let toastTimer = null;
let toastHasAction = false;

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.hidden = true;
  toastHasAction = false;
}

/** `low`: aviso informativo que no debe tapar uno con botón (p. ej. «Deshacer»). */
function toast(message, { action = '', onAction = null, duration = 4000, low = false } = {}) {
  if (low && toastHasAction && !toastEl.hidden) return;
  clearTimeout(toastTimer);
  $('#toastMsg').textContent = message;
  const btn = $('#toastAction');
  btn.hidden = !action;
  btn.textContent = action;
  btn.onclick = () => { hideToast(); onAction?.(); };
  toastHasAction = !!action;
  toastEl.hidden = true;
  void toastEl.offsetWidth; // reinicia la animación
  toastEl.hidden = false;
  toastTimer = setTimeout(hideToast, duration);
}

// ---------------------------------------------------------------- render

let pendingRender = false;
let focusAfterRender = null;
let addingDay = null; // día con la caja «Añadir tarea» abierta (móvil)

/** Evita redibujar mientras el usuario escribe o tiene un diálogo abierto. */
function isUserBusy() {
  if (document.querySelector('dialog[open]')) return true;
  const a = document.activeElement;
  return !!(a && a.matches('input, textarea') && a.value !== '');
}

function requestRender() {
  if (isUserBusy()) { pendingRender = true; return; }
  const a = document.activeElement;
  if (a && a.id && a.matches('input')) focusAfterRender = a.id;
  render();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (pendingRender && !isUserBusy()) render();
}, 0));

function render() {
  pendingRender = false;
  const w = state.weeks[currentKey] || emptyWeek();
  const monday = dateOfKey(currentKey);
  const todayKey = keyOf(new Date());
  const isThisWeek = currentKey === thisWeekKey();
  const tasks = weekTasks(state, currentKey);
  const goals = live(w.goals);

  $('#page').style.setProperty('--goals', goals.length);

  // Cabecera
  $('#weekLabel').textContent = weekRangeLabel(monday);
  $('#thisWeekTag').hidden = !isThisWeek;
  $('#todayBtn').disabled = isThisWeek;
  renderProgress(tasks, goals);

  // Objetivos
  $('#goalCount').textContent = goals.length ? `${goals.filter((g) => g.done).length}/${goals.length}` : '';
  $('#goalList').replaceChildren(
    ...(goals.length ? goals.map((g) => itemRow('goals', g)) : [el('li', { class: 'empty' }, 'Sin objetivos todavía.')]),
  );

  // Notas (no pisar lo que se está escribiendo)
  const notes = $('#notes');
  if (document.activeElement !== notes) notes.value = w.notes.text;
  $('#notesState').textContent = '';

  // Pasar pendientes
  const pending = pendingOf(currentKey);
  const nPending = pending.tasks.length + pending.goals.length;
  $('#weekActions').hidden = !nPending;
  $('#carryBtn').textContent = `Pasar ${plural(nPending, 'pendiente', 'pendientes')} a la semana siguiente →`;

  renderExams();
  renderGcalChip();

  // Días
  $('#days').replaceChildren(...DAY_NAMES.map((name, day) => {
    const date = addDays(monday, day);
    const dateKey = keyOf(date);
    const list = tasks.filter((t) => t.day === day);
    const isToday = dateKey === todayKey;
    return dayCard({ name, day, date, list, isToday, isPast: dateKey < todayKey });
  }));

  if (focusAfterRender) {
    const target = document.getElementById(focusAfterRender);
    focusAfterRender = null;
    target?.focus();
  }
}

// ---------------------------------------------------------------- exámenes finales

const liveExams = () => Object.values(state.exams).filter((x) => !x.deleted)
  .sort((a, b) => a.date.localeCompare(b.date) || a.text.localeCompare(b.text));

function daysUntil(dateKey) {
  const t = new Date();
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.round((dateOfKey(dateKey) - today) / 86_400_000);
}

const fmtExamDate = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });

function renderExams() {
  const all = liveExams();
  const upcoming = all.filter((x) => daysUntil(x.date) >= 0);
  const past = all.filter((x) => daysUntil(x.date) < 0).reverse();
  const cards = [...upcoming, ...past].map((x) => {
    const n = daysUntil(x.date);
    const tone = n < 0 ? 'past' : n < 14 ? 'soon' : 'far';
    return el('section', { class: `exam ${tone}`, dataset: { id: x.id } },
      el('div', { class: 'exam-info' },
        el('h3', { class: 'exam-name' }, x.text),
        el('p', { class: 'exam-date' }, fmtExamDate.format(dateOfKey(x.date))),
        el('button', {
          type: 'button', class: 'exam-edit', title: 'Editar', 'aria-label': `Editar ${x.text}`,
          onclick: () => openExamDialog(x.id),
        }, '✎')),
      el('div', {
        class: 'countdown', role: 'img',
        'aria-label': n < 0 ? 'Examen hecho' : n === 0 ? 'El examen es hoy' : `Quedan ${plural(n, 'día', 'días')}`,
      },
        el('span', { class: 'countdown-num' }, n < 0 ? '✓' : n === 0 ? 'Hoy' : String(n)),
        n > 0 ? el('span', { class: 'countdown-label' }, n === 1 ? 'día' : 'días') : null));
  });
  if (!cards.length) {
    cards.push(el('button', { type: 'button', class: 'exam-empty', onclick: () => openExamDialog(null) },
      'Aún no hay exámenes.', el('br'), 'Pulsa + para añadir el primero.'));
  }
  $('#exams').replaceChildren(...cards);
}

$('#examAddBtn').addEventListener('click', () => openExamDialog(null));

const examDialog = $('#examDialog');
let editingExam = null; // id, o null si es nuevo

function openExamDialog(id) {
  const x = id ? state.exams[id] : null;
  if (id && (!x || x.deleted)) return;
  editingExam = id;
  $('#examDialogTitle').textContent = x ? 'Editar examen' : 'Nuevo examen';
  $('#examText').value = x ? x.text : '';
  $('#examDate').value = x ? x.date : '';
  $('#examDelete').hidden = !x;
  examDialog.showModal();
  if (matchMedia('(pointer: fine)').matches) $('#examText').focus();
}

// Intro en un campo = guardar (si no, el navegador activaría el primer botón: «Eliminar»).
for (const id of ['#examText', '#examDate']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if ($('#examForm').reportValidity()) examDialog.close('save'); }
  });
}

examDialog.addEventListener('close', () => {
  const action = examDialog.returnValue;
  examDialog.returnValue = '';
  const id = editingExam;
  editingExam = null;
  const text = $('#examText').value.trim();
  const date = $('#examDate').value;
  const x = id ? state.exams[id] : null;

  if (action === 'delete' && x) {
    x.deleted = true; x.text = ''; x.updatedAt = stamp(x.updatedAt);
    commit();
    toast('Examen eliminado.');
  } else if (action === 'save' && text && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    if (x) { Object.assign(x, { text, date }); x.updatedAt = stamp(x.updatedAt); }
    else { const nid = uid(); state.exams[nid] = { id: nid, text, date, updatedAt: stamp() }; }
    commit();
  } else if (pendingRender) render();
});

function renderProgress(tasks, goals) {
  const doneT = tasks.filter((t) => t.done).length;
  const doneG = goals.filter((g) => g.done).length;
  const started = goals.filter((g) => g.started && !g.done).length;
  const total = tasks.length + goals.length;
  const pct = total ? Math.round(((doneT + doneG) / total) * 100) : 0;

  const parts = [];
  if (tasks.length) parts.push(el('span', {}, `${doneT}/${tasks.length} ${tasks.length === 1 ? 'tarea' : 'tareas'}`));
  if (goals.length) parts.push(el('span', {}, `${doneG}/${goals.length} ${goals.length === 1 ? 'objetivo' : 'objetivos'}`));
  if (started) parts.push(el('span', { class: 'started-count' }, plural(started, 'empezado', 'empezados')));
  $('#progressText').replaceChildren(...parts);

  const fill = $('#progressFill');
  fill.style.width = `${pct}%`;
  fill.classList.toggle('complete', total > 0 && pct === 100);
  $('#progressBar').setAttribute('aria-valuenow', pct);
}

function dayCard({ name, day, date, list, isToday, isPast }) {
  const done = list.filter((t) => t.done).length;
  const ul = el('ul', { class: 'items', dataset: { day } }, list.map((t) => itemRow('tasks', t)));
  attachDrop(ul, day);
  const dateKey = keyOf(date);
  const events = gcal.connected ? gcal.eventsOn(dateKey) : [];
  const evList = events.length
    ? el('ul', { class: 'events', 'aria-label': 'Eventos de Google Calendar' }, events.map((e) => eventRow(e, dateKey)))
    : null;

  const input = el('input', {
    name: 'text', placeholder: 'Añadir tarea…', 'aria-label': `Añadir tarea el ${name.toLowerCase()}`,
    enterkeyhint: 'done', id: `add-${day}`,
  });
  const form = el('form', {
    class: 'add-form', autocomplete: 'off',
    onsubmit: (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      addTask(day, text);
      input.value = '';
      addingDay = day;
      focusAfterRender = `add-${day}`;
      commit();
    },
  }, input, el('button', { class: 'add-btn', 'aria-label': 'Añadir tarea' }, '+'));

  const section = el('section', {
    class: `day${isToday ? ' is-today' : ''}${isPast ? ' is-past' : ''}${addingDay === day ? ' adding' : ''}`,
    dataset: { day }, id: `day-${day}`,
  },
    el('header', { class: 'day-head' },
      el('h2', {},
        el('span', { class: 'day-name' }, name),
        el('span', { class: 'day-date' }, fmtDay.format(date)),
        isToday ? el('span', { class: 'today-tag' }, 'Hoy') : null),
      el('span', { class: 'count' }, list.length ? `${done}/${list.length}` : ''),
      gcal.connected ? el('button', {
        type: 'button', class: 'day-event', title: 'Nuevo evento en Google Calendar',
        'aria-label': `Nuevo evento el ${name.toLowerCase()}`,
        onclick: () => openEventDialog({ dateKey }),
      }, calendarIcon()) : null,
      // En el móvil la caja de añadir está plegada y se abre con este botón.
      el('button', {
        type: 'button', class: 'day-add', 'aria-label': `Nueva tarea el ${name.toLowerCase()}`,
        onclick: () => { addingDay = day; section.classList.add('adding'); input.focus(); },
      }, '+')),
    evList,
    ul,
    form);

  // Al salir de la caja vacía, se vuelve a plegar.
  input.addEventListener('blur', () => setTimeout(() => {
    if (!input.isConnected || addingDay !== day) return;
    if (input.value.trim() === '' && !form.contains(document.activeElement)) {
      addingDay = null;
      section.classList.remove('adding');
    }
  }, 150));

  return section;
}

function itemRow(kind, item) {
  const started = kind === 'goals' && item.started && !item.done;
  const li = el('li', {
    class: `item${item.done ? ' done' : ''}${started ? ' started' : ''}`, dataset: { id: item.id },
  },
    el('input', {
      type: 'checkbox', class: 'check', checked: item.done,
      'aria-label': item.done ? 'Marcar como pendiente' : 'Marcar como hecha',
      onchange: (e) => { updateItem(kind, item.id, { done: e.target.checked }); commit(); },
    }),
    el('button', {
      type: 'button', class: 'item-text', title: 'Editar',
      onclick: () => openItemDialog(kind, item.id),
    },
      item.text,
      item.pending ? el('span', { class: 'tag-pending' }, 'Pendiente') : null,
      item.repeats ? el('span', { class: 'repeat-mark', title: 'Se repite cada semana', 'aria-label': 'Se repite cada semana' }, '↻') : null),
    // Objetivos: circulito naranja = «empezado pero no acabado».
    kind === 'goals' ? el('button', {
      type: 'button', class: 'started-btn',
      'aria-pressed': item.started ? 'true' : 'false',
      'aria-label': item.started ? 'Quitar «empezado»' : 'Marcar como empezado',
      title: item.started ? 'Empezado (pulsa para quitar)' : 'Marcar como empezado',
      onclick: () => { updateItem(kind, item.id, { started: !item.started }); commit(); },
    }) : null);

  if (kind === 'tasks') {
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', item.id);
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      document.querySelectorAll('.drop-target, .drop-before').forEach((n) => n.classList.remove('drop-target', 'drop-before'));
    });
  }
  return li;
}

function attachDrop(list, day) {
  const clear = () => list.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'));
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drop-target');
    clear();
    const over = e.target.closest('.item');
    if (over && list.contains(over)) over.classList.add('drop-before');
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) { list.classList.remove('drop-target'); clear(); }
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    list.classList.remove('drop-target');
    clear();
    const id = e.dataTransfer.getData('text/plain');
    if (!id || !findTask(id)) return;
    const over = e.target.closest('.item');
    const beforeId = over && over.dataset.id !== id ? over.dataset.id : null;
    moveTask(id, day, beforeId);
    commit();
  });
}

// ---------------------------------------------------------------- diálogo de edición

const itemDialog = $('#itemDialog');
let editing = null;

const listDays = (days) => {
  if (days.length === 7) return 'todos los días';
  const names = days.map((d) => DAY_NAMES[d].toLowerCase());
  return names.length > 1 ? `cada ${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : `cada ${names[0]}`;
};

function refreshRepeatHint() {
  const days = [...editing.days].sort((a, b) => a - b);
  $('#repeatHint').textContent = editing.repeats
    ? (days.length ? `Se repite ${listDays(days)}. Los cambios valen desde esta semana.`
      : 'Dejará de repetirse. La de esta semana se queda como tarea normal.')
    : (days.length ? `Se repetirá ${listDays(days)}, desde esta semana.`
      : 'Elige días si quieres que se repita todas las semanas.');
}

function openItemDialog(kind, id) {
  const it = kind === 'tasks' ? findTask(id) : week().goals[id];
  if (!it || it.deleted) return;
  const rule = it.repeats ? state.rules[it.ruleId] : null;
  editing = { kind, id, key: currentKey, repeats: !!rule, days: new Set(rule ? rule.days : []) };

  $('#itemDialogTitle').textContent = kind === 'tasks' ? 'Editar tarea' : 'Editar objetivo';
  $('#itemText').value = it.text;
  $('#itemDelete').textContent = rule ? 'Quitar esta semana' : 'Eliminar';
  $('#moveGroup').hidden = $('#repeatGroup').hidden = kind !== 'tasks';

  if (kind === 'tasks') {
    $('#moveGrid').replaceChildren(
      ...DAY_SHORT.map((s, d) => el('button', {
        value: `move:${d}`, class: 'day-btn', title: DAY_NAMES[d],
        'aria-label': `Mover al ${DAY_NAMES[d].toLowerCase()}`, 'aria-current': d === it.day ? 'true' : 'false',
      }, s)),
      // Una repetida ya aparece sola la semana siguiente.
      rule ? null : el('button', { value: 'move:next', class: 'day-btn wide' }, 'Pasar a la semana siguiente →'),
    );
    $('#repeatGrid').replaceChildren(...DAY_SHORT.map((s, d) => el('button', {
      type: 'button', class: 'day-btn', title: DAY_NAMES[d],
      'aria-label': `Repetir cada ${DAY_NAMES[d].toLowerCase()}`,
      'aria-pressed': editing.days.has(d) ? 'true' : 'false',
      onclick: (e) => {
        if (editing.days.has(d)) editing.days.delete(d); else editing.days.add(d);
        e.currentTarget.setAttribute('aria-pressed', editing.days.has(d) ? 'true' : 'false');
        refreshRepeatHint();
      },
    }, s)));
    refreshRepeatHint();
  }
  itemDialog.showModal();
  // En móvil no abrir el teclado automáticamente.
  if (matchMedia('(pointer: fine)').matches) $('#itemText').focus();
}

$('#itemText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); itemDialog.close('save'); }
});

itemDialog.addEventListener('close', () => {
  const action = itemDialog.returnValue;
  itemDialog.returnValue = '';
  const ed = editing;
  editing = null;
  const isChange = action === 'delete' || action === 'save' || action.startsWith('move:');
  if (!ed || ed.key !== currentKey || !isChange) { if (pendingRender) render(); return; }

  const { kind, id } = ed;
  const item = kind === 'tasks' ? findTask(id) : week().goals[id];
  if (!item || item.deleted) { render(); return; }
  const text = $('#itemText').value.trim();

  if (action === 'delete') {
    const what = kind === 'goals' ? 'Objetivo eliminado.' : item.repeats ? 'Tarea quitada de esta semana.' : 'Tarea eliminada.';
    undoable(what, [currentKey], () => removeItem(kind, id));
    return;
  }

  if (kind === 'goals') {
    if (text && text !== item.text) updateItem('goals', id, { text });
    commit();
    return;
  }

  const days = [...ed.days].sort((a, b) => a - b);
  const rule = item.repeats ? state.rules[item.ruleId] : null;
  let replaced = false; // la tarea ha pasado a ser otra (con otro id)

  if (rule) {
    if (text && text !== rule.text) { rule.text = text; rule.updatedAt = stamp(rule.updatedAt); }
    if (days.join() !== rule.days.join()) { changeRuleDays(rule, days, item); replaced = true; }
  } else {
    if (text && text !== item.text) updateItem('tasks', id, { text });
    if (days.length) { convertToRule(id, days); replaced = true; }
  }

  if (!replaced && action === 'move:next') {
    const to = shiftWeek(currentKey, 1);
    undoable('Tarea pasada a la semana siguiente.', [currentKey, to], () => carryTask(findTask(id), currentKey, to));
    return;
  }
  if (!replaced && action.startsWith('move:')) {
    const day = Number(action.slice(5));
    if (day !== item.day) moveTask(id, day);
  }
  commit();
});

// ---------------------------------------------------------------- objetivos, notas y pendientes

$('#goalForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.elements.text;
  const text = input.value.trim();
  if (!text) return;
  addGoal(text);
  input.value = '';
  focusAfterRender = 'goalInput';
  commit();
});

$('#carryBtn').addEventListener('click', carryOver);

let notesTimer = null;
function saveNotes(key, value) {
  const w = week(key);
  if (value === w.notes.text) return;
  w.notes = { text: value, updatedAt: stamp(w.notes.updatedAt) };
  persist();
  sync.schedule();
}
$('#notes').addEventListener('input', (e) => {
  const key = currentKey;
  const value = e.target.value;
  $('#notesState').textContent = 'Guardando…';
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => {
    notesTimer = null;
    saveNotes(key, value);
    $('#notesState').textContent = 'Guardado';
  }, 400);
});
$('#notes').addEventListener('blur', () => {
  // Guardar al instante si quedaba algo pendiente.
  if (!notesTimer) return;
  clearTimeout(notesTimer);
  notesTimer = null;
  saveNotes(currentKey, $('#notes').value);
  $('#notesState').textContent = '';
});

// ---------------------------------------------------------------- navegación

const page = $('#page');

/** `dir`: 'next' | 'prev' para animar el cambio. */
function goToWeek(key, dir = null) {
  if (key === currentKey) return;
  $('#notes').blur();
  addingDay = null;
  currentKey = key;
  render();
  refreshEvents(true);
  page.classList.remove('slide-left', 'slide-right');
  if (dir) {
    void page.offsetWidth;
    page.classList.add(dir === 'next' ? 'slide-left' : 'slide-right');
  }
}
const goPrev = () => goToWeek(shiftWeek(currentKey, -1), 'prev');
const goNext = () => goToWeek(shiftWeek(currentKey, 1), 'next');

$('#prevWeek').addEventListener('click', goPrev);
$('#nextWeek').addEventListener('click', goNext);
$('#todayBtn').addEventListener('click', () => {
  const key = thisWeekKey();
  goToWeek(key, key > currentKey ? 'next' : 'prev');
  scrollToGoals();
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || document.querySelector('dialog[open]')) return;
  if (e.key === 'ArrowLeft') goPrev();
  if (e.key === 'ArrowRight') goNext();
});

// Deslizar con el dedo a izquierda o derecha para cambiar de semana.
let swipe = null;
page.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  const edge = 24; // los bordes se dejan para los gestos del navegador
  swipe = (e.touches.length === 1 && !e.target.closest('input, textarea')
    && t.clientX > edge && t.clientX < innerWidth - edge)
    ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
}, { passive: true });
page.addEventListener('touchmove', (e) => { if (e.touches.length > 1) swipe = null; }, { passive: true });
page.addEventListener('touchcancel', () => { swipe = null; }, { passive: true });
page.addEventListener('touchend', (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  const quick = Date.now() - swipe.at < 700;
  swipe = null;
  if (!quick || Math.abs(dx) < 70 || Math.abs(dx) < 2.5 * Math.abs(dy)) return;
  if (dx < 0) goNext(); else goPrev();
}, { passive: true });

/** Vuelve arriba del todo, a los objetivos de la semana. */
function scrollToGoals(smooth = true) {
  window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
}

// ---------------------------------------------------------------- Google Calendar

const gcal = new GCal({
  onChange: () => requestRender(),
  onStatus: (s, detail) => {
    renderGcalChip();
    if (settingsDialog.open) refreshGcalSettings();
    else if ((s === 'reauth' || s === 'error') && detail) toast(detail, { low: true, duration: 6000 });
  },
});

const calendarIcon = () => {
  const span = el('span', { class: 'cal-icon', 'aria-hidden': 'true' });
  span.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18M12 13v5M9.5 15.5h5"/></svg>';
  return span;
};

const fmtHour = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

function eventRow(ev, dateKey) {
  const day0 = dateOfKey(dateKey);
  let when;
  if (ev.allDay) when = 'Todo el día';
  else if (ev.start >= day0) when = `${fmtHour.format(ev.start)}–${fmtHour.format(ev.end)}`;
  else when = 'Continúa';
  const ended = ev.end <= new Date();
  return el('li', { class: `event${ev.allDay ? ' all-day' : ''}${ended ? ' ended' : ''}` },
    el('button', {
      type: 'button', class: 'event-body', title: `${ev.title} (Google Calendar)`,
      onclick: () => openEventDialog({ ev }),
    },
      el('span', { class: 'event-time' }, when),
      el('span', { class: 'event-title' }, ev.title,
        ev.recurring ? el('span', { class: 'repeat-mark', title: 'Evento que se repite' }, '↻') : null)));
}

let lastEventFetch = 0;
function refreshEvents(force = false) {
  if (!gcal.connected || document.hidden || gcal.status === 'reauth') return;
  if (!force && Date.now() - lastEventFetch < 20_000) return;
  lastEventFetch = Date.now();
  gcal.loadWeek(currentKey);
}
setInterval(() => refreshEvents(false), 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshEvents(false); });
window.addEventListener('online', () => refreshEvents(true));

const CHIP_TEXT = {
  off: 'Conectar Google Calendar',
  idle: 'Conectar Google Calendar',
  ok: 'Google Calendar',
  reauth: 'Reconectar Google',
  offline: 'Google sin conexión',
  error: 'Google: revisar',
};
function renderGcalChip() {
  const chip = $('#gcalChip');
  const s = gcal.status;
  chip.dataset.state = s;
  chip.textContent = CHIP_TEXT[s] || '';
  chip.title = s === 'ok' ? 'Conectado. Pulsa para actualizar ahora.' : gcal.lastDetail || CHIP_TEXT[s];
}

$('#gcalChip').addEventListener('click', async () => {
  const s = gcal.status;
  if (s === 'off' || s === 'idle' || s === 'error') return openSettings();
  if (s === 'reauth') {
    try { await gcal.connect(); refreshEvents(true); } catch (e) { toast(e.message, { duration: 6000 }); }
    return;
  }
  refreshEvents(true);
  toast('Actualizando eventos…', { low: true, duration: 1500 });
});

// ---------- diálogo de evento

const eventDialog = $('#eventDialog');
let editingEvent = null; // { ev } si existe, { dateKey } si es nuevo
const eventInputs = {
  title: $('#eventTitle'), allDay: $('#eventAllDay'),
  startDate: $('#eventStartDate'), startTime: $('#eventStartTime'),
  endDate: $('#eventEndDate'), endTime: $('#eventEndTime'),
};
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function syncEventForm() {
  const f = eventInputs;
  const allDay = f.allDay.checked;
  $('#eventStartTimeWrap').hidden = $('#eventEndTimeWrap').hidden = allDay;
  f.startTime.required = f.endTime.required = !allDay;
  const bad = f.startDate.value && f.endDate.value && (allDay
    ? f.endDate.value < f.startDate.value
    : `${f.endDate.value}T${f.endTime.value}` <= `${f.startDate.value}T${f.startTime.value}`);
  f.endDate.setCustomValidity(bad ? 'El final debe ser posterior al inicio.' : '');
  $('#eventHint').textContent = bad ? 'El final debe ser posterior al inicio.' : '';
}

/** Identificador propio (base32hex, como pide Google): permite reintentar sin duplicar. */
function newEventId() {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return [...bytes].map((b) => 'abcdefghijklmnopqrstuv0123456789'[b % 32]).join('');
}

function openEventDialog({ ev = null, dateKey = null, values = null }) {
  editingEvent = { ev, dateKey, newId: values?.newId || newEventId() };
  const f = eventInputs;
  let v = values;
  if (!v && ev) {
    v = ev.allDay
      ? { title: ev.title, allDay: true, startDate: keyOf(ev.start), startTime: '09:00', endDate: keyOf(addDays(ev.end, -1)), endTime: '10:00' }
      : { title: ev.title, allDay: false, startDate: keyOf(ev.start), startTime: hhmm(ev.start), endDate: keyOf(ev.end), endTime: hhmm(ev.end) };
  }
  v = v || { title: '', allDay: false, startDate: dateKey, startTime: '09:00', endDate: dateKey, endTime: '10:00' };
  f.title.value = v.title; f.allDay.checked = v.allDay;
  f.startDate.value = v.startDate; f.startTime.value = v.startTime;
  f.endDate.value = v.endDate; f.endTime.value = v.endTime;
  $('#eventDialogTitle').textContent = ev ? 'Editar evento' : 'Nuevo evento';
  $('#eventDelete').hidden = !ev;
  syncEventForm();
  $('#eventHint').textContent = ev?.recurring ? 'Evento que se repite: los cambios solo afectan a esta repetición.'
    : 'Se guarda en tu Google Calendar principal.';
  eventDialog.showModal();
  if (matchMedia('(pointer: fine)').matches) f.title.focus();
}

for (const input of Object.values(eventInputs)) {
  input.addEventListener('change', () => {
    const f = eventInputs;
    if (input === f.startDate && f.endDate.value < f.startDate.value) f.endDate.value = f.startDate.value;
    if ((input === f.startTime || input === f.startDate) && !f.allDay.checked
      && f.startDate.value === f.endDate.value && f.startTime.value && f.endTime.value <= f.startTime.value) {
      const d = localTime(f.startDate.value, f.startTime.value);
      d.setHours(d.getHours() + 1);
      if (keyOf(d) === f.startDate.value) f.endTime.value = hhmm(d);
    }
    syncEventForm();
  });
}
const localTime = (key, time) => { const d = dateOfKey(key); const [h, m] = time.split(':').map(Number); d.setHours(h, m); return d; };
// Intro en cualquier campo = guardar (si no, el navegador activaría «Eliminar», el primer botón).
for (const input of [eventInputs.title, eventInputs.startDate, eventInputs.startTime, eventInputs.endDate, eventInputs.endTime]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if ($('#eventForm').reportValidity()) eventDialog.close('save'); }
  });
}

eventDialog.addEventListener('close', async () => {
  const action = eventDialog.returnValue;
  eventDialog.returnValue = '';
  const ed = editingEvent;
  editingEvent = null;
  if (!ed || (action !== 'save' && action !== 'delete') || (action === 'delete' && !ed.ev)) { if (pendingRender) render(); return; }

  const f = eventInputs;
  const values = {
    title: f.title.value.trim(), allDay: f.allDay.checked,
    startDate: f.startDate.value, startTime: f.startTime.value || '09:00',
    endDate: f.endDate.value, endTime: f.endTime.value || '10:00',
  };
  try {
    if (action === 'delete') {
      if (!confirm(`¿Eliminar «${ed.ev.title}» de Google Calendar?${ed.ev.recurring ? ' Solo se elimina esta repetición.' : ''}`)) return;
      toast('Eliminando de Google Calendar…', { duration: 15_000 });
      await gcal.remove(ed.ev);
      toast('Evento eliminado de Google Calendar.');
    } else if (!ed.ev) {
      if (!values.title) return;
      toast('Creando en Google Calendar…', { duration: 15_000 });
      await gcal.create({ id: ed.newId, title: values.title, schedule: values });
      toast('Evento creado en Google Calendar.');
    } else {
      const orig = ed.ev;
      const same = orig.allDay === values.allDay && keyOf(orig.start) === values.startDate
        && (values.allDay ? keyOf(addDays(orig.end, -1)) === values.endDate
          : hhmm(orig.start) === values.startTime && keyOf(orig.end) === values.endDate && hhmm(orig.end) === values.endTime);
      const patch = {};
      if (values.title && values.title !== orig.title) patch.title = values.title;
      if (!same) patch.schedule = values;
      if (!Object.keys(patch).length) return;
      toast('Guardando en Google Calendar…', { duration: 15_000 });
      await gcal.update(orig, patch);
      toast('Evento actualizado en Google Calendar.');
    }
    refreshEvents(true);
  } catch (err) {
    toast(err.message || 'No se pudo completar el cambio en Google Calendar.', {
      duration: 9000,
      action: action === 'delete' ? '' : 'Reintentar',
      onAction: () => openEventDialog({ ev: ed.ev, dateKey: ed.dateKey, values: { ...values, newId: ed.newId } }),
    });
    if (err.kind === 'gone') refreshEvents(true);
  }
});

// ---------------------------------------------------------------- apariencia

function savedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch { return 'system'; }
}

function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // Color de la barra del navegador / del sistema.
  const [lightMeta, darkMeta] = document.querySelectorAll('meta[name="theme-color"]');
  const colors = { light: '#f6f5f1', dark: '#16171a' };
  lightMeta.content = theme === 'dark' ? colors.dark : colors.light;
  darkMeta.content = theme === 'light' ? colors.light : colors.dark;
  for (const b of document.querySelectorAll('[data-theme-choice]')) {
    b.setAttribute('aria-pressed', b.dataset.themeChoice === theme ? 'true' : 'false');
  }
}

$('#themeChoice').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme-choice]');
  if (!btn) return;
  const theme = btn.dataset.themeChoice;
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, theme);
  } catch { /* ignorar */ }
  applyTheme(theme);
});

// ---------------------------------------------------------------- sincronización y ajustes

const settingsBtn = $('#settingsBtn');
const settingsDialog = $('#settingsDialog');
const syncInfo = $('#syncInfo');
let lastStatus = { state: 'off', detail: '' };
let settledStatus = 'off'; // último estado que no es «sincronizando»

const sync = new GistSync({
  getState: () => state,
  setState: (merged) => { state = merged; persist(); requestRender(); },
  onStatus: (s, detail = '') => {
    lastStatus = { state: s, detail };
    settingsBtn.dataset.state = s;
    const labels = {
      off: 'Sin sincronizar',
      syncing: 'Sincronizando…',
      ok: 'Sincronizado',
      offline: 'Sin conexión',
      error: 'Error al sincronizar',
    };
    $('#syncText').textContent = labels[s] || s;
    settingsBtn.title = detail || labels[s] || '';

    // Avisar solo cuando el estado cambia (no en cada comprobación).
    if (s !== 'syncing') {
      if (!settingsDialog.open) {
        if (s === 'offline' && settledStatus !== 'offline') {
          toast('Sin conexión. Los cambios se guardan aquí y se subirán después.', { low: true, duration: 5000 });
        } else if (s === 'error' && settledStatus !== 'error') {
          toast(detail, { low: true, action: 'Ajustes', onAction: openSettings, duration: 8000 });
        } else if (s === 'ok' && (settledStatus === 'offline' || settledStatus === 'error')) {
          toast('Sincronizado de nuevo.', { low: true });
        }
      }
      settledStatus = s;
    }
    if (settingsDialog.open) refreshSettings();
  },
});

function refreshSettings() {
  const connected = sync.configured;
  $('#disconnectBtn').hidden = !connected;
  $('#connectBtn').textContent = connected ? 'Sincronizar ahora' : 'Conectar';
  $('#syncSetup').hidden = connected;
  syncInfo.className = 'sync-info';
  if (!connected) { syncInfo.textContent = 'Ahora mismo los datos solo están en este dispositivo.'; return; }
  const { state: s, detail } = lastStatus;
  if (s === 'error' || s === 'offline') { syncInfo.classList.add('error'); syncInfo.textContent = detail; }
  else if (s === 'syncing') syncInfo.textContent = 'Sincronizando…';
  else {
    syncInfo.classList.add('ok');
    syncInfo.textContent = `Conectado. Última sincronización: ${sync.lastSync ? fmtTime.format(sync.lastSync) : '—'}.`;
  }
}

function refreshGcalSettings() {
  const s = gcal.status;
  const info = $('#gcalInfo');
  info.className = 'sync-info';
  $('#gcalSetup').hidden = gcal.connected;
  $('#gcalDisconnect').hidden = !gcal.connected;
  $('#gcalConnect').textContent = s === 'reauth' ? 'Reconectar' : gcal.connected ? 'Actualizar ahora' : 'Conectar con Google';
  if (!gcal.connected) {
    info.textContent = s === 'idle' ? 'Client ID guardado. Pulsa «Conectar con Google».' : 'Google Calendar no está conectado.';
  } else if (s === 'ok') { info.classList.add('ok'); info.textContent = 'Conectado a Google Calendar.'; }
  else { info.classList.add('error'); info.textContent = gcal.lastDetail || 'Hay un problema con Google Calendar.'; }
}

function openSettings() {
  if (settingsDialog.open) return;
  $('#tokenInput').value = '';
  $('#gcalOrigin').textContent = location.origin;
  $('#gcalClientId').value = gcal.clientId;
  refreshGcalSettings();
  refreshSettings();
  settingsDialog.showModal();
}
settingsBtn.addEventListener('click', openSettings);
settingsDialog.addEventListener('close', () => { if (pendingRender) render(); });

$('#connectBtn').addEventListener('click', async () => {
  const btn = $('#connectBtn');
  if (sync.configured) { sync.syncNow(); return; }
  btn.disabled = true;
  syncInfo.className = 'sync-info';
  syncInfo.textContent = 'Conectando con GitHub…';
  try {
    const login = await sync.connect($('#tokenInput').value);
    $('#tokenInput').value = '';
    refreshSettings();
    syncInfo.textContent = `Conectado como ${login}. Repite este paso en tus otros dispositivos.`;
  } catch (err) {
    syncInfo.className = 'sync-info error';
    syncInfo.textContent =
      err.status === 401 ? 'Token no válido. Revisa que lo hayas copiado entero.'
      : err.status === 403 || err.status === 404 ? 'Al token le falta el permiso «gist».'
      : err instanceof TypeError ? 'No hay conexión con GitHub.'
      : err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#gcalConnect').addEventListener('click', async () => {
  const btn = $('#gcalConnect');
  const info = $('#gcalInfo');
  if (gcal.connected) {
    if (gcal.status === 'reauth') { try { await gcal.connect(); } catch (e) { info.className = 'sync-info error'; info.textContent = e.message; return; } }
    refreshEvents(true); refreshGcalSettings(); return;
  }
  const typed = $('#gcalClientId').value.trim();
  if (typed && !gcal.setClientId(typed)) {
    info.className = 'sync-info error';
    info.textContent = 'Ese Client ID no parece válido. Debe terminar en .apps.googleusercontent.com.';
    return;
  }
  if (!gcal.clientId) { info.className = 'sync-info error'; info.textContent = 'Pega primero el Client ID de Google.'; return; }
  btn.disabled = true;
  info.className = 'sync-info';
  info.textContent = 'Abriendo la ventana de Google…';
  try {
    await gcal.connect();
    refreshEvents(true);
    render();
  } catch (e) {
    info.className = 'sync-info error';
    info.textContent = e.message;
    return;
  } finally {
    btn.disabled = false;
  }
  refreshGcalSettings();
});

$('#gcalDisconnect').addEventListener('click', () => {
  if (!confirm('¿Desconectar Google Calendar? Tus eventos de Google no se borran; solo dejan de verse aquí.')) return;
  gcal.disconnect();
  render();
  refreshGcalSettings();
});

$('#disconnectBtn').addEventListener('click', () => {
  if (!confirm('¿Desconectar este dispositivo? Los datos se quedan aquí y en GitHub, pero dejarán de sincronizarse.')) return;
  sync.disconnect();
  settledStatus = 'off';
  refreshSettings();
});

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `planning-semanal-${keyOf(new Date())}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
});

// Si otra pestaña del mismo navegador cambia los datos.
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) { state = prune(load()); requestRender(); }
});

// Al cambiar de día con la app abierta (p. ej. a medianoche), refrescar "Hoy".
let lastDay = keyOf(new Date());
setInterval(() => {
  const now = keyOf(new Date());
  if (now !== lastDay) { lastDay = now; requestRender(); }
}, 60_000);

// ---------------------------------------------------------------- arranque

// Al abrir, empezar siempre por los objetivos (sin recuperar el scroll anterior).
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
applyTheme(savedTheme());
render();
scrollToGoals(false);
sync.start();
refreshEvents(true);

// Service worker: abre al instante con la copia guardada y avisa si hay versión nueva.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  let updateTimer = null;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'update-available') return;
    clearTimeout(updateTimer); // llegan varios avisos seguidos (uno por archivo)
    updateTimer = setTimeout(() => {
      toast('Hay una versión nueva de la app.', {
        action: 'Recargar', onAction: () => location.reload(), duration: 20000, low: true,
      });
    }, 1500);
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
