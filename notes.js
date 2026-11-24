// Editor de notas con formato (estilo «Notas» de Apple): título, negrita, cursiva,
// tachado, lista, lista de tareas (con casillas) y secciones desplegables.
//
// Se guarda como HTML limpio en `notes.html` (y el texto sin formato en `notes.text`).
// Las notas antiguas, que solo tienen texto, se muestran igual y se convierten al editarlas.
// Todo el HTML se pasa por `sanitize` antes de mostrarse: solo se admiten unas pocas
// etiquetas y clases, así que un contenido raro (p. ej. llegado por la sincronización)
// no puede ejecutar nada.

const OK_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'S', 'STRIKE', 'DEL', 'U', 'H2', 'H3', 'P', 'DIV', 'BR', 'UL', 'OL', 'LI']);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'SVG', 'MATH']);
const OK_CLASSES = new Set(['nt-todo', 'nt-fold', 'nt-fold-head', 'nt-fold-body']);

function cleanInto(src, dst) {
  for (const node of src.childNodes) {
    if (node.nodeType === 3) { dst.append(document.createTextNode(node.textContent)); continue; }
    if (node.nodeType !== 1 || DROP_TAGS.has(node.tagName)) continue;
    if (!OK_TAGS.has(node.tagName)) { cleanInto(node, dst); continue; } // etiqueta desconocida: se queda su texto
    const out = document.createElement(node.tagName.toLowerCase());
    const classes = [...node.classList].filter((c) => OK_CLASSES.has(c));
    if (classes.length) out.className = classes.join(' ');
    if (node.getAttribute('data-done') === '1') out.setAttribute('data-done', '1');
    if (node.getAttribute('data-open') === '0') out.setAttribute('data-open', '0');
    cleanInto(node, out);
    dst.append(out);
  }
}

export function sanitize(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html'); // documento inerte
  const box = document.createElement('div');
  cleanInto(doc.body, box);
  return box.innerHTML;
}

const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML para mostrar una nota: la enriquecida o, si es antigua, el texto con sus saltos de línea. */
export function notesToHtml(notes) {
  if (typeof notes.html === 'string' && notes.html) return sanitize(notes.html);
  if (!notes.text) return '';
  return notes.text.split('\n').map((l) => `<div>${l ? escapeHtml(l) : '<br>'}</div>`).join('');
}

const BLOCKS = 'LI, P, DIV, H2, H3';

export class NoteEditor {
  /**
   * @param {HTMLElement} ed  el div editable
   * @param {HTMLElement} bar la barra de botones (con data-cmd)
   * @param {{ onChange: () => void }} opts
   */
  constructor(ed, bar, { onChange }) {
    this.ed = ed;
    this.bar = bar;
    this.onChange = onChange;
    this.sig = null;
    try { document.execCommand('defaultParagraphSeparator', false, 'div'); document.execCommand('styleWithCSS', false, false); } catch { /* ignorar */ }

    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // no perder la selección
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-cmd]');
      if (!b) return;
      this.ed.focus();
      this.run(b.dataset.cmd);
      this.changed();
      this.refreshBar();
    });

    ed.addEventListener('input', (e) => { this.wrapRoot(); this.shortcuts(e); this.changed(); });
    ed.addEventListener('focus', () => { if (!ed.firstChild || ed.innerHTML === '<br>') { ed.innerHTML = '<div><br></div>'; this.caret(ed.firstChild); } });
    ed.addEventListener('keydown', (e) => this.keydown(e));
    ed.addEventListener('click', (e) => this.click(e));
    ed.addEventListener('paste', (e) => {
      e.preventDefault(); // siempre como texto: sin formatos ni código raro
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    ed.addEventListener('drop', (e) => {
      e.preventDefault();
      const t = e.dataTransfer.getData('text/plain');
      if (t) { ed.focus(); document.execCommand('insertText', false, t); }
    });
    document.addEventListener('selectionchange', () => { if (ed.contains(getSelection().anchorNode)) this.refreshBar(); });
  }

  // ---------- contenido

  /** Pone el contenido (si no ha cambiado, no toca nada, para no mover el cursor). */
  setHtml(html) {
    if (html === this.sig) return;
    this.sig = html;
    this.ed.innerHTML = html;
    this.updateEmpty();
  }

  /** { html, text } listos para guardar. */
  content() {
    const text = this.ed.innerText.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const html = text ? sanitize(this.ed.innerHTML) : '';
    this.sig = html;
    return { html, text };
  }

  updateEmpty() {
    this.ed.classList.toggle('is-empty', !this.ed.textContent.trim() && !this.ed.querySelector('li, .nt-fold'));
  }

  changed() { this.updateEmpty(); this.onChange(); }

  /** Si hay texto suelto en la raíz del editor (sin línea propia), lo mete en una línea. */
  wrapRoot() {
    const loose = [...this.ed.childNodes].some((n) => (n.nodeType === 3 && n.textContent !== '')
      || (n.nodeType === 1 && !n.matches('div, p, h2, h3, ul, ol')));
    if (loose) document.execCommand('formatBlock', false, '<div>');
  }

  // ---------- ayudas de selección

  closest(selector) {
    const n = getSelection().anchorNode;
    const el = n && (n.nodeType === 3 ? n.parentElement : n);
    const m = el && el.closest(selector);
    return m && this.ed.contains(m) ? m : null;
  }

  caret(node, atEnd = false) {
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(!atEnd);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  // ---------- acciones de la barra

  run(cmd) {
    const keep = (cmd === 'bullet' || cmd === 'check' || cmd === 'title') ? this.saveCaret() : null;
    this.exec(cmd);
    if (keep != null) this.restoreCaret(keep);
  }

  exec(cmd) {
    const d = document;
    if (cmd === 'bold' || cmd === 'italic') d.execCommand(cmd);
    else if (cmd === 'strike') d.execCommand('strikeThrough');
    else if (cmd === 'title') d.execCommand('formatBlock', false, this.closest('h2') ? '<div>' : '<h2>');
    else if (cmd === 'bullet') this.bullet();
    else if (cmd === 'check') this.checklist();
    else if (cmd === 'fold') this.fold();
  }

  /** Elementos de lista que toca la selección. */
  selectedItems() {
    const s = getSelection();
    if (!s.rangeCount) return [];
    const r = s.getRangeAt(0);
    return [...this.ed.querySelectorAll('li')].filter((li) => r.intersectsNode(li));
  }

  bullet() {
    const items = this.selectedItems();
    if (items.length && items.every((li) => li.classList.contains('nt-todo'))) { this.untodo(items); return; } // tareas → viñetas
    document.execCommand('insertUnorderedList');
  }

  checklist() {
    let items = this.selectedItems();
    if (items.length && items.every((li) => li.classList.contains('nt-todo'))) { document.execCommand('insertUnorderedList'); return; } // quita la lista
    if (!items.length) { document.execCommand('insertUnorderedList'); items = this.selectedItems(); }
    for (const li of items) li.classList.add('nt-todo');
  }

  untodo(items) {
    for (const li of items) { li.classList.remove('nt-todo'); li.removeAttribute('data-done'); if (!li.className) li.removeAttribute('class'); }
  }

  blockOf(node) {
    const el = node && (node.nodeType === 3 ? node.parentElement : node);
    const b = el && el.closest('li, p, div, h2, h3');
    return b && b !== this.ed && this.ed.contains(b) ? b : null;
  }

  /** Posición del cursor dentro de su línea (en caracteres), para volver a ella tras cambiar el tipo de línea. */
  saveCaret() {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return null;
    const block = this.blockOf(s.anchorNode);
    if (!block) return null;
    const r = document.createRange();
    r.selectNodeContents(block);
    r.setEnd(s.anchorNode, s.anchorOffset);
    return r.toString().length;
  }

  restoreCaret(offset) {
    const block = this.blockOf(getSelection().anchorNode);
    if (!block) return;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let left = offset;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (left <= n.textContent.length) {
        const r = document.createRange();
        r.setStart(n, left);
        r.collapse(true);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return;
      }
      left -= n.textContent.length;
    }
  }

  fold() {
    const selected = getSelection().toString().trim();
    const head = escapeHtml(selected || 'Título de la sección');
    document.execCommand('insertHTML', false,
      `<div class="nt-fold" data-new="1"><div class="nt-fold-head">${head}</div><div class="nt-fold-body"><br></div></div><div><br></div>`);
    const f = this.ed.querySelector('.nt-fold[data-new]');
    if (!f) return;
    f.removeAttribute('data-new');
    const h = f.querySelector('.nt-fold-head');
    const r = document.createRange();
    r.selectNodeContents(h); // el título queda seleccionado para escribir encima
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  refreshBar() {
    const on = {
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      strike: document.queryCommandState('strikeThrough'),
      title: !!this.closest('h2'),
      bullet: !!this.closest('li:not(.nt-todo)'),
      check: !!this.closest('li.nt-todo'),
      fold: !!this.closest('.nt-fold'),
    };
    for (const b of this.bar.querySelectorAll('button[data-cmd]')) b.setAttribute('aria-pressed', on[b.dataset.cmd] ? 'true' : 'false');
  }

  // ---------- teclado y ratón

  /** «- » → lista, «[] » → tareas, «# » → título, al empezar una línea. */
  shortcuts(e) {
    if (e.inputType !== 'insertText' || e.data !== ' ') return;
    const n = getSelection().anchorNode;
    if (!n || n.nodeType !== 3) return;
    const t = n.textContent.replace(/ /g, ' ');
    const block = n.parentElement.closest(BLOCKS);
    if (!block || block === this.ed || block.textContent.replace(/ /g, ' ') !== t) return; // solo si es lo único de la línea
    let cmd = null;
    if (/^[-*] $/.test(t)) cmd = 'bullet';
    else if (/^\[\s?\] $/.test(t)) cmd = 'check';
    else if (/^# $/.test(t)) cmd = 'title';
    if (!cmd) return;
    const r = document.createRange();
    r.selectNodeContents(n);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.execCommand('delete'); // borra «- » dejando el cursor en la línea vacía
    this.run(cmd);
  }

  keydown(e) {
    if (e.key === 'Backspace') { // título vacío de un desplegable sin contenido: se elimina entero
      const head = this.closest('.nt-fold-head');
      if (head && !head.textContent.trim() && !head.parentElement.querySelector('.nt-fold-body').textContent.trim()) {
        e.preventDefault();
        const fold = head.parentElement;
        const prev = fold.previousElementSibling;
        fold.remove();
        if (prev) this.caret(prev, true);
        this.changed();
      }
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    const head = this.closest('.nt-fold-head');
    if (head) { // Intro en el título de un desplegable: pasa al contenido
      e.preventDefault();
      head.parentElement.removeAttribute('data-open');
      this.caret(head.parentElement.querySelector('.nt-fold-body'));
      this.changed();
      return;
    }
    const li = this.closest('li');
    if (li && li.classList.contains('nt-todo') && li.textContent.trim()) {
      setTimeout(() => { // el elemento nuevo nace sin marcar
        const now = this.closest('li');
        if (now && now !== li) now.removeAttribute('data-done');
        this.changed();
      }, 0);
    }
  }

  click(e) {
    const x = e.clientX;
    const li = e.target.closest('li');
    if (li && this.ed.contains(li) && li.classList.contains('nt-todo') && x - li.getBoundingClientRect().left < 28) {
      e.preventDefault();
      if (li.getAttribute('data-done') === '1') li.removeAttribute('data-done'); else li.setAttribute('data-done', '1');
      this.changed();
      return;
    }
    const head = e.target.closest('.nt-fold-head');
    if (head && this.ed.contains(head) && head.getBoundingClientRect().right - x < 30) { // ✕: eliminar el desplegable
      e.preventDefault();
      const fold = head.parentElement;
      const hasContent = fold.querySelector('.nt-fold-body').textContent.trim() !== '';
      if (hasContent && !confirm('¿Eliminar este desplegable y todo lo que tiene dentro?')) return;
      fold.remove();
      this.changed();
      return;
    }
    if (head && this.ed.contains(head) && x - head.getBoundingClientRect().left < 26) {
      e.preventDefault();
      const f = head.parentElement;
      if (f.getAttribute('data-open') === '0') f.removeAttribute('data-open'); else f.setAttribute('data-open', '0');
      this.changed();
    }
  }
}
