// Modo examen: un panel para la época de exámenes.
//
//  · Izquierda: calendario del mes con los exámenes marcados, lista de próximos
//    exámenes con cuenta atrás y un temporizador de estudio (pomodoro).
//  · Centro: asignaturas, cada una con sus temas (pendiente → estudiado → repasado),
//    su progreso, el ritmo necesario para llegar al examen y sus apuntes en Drive.
//  · Derecha: plan sugerido para hoy, tareas y eventos de hoy y objetivos de la semana.

const STATUS = ['Pendiente', 'Estudiado', 'Repasado'];
export const SUBJECT_COLORS = ['#2f6fdf', '#1f9d8f', '#e8790c', '#c93a7a', '#7a5af8', '#2e9d5b', '#d9534f', '#a07a12'];
const TIMER_KEY = 'planning-semanal:timer';

const fmtShort = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDayMonth = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
const fmtMonth = new Intl.DateTimeFormat('es-ES', { month: 'short' });
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const fmtNum = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const fmtSize = (b) => (b >= 1048576 ? `${fmtNum.format(b / 1048576)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : b ? `${b} B` : '');

/**
 * @param {object} ctx funciones y datos de la app (ver app.js)
 */
export function createStudy(ctx) {
  const { $, el, plural, keyOf, dateOfKey, addDays, gcal, drive, toast } = ctx;
  const S = () => ctx.getState();

  let calShift = 0; // semanas que se ha movido el calendario respecto a la actual

  // ---------------------------------------------------------------- datos

  const liveSubjects = () => Object.values(S().subjects).filter((x) => !x.deleted)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const topicsOf = (sid) => Object.values(S().topics).filter((t) => !t.deleted && t.subjectId === sid)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const examOf = (s) => {
    const x = s.examId && S().exams[s.examId];
    return x && !x.deleted ? x : null;
  };
  const subjectOfExam = (examId) => liveSubjects().find((s) => s.examId === examId) || null;
  const tone = (n) => (n < 0 ? 'past' : n < 14 ? 'soon' : 'far');

  function progressOf(topics) {
    const units = topics.reduce((a, t) => a + (2 - t.status), 0);
    const pct = topics.length ? Math.round((topics.reduce((a, t) => a + t.status, 0) / (2 * topics.length)) * 100) : 0;
    return {
      pct, units,
      pending: topics.filter((t) => t.status === 0).length,
      studied: topics.filter((t) => t.status === 1).length,
      reviewed: topics.filter((t) => t.status === 2).length,
    };
  }

  // ---------------------------------------------------------------- cambios

  function addSubject({ name, color, examId }) {
    const id = ctx.uid();
    const last = liveSubjects().at(-1);
    S().subjects[id] = { id, name, color, examId, order: last ? last.order + 1 : 0, updatedAt: ctx.stamp() };
    return id;
  }

  function updateSubject(id, patch) {
    const s = S().subjects[id];
    if (!s) return;
    Object.assign(s, patch, { updatedAt: ctx.stamp(s.updatedAt) });
  }

  function addTopics(sid, texts) {
    let last = topicsOf(sid).at(-1);
    let order = last ? last.order + 1 : 0;
    for (const text of texts) {
      const id = ctx.uid();
      S().topics[id] = { id, subjectId: sid, text, status: 0, order: order++, updatedAt: ctx.stamp() };
    }
  }

  function updateTopic(id, patch) {
    const t = S().topics[id];
    if (!t) return;
    Object.assign(t, patch, { updatedAt: ctx.stamp(t.updatedAt) });
  }

  /** Quita viñetas y números del principio de una línea pegada («1. », «- », «• »). */
  const cleanLine = (l) => l.replace(/^\s*(?:[-*•·▪◦]|\d+[.)-]|[a-z][.)])\s+/i, '').trim();

  // ---------------------------------------------------------------- pantalla

  function render() {
    const root = $('#study');
    root.replaceChildren(
      el('div', { class: 'study-col study-left' }, calendarCard(), examsCard(), timerCard()),
      el('div', { class: 'study-col study-center' }, subjectsSection()),
      el('div', { class: 'study-col study-right' }, planCard(), todayCard(), goalsCard()),
    );
    refreshTimer();
  }

  // ---------- calendario

  /** Calendario de 6 semanas a partir de la actual: cubre de un vistazo toda la época de exámenes. */
  function calendarCard() {
    const now = new Date();
    const thisMonday = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -((now.getDay() + 6) % 7));
    const start = addDays(thisMonday, calShift * 7);
    const rows = 6;
    const end = addDays(start, rows * 7 - 1);
    const todayKey = keyOf(now);

    const byDate = new Map();
    for (const x of ctx.liveExams()) {
      if (!byDate.has(x.date)) byDate.set(x.date, []);
      byDate.get(x.date).push(x);
    }

    const cells = [];
    for (let i = 0; i < rows * 7; i++) {
      const d = addDays(start, i);
      const k = keyOf(d);
      const exams = byDate.get(k) || [];
      const s = exams.length ? subjectOfExam(exams[0].id) : null;
      const n = ctx.daysUntil(k);
      const cls = ['cal-day'];
      if (d.getDate() === 1) cls.push('first');
      if (k === todayKey) cls.push('today');
      if (k < todayKey) cls.push('past');
      if (exams.length) cls.push('has-exam', tone(n));
      cells.push(el('button', {
        type: 'button', class: cls.join(' '),
        style: s ? `--c:${s.color}` : null,
        title: exams.length ? exams.map((x) => x.text).join(' · ') : (k >= todayKey ? 'Añadir un examen este día' : ''),
        'aria-label': `${d.getDate()}${exams.length ? ': ' + exams.map((x) => x.text).join(', ') : ''}`,
        onclick: () => {
          if (exams.length) ctx.openExamDialog(exams[0].id);
          else if (k >= todayKey) { ctx.openExamDialog(null); $('#examDate').value = k; }
        },
      }, d.getDate() === 1 ? el('span', { class: 'cal-month' }, fmtMonth.format(d).replace('.', '')) : null,
      String(d.getDate()), exams.length > 1 ? el('span', { class: 'cal-more' }, `+${exams.length - 1}`) : null));
    }

    const go = (delta) => { calShift = delta ? calShift + delta : 0; render(); };
    return el('section', { class: 'card study-card cal-card' },
      el('header', { class: 'cal-head' },
        el('button', { type: 'button', class: 'cal-nav', 'aria-label': 'Semanas anteriores', onclick: () => go(-4) }, '‹'),
        el('button', { type: 'button', class: 'cal-title', title: calShift ? 'Volver a esta semana' : '', onclick: () => go(0) },
          `${fmtDayMonth.format(start)} – ${fmtDayMonth.format(end)}`.replace(/\./g, '')),
        el('button', { type: 'button', class: 'cal-nav', 'aria-label': 'Semanas siguientes', onclick: () => go(4) }, '›')),
      el('div', { class: 'cal-grid cal-dow', 'aria-hidden': 'true' }, ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((x) => el('span', {}, x))),
      el('div', { class: 'cal-grid' }, cells));
  }

  // ---------- próximos exámenes

  function examsCard() {
    const all = ctx.liveExams();
    const upcoming = all.filter((x) => ctx.daysUntil(x.date) >= 0);
    const done = all.length - upcoming.length;
    const rows = upcoming.map((x, i) => {
      const n = ctx.daysUntil(x.date);
      const s = subjectOfExam(x.id);
      return el('li', { class: `ex-row ${tone(n)}${i === 0 ? ' next' : ''}` },
        el('button', { type: 'button', class: 'ex-btn', onclick: () => ctx.openExamDialog(x.id), title: 'Editar examen' },
          el('span', { class: 'dot', style: `--c:${s ? s.color : 'var(--muted)'}` }),
          el('span', { class: 'ex-main' },
            el('span', { class: 'ex-name' }, x.text),
            el('span', { class: 'ex-date' }, fmtShort.format(dateOfKey(x.date)))),
          el('span', { class: 'ex-days' }, n === 0 ? 'Hoy' : n === 1 ? '1 día' : `${n} días`)));
    });
    return el('section', { class: 'card study-card exams-card' },
      el('header', { class: 'card-head' },
        el('h2', {}, 'Exámenes'),
        el('button', { type: 'button', class: 'add-btn small', 'aria-label': 'Añadir examen', title: 'Añadir examen', onclick: () => ctx.openExamDialog(null) }, '+')),
      rows.length ? el('ul', { class: 'ex-list' }, rows)
        : el('p', { class: 'empty' }, all.length ? '¡No te quedan exámenes!' : 'Añade tus exámenes con el +.'),
      done ? el('p', { class: 'muted-note' }, `${plural(done, 'examen hecho', 'exámenes hechos')} ✓`) : null);
  }

  // ---------- asignaturas

  function subjectsSection() {
    const subjects = liveSubjects();
    const unlinked = ctx.liveExams().filter((x) => ctx.daysUntil(x.date) >= 0 && !subjectOfExam(x.id));
    return el('section', { class: 'subjects-wrap' },
      el('header', { class: 'section-head' },
        el('h2', {}, 'Asignaturas'),
        el('span', { class: 'spacer' }),
        drive.status === 'on' ? el('a', {
          class: 'link-btn', href: 'https://drive.google.com/drive/search?q=' + encodeURIComponent('Planning semanal · Apuntes'),
          target: '_blank', rel: 'noopener', title: 'Abrir la carpeta de apuntes en Google Drive',
        }, 'Abrir Drive ↗') : null,
        el('button', { type: 'button', class: 'pill-btn small', onclick: () => openSubjectDialog(null) }, '+ Asignatura')),
      unlinked.length ? el('div', { class: 'banner' },
        el('span', {}, `Tienes ${plural(unlinked.length, 'examen', 'exámenes')} sin asignatura.`),
        el('button', {
          type: 'button', class: 'btn primary small', onclick: () => {
            let i = liveSubjects().length;
            for (const x of unlinked) {
              const name = x.text.replace(/^\s*examen(?:\s+(?:de|del|final))*\s+/i, '').trim() || x.text;
              addSubject({ name: name.charAt(0).toUpperCase() + name.slice(1), color: SUBJECT_COLORS[i++ % SUBJECT_COLORS.length], examId: x.id });
            }
            ctx.commit();
            toast(`${plural(unlinked.length, 'asignatura creada', 'asignaturas creadas')}. Añade ahora sus temas.`);
          },
        }, 'Crear asignaturas')) : null,
      subjects.length ? el('div', { class: 'subjects' }, subjects.map(subjectCard))
        : el('div', { class: 'study-empty' },
          el('p', {}, 'Crea una asignatura por examen y apunta sus temas.'),
          el('p', { class: 'muted-note' }, 'La app calculará cuánto llevas, a qué ritmo vas y qué toca estudiar hoy.')));
  }

  function subjectCard(s) {
    const exam = examOf(s);
    const n = exam ? ctx.daysUntil(exam.date) : null;
    const topics = topicsOf(s.id);
    const p = progressOf(topics);

    let pace = '';
    let paceCls = '';
    if (!topics.length) pace = 'Añade los temas para ver tu progreso.';
    else if (!exam) pace = 'Vincula el examen (✎) para saber qué ritmo llevar.';
    else if (n < 0) pace = 'Examen hecho ✓';
    else if (!p.units) { pace = '¡Todo repasado! 🎉'; paceCls = 'good'; }
    else if (n === 0) { pace = 'El examen es hoy. ¡Mucho ánimo!'; paceCls = 'warn'; }
    else {
      const rate = p.units / n;
      pace = `Para llegar: ${fmtNum.format(rate)} al día`;
      paceCls = rate > 2.5 ? 'warn' : rate <= 1 ? 'good' : '';
    }

    const addInput = el('input', {
      id: `topic-add-${s.id}`, placeholder: 'Añadir tema… (puedes pegar una lista)', 'aria-label': `Añadir tema a ${s.name}`,
      enterkeyhint: 'done', autocomplete: 'off',
    });
    addInput.addEventListener('paste', (e) => {
      const text = e.clipboardData.getData('text/plain');
      if (!/\n/.test(text)) return;
      e.preventDefault();
      const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
      if (!lines.length) return;
      addTopics(s.id, lines);
      ctx.focusAfter(addInput.id);
      ctx.commit();
      toast(`${plural(lines.length, 'tema añadido', 'temas añadidos')} a ${s.name}.`);
    });

    const card = el('article', { class: 'subject', style: `--c:${s.color}`, dataset: { id: s.id } },
      el('header', { class: 'subject-head' },
        el('div', { class: 'subject-title' },
          el('h3', {}, s.name),
          el('p', { class: 'subject-exam' }, exam
            ? [cap(fmtShort.format(dateOfKey(exam.date))), ' · ', el('span', { class: `chip ${tone(n)}` }, n < 0 ? 'Hecho' : n === 0 ? 'Hoy' : `${n} ${n === 1 ? 'día' : 'días'}`)]
            : 'Sin examen vinculado')),
        el('button', { type: 'button', class: 'icon-mini', title: 'Editar asignatura', 'aria-label': `Editar ${s.name}`, onclick: () => openSubjectDialog(s.id) }, '✎')),
      el('div', { class: 'subject-progress' },
        el('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': p.pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `Progreso de ${s.name}` },
          el('span', { style: `width:${p.pct}%` })),
        el('span', { class: 'pct' }, `${p.pct}%`)),
      topics.length ? el('p', { class: 'subject-stats' },
        el('span', { class: 'st st0' }, `${p.pending} pendientes`),
        el('span', { class: 'st st1' }, `${p.studied} estudiados`),
        el('span', { class: 'st st2' }, `${p.reviewed} repasados`)) : null,
      el('p', { class: `subject-pace ${paceCls}`, title: 'Cada tema cuenta dos pasos: estudiarlo y repasarlo. Esto es cuántos pasos al día necesitas hasta el examen.' }, pace),
      topics.length ? el('ul', { class: 'topics' }, topics.map(topicRow)) : null,
      el('form', {
        class: 'add-form', autocomplete: 'off',
        onsubmit: (e) => {
          e.preventDefault();
          const text = addInput.value.trim();
          if (!text) return;
          addTopics(s.id, [text]);
          addInput.value = '';
          ctx.focusAfter(addInput.id);
          ctx.commit();
        },
      }, addInput, el('button', { class: 'add-btn', 'aria-label': 'Añadir tema' }, '+')),
      filesBlock(s));

    // Arrastrar archivos encima de la tarjeta para subirlos.
    card.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      card.classList.add('drop');
    });
    card.addEventListener('dragleave', (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove('drop'); });
    card.addEventListener('drop', (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      card.classList.remove('drop');
      upload(e.dataTransfer.files, s);
    });
    return card;
  }

  function topicRow(t) {
    return el('li', { class: `topic st${t.status}` },
      el('button', {
        type: 'button', class: 'topic-st', title: `${STATUS[t.status]} · pulsa para cambiar`,
        'aria-label': `${t.text}: ${STATUS[t.status]}. Pulsa para marcar como ${STATUS[(t.status + 1) % 3].toLowerCase()}`,
        onclick: () => { updateTopic(t.id, { status: (t.status + 1) % 3 }); ctx.commit(); },
      }),
      el('button', { type: 'button', class: 'topic-text', title: 'Editar tema', onclick: () => openTopicDialog(t.id) }, t.text),
      el('span', { class: 'topic-label' }, STATUS[t.status]));
  }

  // ---------- apuntes

  function filesBlock(s) {
    const st = drive.status;
    const files = drive.filesOf(s.id);
    const uploads = drive.uploads.filter((u) => u.subjectId === s.id);
    let action;
    if (st === 'off') {
      action = el('button', { type: 'button', class: 'link-btn', onclick: ctx.openSettings }, 'Conectar Google para guardar apuntes');
    } else if (st === 'ask') {
      action = el('button', {
        type: 'button', class: 'link-btn', onclick: async () => {
          try { await drive.enable(); toast('Apuntes en Google Drive activados.'); } catch (e) { toast(e.message, { duration: 8000 }); }
        },
      }, 'Activar apuntes en Drive');
    } else {
      action = el('button', { type: 'button', class: 'link-btn', onclick: () => pickFiles(s) }, '⇪ Subir');
    }
    const folder = files.find((f) => f.folder)?.folder;
    return el('div', { class: 'files' },
      el('div', { class: 'files-head' },
        el('span', { class: 'files-title' }, `Apuntes${files.length ? ` (${files.length})` : ''}`),
        folder ? el('a', { class: 'link-btn', href: `https://drive.google.com/drive/folders/${folder}`, target: '_blank', rel: 'noopener' }, 'Carpeta ↗') : null,
        el('span', { class: 'spacer' }),
        action),
      files.length || uploads.length ? el('ul', { class: 'file-list' },
        files.map((f) => el('li', { class: 'file' },
          el('a', { class: 'file-link', href: f.link, target: '_blank', rel: 'noopener', title: `Abrir ${f.name} en Google Drive` },
            el('span', { class: 'file-ext' }, extOf(f)),
            el('span', { class: 'file-name' }, f.name)),
          el('span', { class: 'file-size' }, fmtSize(f.size)),
          el('button', {
            type: 'button', class: 'icon-mini', title: 'Mover a la papelera de Drive', 'aria-label': `Eliminar ${f.name}`,
            onclick: async () => {
              if (!confirm(`¿Mover «${f.name}» a la papelera de Google Drive? Podrás recuperarlo durante 30 días desde Drive.`)) return;
              try { await drive.trash(f, s.id); toast('Apunte movido a la papelera de Drive.'); } catch (e) { toast(e.message, { duration: 8000 }); }
            },
          }, '✕'))),
        uploads.map((u) => el('li', { class: 'file uploading', dataset: { upload: u.id } },
          el('span', { class: 'file-name' }, `Subiendo ${u.name}…`),
          el('span', { class: 'up-bar' }, el('span', { style: `width:${u.pct}%` }))))) : null,
      st === 'on' && !files.length && !uploads.length ? el('p', { class: 'drop-hint' }, 'Arrastra aquí tus PDF, fotos o documentos.') : null);
  }

  function extOf(f) {
    if (f.mimeType === 'application/pdf') return 'PDF';
    if (f.mimeType.startsWith('image/')) return 'IMG';
    if (f.mimeType.startsWith('video/')) return 'VID';
    if (f.mimeType.startsWith('audio/')) return 'AUD';
    if (f.mimeType.startsWith('application/vnd.google-apps')) return 'G';
    const m = /\.([a-z0-9]{1,4})$/i.exec(f.name);
    return m ? m[1].toUpperCase() : 'DOC';
  }

  let pickTarget = null;
  function pickFiles(s) {
    pickTarget = s;
    const input = $('#driveFileInput');
    input.value = '';
    input.click();
  }
  $('#driveFileInput').addEventListener('change', (e) => {
    if (pickTarget && e.target.files.length) upload(e.target.files, pickTarget);
  });

  async function upload(files, s) {
    if (drive.status !== 'on') { toast('Primero activa los apuntes en Google Drive.'); return; }
    try {
      const n = await drive.uploadMany(files, s);
      toast(`${plural(n, 'apunte subido', 'apuntes subidos')} a Google Drive.`);
    } catch (e) {
      toast(e.total > 1 ? `Se subieron ${e.uploaded} de ${e.total}. ${e.message}` : e.message, { duration: 9000 });
    }
  }

  // ---------- plan de hoy

  /** Qué conviene estudiar hoy: lo más urgente (trabajo pendiente / días que quedan). */
  function suggestions() {
    const out = [];
    for (const s of liveSubjects()) {
      const exam = examOf(s);
      if (!exam) continue;
      const n = ctx.daysUntil(exam.date);
      if (n < 0) continue;
      const topics = topicsOf(s.id);
      const { units } = progressOf(topics);
      if (!units) continue;
      const days = Math.max(n, 1);
      const quota = Math.min(3, Math.ceil(units / days));
      const next = [...topics.filter((t) => t.status === 0), ...topics.filter((t) => t.status === 1)].slice(0, quota);
      for (const t of next) out.push({ s, t, urgency: units / days, n });
    }
    return out.sort((a, b) => b.urgency - a.urgency).slice(0, 8);
  }

  function planCard() {
    const items = suggestions();
    const hasSubjects = liveSubjects().length > 0;
    return el('section', { class: 'card study-card plan-card' },
      el('header', { class: 'card-head' },
        el('h2', {}, 'Plan de hoy'),
        el('span', { class: 'count', title: 'Sugerencia según los temas que te quedan y los días hasta cada examen' }, items.length ? 'sugerido' : '')),
      items.length ? el('ul', { class: 'plan' }, items.map(({ s, t, n }) => el('li', { class: 'plan-row', style: `--c:${s.color}` },
        el('span', { class: `plan-act a${t.status}` }, t.status === 0 ? 'Estudiar' : 'Repasar'),
        el('span', { class: 'plan-main' },
          el('span', { class: 'plan-topic' }, t.text),
          el('span', { class: 'plan-sub' }, `${s.name} · ${n === 0 ? 'examen hoy' : n === 1 ? 'examen mañana' : `examen en ${n} días`}`)),
        el('button', {
          type: 'button', class: 'plan-done', title: t.status === 0 ? 'Marcar como estudiado' : 'Marcar como repasado',
          'aria-label': `Hecho: ${t.text}`,
          onclick: () => { updateTopic(t.id, { status: t.status + 1 }); ctx.commit(); },
        }, '✓'))))
        : el('p', { class: 'empty' }, hasSubjects
          ? 'Nada urgente: añade temas o vincula los exámenes a sus asignaturas.'
          : 'Crea tus asignaturas y sus temas: aquí verás qué toca estudiar cada día.'));
  }

  // ---------- hoy

  function todayCard() {
    const today = new Date();
    const todayKey = keyOf(today);
    const day = (today.getDay() + 6) % 7;
    const tasks = ctx.dayTasks(ctx.thisWeekKey(), day);
    const events = gcal.connected ? gcal.eventsOn(todayKey) : [];
    const input = el('input', { id: 'study-add-task', placeholder: 'Añadir tarea para hoy…', 'aria-label': 'Añadir tarea para hoy', enterkeyhint: 'done', autocomplete: 'off' });
    return el('section', { class: 'card study-card today-card' },
      el('header', { class: 'card-head' },
        el('h2', {}, 'Hoy'),
        el('span', { class: 'count' }, cap(ctx.fmtLongDay(today)))),
      events.length ? el('ul', { class: 'events' }, events.map((e) => ctx.eventRow(e, todayKey))) : null,
      tasks.length ? el('ul', { class: 'items' }, tasks.map((t) => ctx.itemRow('tasks', t)))
        : el('p', { class: 'empty' }, events.length ? 'Sin tareas para hoy.' : 'Sin tareas ni eventos hoy.'),
      el('form', {
        class: 'add-form', autocomplete: 'off',
        onsubmit: (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          ctx.addTask(day, text, ctx.thisWeekKey());
          input.value = '';
          ctx.focusAfter(input.id);
          ctx.commit();
        },
      }, input, el('button', { class: 'add-btn', 'aria-label': 'Añadir tarea' }, '+')));
  }

  function goalsCard() {
    const goals = ctx.goalsOf(ctx.thisWeekKey());
    const input = el('input', { id: 'study-add-goal', placeholder: 'Añadir objetivo…', 'aria-label': 'Añadir objetivo de la semana', enterkeyhint: 'done', autocomplete: 'off' });
    return el('section', { class: 'card study-card goals-card' },
      el('header', { class: 'card-head' },
        el('h2', {}, 'Objetivos de la semana'),
        el('span', { class: 'count' }, goals.length ? `${goals.filter((g) => g.done).length}/${goals.length}` : '')),
      goals.length ? el('ul', { class: 'items' }, goals.map((g) => ctx.itemRow('goals', g))) : el('p', { class: 'empty' }, 'Sin objetivos todavía.'),
      el('form', {
        class: 'add-form', autocomplete: 'off',
        onsubmit: (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          ctx.addGoal(text, ctx.thisWeekKey());
          input.value = '';
          ctx.focusAfter(input.id);
          ctx.commit();
        },
      }, input, el('button', { class: 'add-btn', 'aria-label': 'Añadir objetivo' }, '+')));
  }

  // ---------------------------------------------------------------- temporizador (pomodoro)

  const PRESETS = { 25: 5, 50: 10 };
  let timer = loadTimer();
  let ticker = null;

  function loadTimer() {
    let t = null;
    try { t = JSON.parse(localStorage.getItem(TIMER_KEY)); } catch { /* nada */ }
    const today = keyOf(new Date());
    t = t && typeof t === 'object' ? t : {};
    const focus = PRESETS[t.focus] ? t.focus : 25;
    return {
      focus,
      mode: t.mode === 'break' ? 'break' : 'focus',
      endsAt: Number(t.endsAt) || 0,
      left: Number(t.left) || focus * 60,
      date: today,
      count: t.date === today ? Number(t.count) || 0 : 0,
    };
  }
  const saveTimer = () => { try { localStorage.setItem(TIMER_KEY, JSON.stringify(timer)); } catch { /* ignorar */ } };
  const length = (mode) => (mode === 'focus' ? timer.focus : PRESETS[timer.focus]) * 60;
  const remaining = () => (timer.endsAt ? Math.max(0, Math.round((timer.endsAt - Date.now()) / 1000)) : timer.left);
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  function timerCard() {
    const running = !!timer.endsAt;
    return el('section', { class: `card study-card timer-card ${timer.mode}` },
      el('header', { class: 'card-head' },
        el('h2', {}, 'Temporizador'),
        el('span', { class: 'count', title: 'Sesiones de estudio completadas hoy' }, timer.count ? `🍅 ${timer.count} hoy` : '')),
      el('div', { class: 'timer-body' },
        el('div', { class: 'timer-main' },
          el('span', { class: 'timer-mode' }, timer.mode === 'focus' ? 'Estudio' : 'Descanso'),
          el('span', { class: 'timer-time', id: 'timerTime' }, mmss(remaining()))),
        el('div', { class: 'timer-actions' },
          el('button', { type: 'button', class: 'btn primary small', onclick: running ? pause : start }, running ? 'Pausa' : remaining() < length(timer.mode) ? 'Seguir' : 'Empezar'),
          el('button', { type: 'button', class: 'btn small', title: 'Reiniciar', 'aria-label': 'Reiniciar', onclick: reset }, '↺'))),
      el('div', { class: 'segmented timer-presets', role: 'group', 'aria-label': 'Duración de cada sesión de estudio (con su descanso)' },
        Object.keys(PRESETS).map((f) => el('button', {
          type: 'button', 'aria-pressed': String(timer.focus === Number(f)),
          onclick: () => { timer.focus = Number(f); timer.mode = 'focus'; timer.endsAt = 0; timer.left = length('focus'); saveTimer(); render(); },
        }, `${f} min`))));
  }

  function start() { timer.endsAt = Date.now() + remaining() * 1000; saveTimer(); render(); }
  function pause() { timer.left = remaining(); timer.endsAt = 0; saveTimer(); render(); }
  function reset() { timer.endsAt = 0; timer.mode = 'focus'; timer.left = length('focus'); saveTimer(); render(); }

  function finish() {
    const wasFocus = timer.mode === 'focus';
    if (wasFocus) timer.count++;
    timer.mode = wasFocus ? 'break' : 'focus';
    timer.endsAt = 0;
    timer.left = length(timer.mode);
    saveTimer();
    beep();
    toast(wasFocus ? '¡Sesión de estudio terminada! Tómate un descanso.' : 'Descanso terminado. ¡A por la siguiente!', { duration: 10000 });
    render();
  }

  function refreshTimer() {
    clearInterval(ticker);
    ticker = null;
    if (!timer.endsAt) { document.title = 'Planning semanal'; return; }
    const tick = () => {
      const s = remaining();
      const node = document.getElementById('timerTime');
      if (node) node.textContent = mmss(s);
      document.title = `${mmss(s)} · ${timer.mode === 'focus' ? 'Estudio' : 'Descanso'}`;
      if (s <= 0) finish();
    };
    tick();
    if (timer.endsAt) ticker = setInterval(tick, 500);
  }

  function beep() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.35, 0.7].forEach((at) => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.15, ac.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + at + 0.3);
        o.connect(g).connect(ac.destination);
        o.start(ac.currentTime + at);
        o.stop(ac.currentTime + at + 0.3);
      });
    } catch { /* sin sonido */ }
  }

  // ---------------------------------------------------------------- diálogos

  const subjectDialog = $('#subjectDialog');
  let editingSubject = null;
  let pickedColor = SUBJECT_COLORS[0];

  function openSubjectDialog(id) {
    const s = id ? S().subjects[id] : null;
    editingSubject = id;
    pickedColor = s ? s.color : SUBJECT_COLORS[liveSubjects().length % SUBJECT_COLORS.length];
    $('#subjectDialogTitle').textContent = s ? 'Editar asignatura' : 'Nueva asignatura';
    $('#subjectName').value = s ? s.name : '';
    $('#subjectDelete').hidden = !s;
    const paint = () => $('#subjectColors').replaceChildren(...SUBJECT_COLORS.map((c) => el('button', {
      type: 'button', class: 'swatch', style: `--c:${c}`, 'aria-label': `Color ${c}`, 'aria-pressed': String(c === pickedColor),
      onclick: () => { pickedColor = c; paint(); },
    })));
    paint();
    const sel = $('#subjectExam');
    sel.replaceChildren(
      el('option', { value: '' }, 'Sin examen'),
      ...ctx.liveExams().map((x) => {
        const other = subjectOfExam(x.id);
        return el('option', { value: x.id }, `${x.text} · ${fmtShort.format(dateOfKey(x.date))}${other && other.id !== id ? ` (ya en ${other.name})` : ''}`);
      }));
    sel.value = s?.examId && S().exams[s.examId] ? s.examId : '';
    subjectDialog.showModal();
    if (matchMedia('(pointer: fine)').matches) $('#subjectName').focus();
  }

  $('#subjectName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if ($('#subjectForm').reportValidity()) subjectDialog.close('save'); }
  });

  subjectDialog.addEventListener('close', () => {
    const action = subjectDialog.returnValue;
    subjectDialog.returnValue = '';
    const id = editingSubject;
    editingSubject = null;
    const name = $('#subjectName').value.trim();
    const examId = $('#subjectExam').value || null;
    if (action === 'delete' && id) {
      const s = S().subjects[id];
      const n = topicsOf(id).length;
      if (!confirm(`¿Eliminar «${s.name}»${n ? ` y sus ${n} temas` : ''}? Los apuntes de Drive no se borran.`)) return;
      updateSubject(id, { deleted: true, name: '' });
      for (const t of topicsOf(id)) updateTopic(t.id, { deleted: true, text: '' });
      ctx.commit();
      toast('Asignatura eliminada.');
    } else if (action === 'save' && name) {
      if (id) updateSubject(id, { name, color: pickedColor, examId });
      else addSubject({ name, color: pickedColor, examId });
      ctx.commit();
    } else ctx.renderIfPending();
  });

  const topicDialog = $('#topicDialog');
  let editingTopic = null;
  let pickedStatus = 0;

  function openTopicDialog(id) {
    const t = S().topics[id];
    if (!t || t.deleted) return;
    editingTopic = id;
    pickedStatus = t.status;
    $('#topicText').value = t.text;
    const paint = () => $('#topicStatus').replaceChildren(...STATUS.map((label, i) => el('button', {
      type: 'button', 'aria-pressed': String(i === pickedStatus), onclick: () => { pickedStatus = i; paint(); },
    }, label)));
    paint();
    topicDialog.showModal();
    if (matchMedia('(pointer: fine)').matches) $('#topicText').focus();
  }

  $('#topicText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if ($('#topicForm').reportValidity()) topicDialog.close('save'); }
  });

  topicDialog.addEventListener('close', () => {
    const action = topicDialog.returnValue;
    topicDialog.returnValue = '';
    const id = editingTopic;
    editingTopic = null;
    const text = $('#topicText').value.trim();
    if (!id) return;
    if (action === 'delete') { updateTopic(id, { deleted: true, text: '' }); ctx.commit(); toast('Tema eliminado.'); }
    else if (action === 'save' && text) { updateTopic(id, { text, status: pickedStatus }); ctx.commit(); }
    else ctx.renderIfPending();
  });

  return { render, refreshTimer };
}
