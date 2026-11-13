import { emptyWeek, normalizeState, stamp, uid } from './store.js';
import { GistSync } from './sync.js';

const STORAGE_KEY = 'planning-semanal:data';
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

// ---------------------------------------------------------------- estado

let state = load();

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
const fmtDay = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
const fmtDayYear = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

const thisWeekKey = () => keyOf(mondayOf(new Date()));
let currentKey = thisWeekKey();

// ---------------------------------------------------------------- mutaciones

function week(key = currentKey) {
  return state.weeks[key] || (state.weeks[key] = emptyWeek());
}
const live = (map) => Object.values(map).filter((it) => !it.deleted).sort((a, b) => a.order - b.order);
const tasksOf = (w, day) => live(w.tasks).filter((t) => t.day === day);

function commit() {
  persist();
  render();
  sync.schedule();
}

function addTask(day, text, key = currentKey) {
  const w = week(key);
  const last = tasksOf(w, day).at(-1);
  const id = uid();
  w.tasks[id] = { id, text, done: false, day, order: last ? last.order + 1 : 0, updatedAt: stamp() };
}

function addGoal(text) {
  const w = week();
  const last = live(w.goals).at(-1);
  const id = uid();
  w.goals[id] = { id, text, done: false, order: last ? last.order + 1 : 0, updatedAt: stamp() };
}

function updateItem(kind, id, patch, key = currentKey) {
  const it = week(key)[kind][id];
  if (!it) return;
  Object.assign(it, patch, { updatedAt: stamp(it.updatedAt) });
}

function removeItem(kind, id, key = currentKey) {
  updateItem(kind, id, { deleted: true, text: '' }, key);
}

/** Mueve una tarea a otro día, opcionalmente antes de otra tarea. */
function moveTask(id, day, beforeId = null) {
  const w = week();
  const list = tasksOf(w, day).filter((t) => t.id !== id);
  let order;
  const idx = beforeId ? list.findIndex((t) => t.id === beforeId) : -1;
  if (idx === -1) order = list.length ? list.at(-1).order + 1 : 0;
  else if (idx === 0) order = list[0].order - 1;
  else order = (list[idx - 1].order + list[idx].order) / 2;
  updateItem('tasks', id, { day, order });
}

function moveTaskToNextWeek(id) {
  const t = week().tasks[id];
  if (!t) return;
  const nextKey = keyOf(addDays(dateOfKey(currentKey), 7));
  addTask(t.day, t.text, nextKey);
  removeItem('tasks', id);
}

// ---------------------------------------------------------------- render

let pendingRender = false;
let focusAfterRender = null;

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
  const sunday = addDays(monday, 6);
  const todayKey = keyOf(new Date());
  const isThisWeek = currentKey === thisWeekKey();

  // Cabecera
  const sameYear = monday.getFullYear() === sunday.getFullYear();
  $('#weekLabel').textContent =
    `${(sameYear ? fmtDay : fmtDayYear).format(monday)} – ${fmtDayYear.format(sunday)}` +
    (isThisWeek ? ' · esta semana' : '');
  $('#todayBtn').disabled = isThisWeek;

  // Objetivos
  const goals = live(w.goals);
  $('#goalCount').textContent = goals.length ? `${goals.filter((g) => g.done).length}/${goals.length}` : '';
  $('#goalList').replaceChildren(
    ...(goals.length ? goals.map((g) => itemRow('goals', g)) : [el('li', { class: 'empty' }, 'Sin objetivos todavía.')]),
  );

  // Notas (no pisar lo que se está escribiendo)
  const notes = $('#notes');
  if (document.activeElement !== notes) notes.value = w.notes.text;
  $('#notesState').textContent = '';

  // Días
  const days = DAY_NAMES.map((name, day) => {
    const date = addDays(monday, day);
    const dateKey = keyOf(date);
    const tasks = tasksOf(w, day);
    const done = tasks.filter((t) => t.done).length;
    const isToday = dateKey === todayKey;
    const list = el('ul', { class: 'items', dataset: { day } },
      tasks.map((t) => itemRow('tasks', t)));
    attachDrop(list, day);
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
        focusAfterRender = `add-${day}`;
        commit();
      },
    }, input, el('button', { class: 'add-btn', 'aria-label': 'Añadir tarea' }, '+'));

    return el('section', {
      class: `day${isToday ? ' is-today' : ''}${dateKey < todayKey ? ' is-past' : ''}`,
      dataset: { day }, id: `day-${day}`,
    },
      el('header', { class: 'day-head' },
        el('h2', {},
          el('span', { class: 'day-name' }, name),
          el('span', { class: 'day-date' }, fmtDay.format(date)),
          isToday ? el('span', { class: 'today-tag' }, 'Hoy') : null),
        el('span', { class: 'count' }, tasks.length ? `${done}/${tasks.length}` : '')),
      list,
      form);
  });
  $('#days').replaceChildren(...days);

  if (focusAfterRender) {
    const target = document.getElementById(focusAfterRender);
    focusAfterRender = null;
    target?.focus();
  }
}

function itemRow(kind, item) {
  const li = el('li', { class: `item${item.done ? ' done' : ''}`, dataset: { id: item.id } },
    el('input', {
      type: 'checkbox', class: 'check', checked: item.done,
      'aria-label': item.done ? 'Marcar como pendiente' : 'Marcar como hecha',
      onchange: (e) => { updateItem(kind, item.id, { done: e.target.checked }); commit(); },
    }),
    el('button', {
      type: 'button', class: 'item-text', title: 'Editar',
      onclick: () => openItemDialog(kind, item.id),
    }, item.text));

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
    if (!id || !week().tasks[id]) return;
    const over = e.target.closest('.item');
    const beforeId = over && over.dataset.id !== id ? over.dataset.id : null;
    moveTask(id, day, beforeId);
    commit();
  });
}

// ---------------------------------------------------------------- diálogo de edición

const itemDialog = $('#itemDialog');
let editing = null;

function openItemDialog(kind, id) {
  const it = week()[kind][id];
  if (!it) return;
  editing = { kind, id, key: currentKey };
  $('#itemDialogTitle').textContent = kind === 'tasks' ? 'Editar tarea' : 'Editar objetivo';
  $('#itemText').value = it.text;
  const moveGroup = $('#moveGroup');
  moveGroup.hidden = kind !== 'tasks';
  if (kind === 'tasks') {
    $('#moveGrid').replaceChildren(
      ...DAY_SHORT.map((s, d) => el('button', {
        value: `move:${d}`, class: 'move-btn', title: DAY_NAMES[d],
        'aria-label': `Mover al ${DAY_NAMES[d].toLowerCase()}`, 'aria-current': d === it.day ? 'true' : 'false',
      }, s)),
      el('button', { value: 'move:next', class: 'move-btn move-wide' }, 'Pasar a la semana siguiente →'),
    );
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
  if (!ed || ed.key !== currentKey) { if (pendingRender) render(); return; }
  const it = week()[ed.kind][ed.id];
  if (!it || it.deleted) { render(); return; }
  const text = $('#itemText').value.trim();

  if (action === 'delete') {
    removeItem(ed.kind, ed.id);
  } else if (action === 'save' || action.startsWith('move:')) {
    if (text && text !== it.text) updateItem(ed.kind, ed.id, { text });
    if (action === 'move:next') moveTaskToNextWeek(ed.id);
    else if (action.startsWith('move:')) {
      const day = Number(action.slice(5));
      if (day !== it.day) moveTask(ed.id, day);
    }
  } else {
    if (pendingRender) render();
    return;
  }
  commit();
});

// ---------------------------------------------------------------- objetivos y notas

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

let notesTimer = null;
$('#notes').addEventListener('input', (e) => {
  const key = currentKey;
  const value = e.target.value;
  $('#notesState').textContent = 'Guardando…';
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => {
    const w = week(key);
    w.notes = { text: value, updatedAt: stamp(w.notes.updatedAt) };
    persist();
    sync.schedule();
    $('#notesState').textContent = 'Guardado';
  }, 400);
});
$('#notes').addEventListener('blur', () => {
  // Guardar al instante si quedaba algo pendiente.
  if (notesTimer) {
    clearTimeout(notesTimer);
    notesTimer = null;
    const w = week();
    const value = $('#notes').value;
    if (value !== w.notes.text) {
      w.notes = { text: value, updatedAt: stamp(w.notes.updatedAt) };
      persist();
      sync.schedule();
    }
    $('#notesState').textContent = '';
  }
});

// ---------------------------------------------------------------- navegación

function goToWeek(key) {
  $('#notes').blur();
  currentKey = key;
  render();
}
$('#prevWeek').addEventListener('click', () => goToWeek(keyOf(addDays(dateOfKey(currentKey), -7))));
$('#nextWeek').addEventListener('click', () => goToWeek(keyOf(addDays(dateOfKey(currentKey), 7))));
$('#todayBtn').addEventListener('click', () => { goToWeek(thisWeekKey()); scrollToToday(); });

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || document.querySelector('dialog[open]')) return;
  if (e.key === 'ArrowLeft') $('#prevWeek').click();
  if (e.key === 'ArrowRight') $('#nextWeek').click();
});

function scrollToToday() {
  if (!matchMedia('(max-width: 559px)').matches) return;
  const day = (new Date().getDay() + 6) % 7;
  if (day === 0) return;
  document.getElementById(`day-${day}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---------------------------------------------------------------- sincronización

const syncBtn = $('#syncBtn');
const syncText = $('#syncText');
const syncInfo = $('#syncInfo');
let lastStatus = { state: 'off', detail: '' };

const sync = new GistSync({
  getState: () => state,
  setState: (merged) => { state = merged; persist(); requestRender(); },
  onStatus: (s, detail = '') => {
    lastStatus = { state: s, detail };
    syncBtn.dataset.state = s;
    const labels = {
      off: 'Sin sincronizar',
      syncing: 'Sincronizando…',
      ok: 'Sincronizado',
      offline: 'Sin conexión',
      error: 'Error de sync',
    };
    syncText.textContent = labels[s] || s;
    syncBtn.title = detail || labels[s] || '';
    if (syncDialog.open) refreshSyncDialog();
  },
});

const syncDialog = $('#syncDialog');

function refreshSyncDialog() {
  const connected = sync.configured;
  $('#disconnectBtn').hidden = !connected;
  $('#connectBtn').textContent = connected ? 'Sincronizar ahora' : 'Conectar';
  $('#tokenInput').closest('.field').hidden = connected;
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

syncBtn.addEventListener('click', () => {
  $('#tokenInput').value = '';
  refreshSyncDialog();
  syncDialog.showModal();
});

$('#connectBtn').addEventListener('click', async () => {
  const btn = $('#connectBtn');
  if (sync.configured) { sync.syncNow(); return; }
  btn.disabled = true;
  syncInfo.className = 'sync-info';
  syncInfo.textContent = 'Conectando con GitHub…';
  try {
    const login = await sync.connect($('#tokenInput').value);
    $('#tokenInput').value = '';
    refreshSyncDialog();
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

$('#disconnectBtn').addEventListener('click', () => {
  if (!confirm('¿Desconectar este dispositivo? Los datos se quedan aquí y en GitHub, pero dejarán de sincronizarse.')) return;
  sync.disconnect();
  refreshSyncDialog();
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
  if (e.key === STORAGE_KEY) { state = load(); requestRender(); }
});

// Al cambiar de día con la app abierta (p. ej. a medianoche), refrescar "Hoy".
let lastDay = keyOf(new Date());
setInterval(() => {
  const now = keyOf(new Date());
  if (now !== lastDay) { lastDay = now; requestRender(); }
}, 60_000);

// ---------------------------------------------------------------- arranque

render();
scrollToToday();
sync.start();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
