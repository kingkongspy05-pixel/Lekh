/* =====================================================================
   Lekh — a personal word processor for the browser
   Storage: IndexedDB (local) · Sync: tabs via BroadcastChannel,
   devices via a secret GitHub Gist.
   ===================================================================== */
(() => {
'use strict';

/* ---------------------------------------------------------------- utils */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TAB_ID = uid('t');
const GIST_DESC = 'Lekh documents (sync) — do not edit by hand';
const editor = $('#editor'), page = $('#page'), pageWrap = $('#pageWrap'), canvas = $('#canvas');
const hdr = $('#hdr'), ftr = $('#ftr');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24); if (d < 7) return d + ' d ago';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
const fmtTime = t => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const safeName = t => (String(t || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').trim() || 'document').slice(0, 120);

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function libReady(name, label) {
  for (let i = 0; i < 150 && !window[name]; i++) await sleep(100);
  if (!window[name]) throw new Error(`Couldn't load ${label || name}. Check your internet connection and reload.`);
  return window[name];
}

/* --------------------------------------------------------------- settings */
const settings = Object.assign({
  author: 'Me', theme: 'system', zoom: 100, pageView: 'pages', ruler: true, units: 'in', spell: true, gistId: '', login: '', lastSync: 0, markup: true
}, safeJSON(localStorage.getItem('lekh.settings')) || {});
function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function saveSettings() { try { localStorage.setItem('lekh.settings', JSON.stringify(settings)); } catch {} }
const me = () => (settings.author || 'Me').trim() || 'Me';

/* -------------------------------------------------------------- IndexedDB */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('lekh', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('docs', { keyPath: 'id' }); d.createObjectStore('kv'); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const s = t.objectStore(store); let out;
      const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  all() { return this.tx('docs', 'readonly', s => s.getAll()); },
  get(id) { return this.tx('docs', 'readonly', s => s.get(id)); },
  put(d) { return this.tx('docs', 'readwrite', s => s.put(d)); },
  del(id) { return this.tx('docs', 'readwrite', s => s.delete(id)); },
  kvGet(k) { return this.tx('kv', 'readonly', s => s.get(k)); },
  kvSet(k, v) { return this.tx('kv', 'readwrite', s => s.put(v, k)); },
  clear() { return Promise.all([this.tx('docs', 'readwrite', s => s.clear()), this.tx('kv', 'readwrite', s => s.clear())]); }
};

/* ------------------------------------------------------------- sanitizing */
const SANITIZE = {
  ADD_ATTR: ['contenteditable', 'target'],
  FORBID_TAGS: ['style', 'script', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'meta', 'link', 'title', 'base'],
  ALLOW_DATA_ATTR: true
};
function sanitize(html) {
  if (!window.DOMPurify) return String(html || '');
  return DOMPurify.sanitize(String(html || ''), SANITIZE);
}

/* ------------------------------------------------------------------ state */
let docs = new Map();
let cur = null;
let saveTimer = null, pendingSave = false, lastRange = null, forcePlain = false;
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('lekh') : null;
const post = msg => { try { bc && bc.postMessage({ ...msg, tab: TAB_ID }); } catch {} };

const PAGE_SIZES = { A4: [8.27, 11.69], Letter: [8.5, 11], Legal: [8.5, 14], A5: [5.83, 8.27] };
const MARGINS = {
  normal: { t: 1, r: 1, b: 1, l: 1 }, narrow: { t: 0.5, r: 0.5, b: 0.5, l: 0.5 },
  moderate: { t: 1, r: 0.75, b: 1, l: 0.75 }, wide: { t: 1, r: 2, b: 1, l: 2 }
};
const FONTS = [
  ['Calibri', 'Calibri, Carlito, sans-serif'], ['Arial', 'Arial, Helvetica, sans-serif'],
  ['Times New Roman', "'Times New Roman', Times, serif"], ['Georgia', 'Georgia, serif'],
  ['Cambria', 'Cambria, Georgia, serif'], ['Garamond', "'EB Garamond', Garamond, serif"],
  ['Verdana', 'Verdana, Geneva, sans-serif'], ['Tahoma', 'Tahoma, Verdana, sans-serif'],
  ['Courier New', "'Courier New', Courier, monospace"], ['Inter', 'Inter, sans-serif'], ['Lora', 'Lora, serif'],
  ['Merriweather', 'Merriweather, serif'], ['Roboto', 'Roboto, sans-serif'], ['Roboto Mono', "'Roboto Mono', monospace"],
  ['Noto Sans Devanagari', "'Noto Sans Devanagari', sans-serif"], ['Noto Serif Devanagari', "'Noto Serif Devanagari', serif"]
];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];

function normalizeDoc(d) {
  d.title = d.title || 'Untitled document';
  d.html = d.html ?? '<p><br></p>';
  d.header = d.header || ''; d.footer = d.footer || '';
  d.page = d.page || {};
  d.page.size = PAGE_SIZES[d.page.size] || (d.page.size === 'Custom' && d.page.w && d.page.h) ? d.page.size : 'A4';
  d.page.orient = d.page.orient === 'landscape' ? 'landscape' : 'portrait';
  d.page.margins = Object.assign({ t: 1, r: 1, b: 1, l: 1 }, d.page.margins || {});
  d.comments = Array.isArray(d.comments) ? d.comments : [];
  d.versions = Array.isArray(d.versions) ? d.versions : [];
  d.track = !!d.track;
  d.createdAt = d.createdAt || Date.now(); d.updatedAt = d.updatedAt || Date.now();
  d.ver = d.ver || uid('v');
  return d;
}
function makeDoc(t = {}) {
  const now = Date.now();
  const d = normalizeDoc({
    id: uid('d'), title: t.title || 'Untitled document', html: (t.html || '<p><br></p>').trim(),
    header: t.header || '', footer: t.footer || '',
    page: { size: t.page?.size || 'A4', orient: t.page?.orient || 'portrait', margins: { ...(t.page?.margins || MARGINS.normal) }, ...(t.page?.w ? { w: t.page.w, h: t.page.h } : {}), ...(t.page?.valign ? { valign: t.page.valign } : {}) },
    comments: [], versions: [], track: false, createdAt: now, updatedAt: now, ver: uid('v'),
    dirty: true, vDirty: false, base: null, deleted: false
  });
  if (settings.defaultStyles && !t.noDefaults) d.styles = JSON.parse(JSON.stringify(settings.defaultStyles));
  return d;
}
function touch(d) { d.updatedAt = Date.now(); d.ver = uid('v'); d.dirty = true; }

/* ------------------------------------------------------------ UI helpers */
function icons() { try { lucide.createIcons({ attrs: { 'aria-hidden': 'true' } }); } catch {} }
function toast(msg, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (opts.err ? ' err' : ''); el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), opts.ms || (opts.err ? 6000 : 2800));
}

/* modal */
let modalResolve = null;
function modal({ title, body, buttons = [{ label: 'OK', primary: true, value: true }], wide = false, onOpen }) {
  const m = $('#modal');
  m.className = 'modal' + (wide ? ' wide' : '');
  m.innerHTML = `<div class="modal-head">${esc(title)}<div class="spacer"></div><button class="icon-btn" data-mclose title="Close"><i data-lucide="x"></i></button></div>
    <div class="modal-body"></div><div class="modal-foot"></div>`;
  const b = $('.modal-body', m);
  if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
  const foot = $('.modal-foot', m);
  if (!buttons.length) foot.remove();
  buttons.forEach(bt => {
    const el = document.createElement('button');
    el.className = 'btn ' + (bt.primary ? 'primary' : bt.danger ? 'outline danger' : 'outline');
    el.textContent = bt.label;
    el.onclick = async () => {
      if (bt.onClick) { const r = await bt.onClick(m); if (r === false) return; }
      closeModal(bt.value === undefined ? true : (typeof bt.value === 'function' ? bt.value(m) : bt.value));
    };
    foot.appendChild(el);
  });
  $('[data-mclose]', m).onclick = () => closeModal(null);
  $('#overlay').classList.add('show');
  icons();
  onOpen && onOpen(m);
  setTimeout(() => { const f = $('input:not([type=hidden]), textarea, select', b); f && f.focus(); f && f.select && f.type !== 'file' && f.select(); }, 30);
  return new Promise(res => { modalResolve = res; });
}
function closeModal(v) {
  $('#overlay').classList.remove('show');
  const r = modalResolve; modalResolve = null; r && r(v);
}
$('#overlay').addEventListener('mousedown', e => { if (e.target.id === 'overlay') closeModal(null); });

async function promptDialog(title, fields, okLabel = 'OK', extraHTML = '') {
  const form = document.createElement('form');
  form.innerHTML = extraHTML + fields.map(f => `<div class="field"><label for="pf_${f.name}">${esc(f.label)}</label>
    ${f.type === 'textarea' ? `<textarea id="pf_${f.name}" name="${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
      : f.type === 'select' ? `<select id="pf_${f.name}" name="${f.name}">${f.options.map(o => `<option value="${esc(o[0])}" ${o[0] === f.value ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`
      : `<input id="pf_${f.name}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.step ? `step="${f.step}"` : ''} autocomplete="off">`}
    ${f.hint ? `<div class="hint">${f.hint}</div>` : ''}</div>`).join('');
  const read = () => Object.fromEntries(fields.map(f => [f.name, $(`[name="${f.name}"]`, form).value]));
  form.onsubmit = e => { e.preventDefault(); closeModal(read()); };
  form.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); closeModal(read()); } });
  return modal({ title, body: form, buttons: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, value: read }] });
}
const confirmDialog = (title, message, okLabel = 'OK', danger = false) =>
  modal({ title, body: `<p class="hint" style="font-size:14px;color:var(--text)">${message}</p>`, buttons: [{ label: 'Cancel', value: false }, { label: okLabel, primary: !danger, danger, value: true }] });

/* context menu */
const menuEl = $('#menu');
function showMenu(anchor, items, opts = {}) {
  menuEl.innerHTML = '';
  for (const it of items) {
    if (it === 'sep') { menuEl.appendChild(document.createElement('hr')); continue; }
    if (it.header) { const l = document.createElement('div'); l.className = 'label'; l.textContent = it.header; menuEl.appendChild(l); continue; }
    if (it.node) { menuEl.appendChild(it.node); continue; }
    const b = document.createElement('button');
    b.innerHTML = `${it.icon ? `<i data-lucide="${it.icon}"></i>` : '<span style="width:18px"></span>'}<span>${esc(it.label)}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ''}`;
    if (it.danger) b.style.color = 'var(--danger)';
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => { hideMenu(); it.act(); };
    menuEl.appendChild(b);
  }
  menuEl.classList.add('show'); icons();
  const r = anchor.getBoundingClientRect(); const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  let left = opts.right ? r.right - mw : r.left, top = r.bottom + 4;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menuEl.style.left = clamp(left, 8, innerWidth - mw - 8) + 'px';
  menuEl.style.top = clamp(top, 8, innerHeight - mh - 8) + 'px';
}
function hideMenu() { menuEl.classList.remove('show'); }
document.addEventListener('mousedown', e => { if (!menuEl.contains(e.target)) hideMenu(); }, true);

/* ------------------------------------------------------------ selection */
function inEditor(n) { return !!n && editor.contains(n.nodeType === 1 ? n : n.parentNode); }
function selRange() {
  const s = getSelection();
  if (s.rangeCount && inEditor(s.anchorNode)) return s.getRangeAt(0);
  return null;
}
function setRange(r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
function restoreSel() {
  if (document.activeElement !== editor) editor.focus({ preventScroll: true });
  if (!selRange() && lastRange && editor.contains(lastRange.startContainer)) setRange(lastRange);
}
function selNode() { const r = selRange() || lastRange; return r ? r.startContainer : null; }
function closestEl(node, sel) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const f = el && el.closest(sel);
  return f && editor.contains(f) ? f : null;
}
function placeCaretAtEnd(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); setRange(r);
}
const BLOCK_RE = /^(P|H[1-6]|LI|BLOCKQUOTE|PRE)$/;
function blockOf(n) {
  while (n && n !== editor) {
    if (n.nodeType === 1 && (BLOCK_RE.test(n.tagName) || (n.tagName === 'DIV' && n.parentNode === editor))) return n;
    n = n.parentNode;
  }
  return null;
}
function getSelectedBlocks() {
  const r = selRange() || lastRange; if (!r) return [];
  const set = new Set(); const sb = blockOf(r.startContainer); if (sb) set.add(sb);
  if (!r.collapsed) {
    const w = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT); let n;
    while ((n = w.nextNode())) if (BLOCK_RE.test(n.tagName) && r.intersectsNode(n)) set.add(n);
  }
  const eb = blockOf(r.endContainer); if (eb) set.add(eb);
  return [...set].filter(b => !b.querySelector('p,h1,h2,h3,h4,h5,h6,li') || b.tagName === 'LI');
}
function nodePath(node) {
  const p = [];
  while (node && node !== editor) { const par = node.parentNode; if (!par) return null; p.unshift([...par.childNodes].indexOf(node)); node = par; }
  return node === editor ? p : null;
}
function fromPath(p) { let n = editor; for (const i of p || []) { n = n.childNodes[i]; if (!n) return null; } return n; }
function saveSelPath() {
  const r = selRange(); if (!r) return null;
  return { s: nodePath(r.startContainer), so: r.startOffset, e: nodePath(r.endContainer), eo: r.endOffset };
}
function restoreSelPath(sp) {
  if (!sp) return;
  try {
    const s = fromPath(sp.s), e = fromPath(sp.e); if (!s || !e) return;
    const len = n => n.nodeType === 3 ? n.length : n.childNodes.length;
    const r = document.createRange(); r.setStart(s, Math.min(sp.so, len(s))); r.setEnd(e, Math.min(sp.eo, len(e)));
    editor.focus({ preventScroll: true }); setRange(r);
  } catch {}
}

/* ------------------------------------------------------------- history */
const History = {
  stack: [], redo: [], last: 0, lastType: '',
  push(type = 'op', force = false) {
    if (!cur) return;
    const now = Date.now();
    if (!force && type === this.lastType && now - this.last < 1200) { this.last = now; return; }
    this.stack.push({ html: editor.innerHTML, sel: saveSelPath() });
    const cap = editor.innerHTML.length > 1e6 ? 20 : 120;
    while (this.stack.length > cap) this.stack.shift();
    this.redo = []; this.last = now; this.lastType = type;
  },
  undo() {
    const s = this.stack.pop(); if (!s) { toast('Nothing to undo'); return; }
    this.redo.push({ html: editor.innerHTML, sel: saveSelPath() });
    editor.innerHTML = s.html; restoreSelPath(s.sel); this.lastType = ''; afterDomChange();
  },
  redoOp() {
    const s = this.redo.pop(); if (!s) return;
    this.stack.push({ html: editor.innerHTML, sel: saveSelPath() });
    editor.innerHTML = s.html; restoreSelPath(s.sel); this.lastType = ''; afterDomChange();
  },
  clear() { this.stack = []; this.redo = []; this.lastType = ''; }
};
function afterDomChange() { markChanged(); updateToolbar(); hideFloatbars(); if (panelMode) renderPanel(); }

/* ======================================================= document loading */
async function loadAll() {
  const all = await DB.all();
  docs = new Map(all.map(d => [d.id, normalizeDoc(d)]));
  if (cur) cur = docs.get(cur.id) || null;
}
function liveDocs() { return [...docs.values()].filter(d => !d.deleted && !d.purged); }

async function openDoc(id, { keepScroll = false } = {}) {
  if (cur && pendingSave) await saveNow();
  const d = docs.get(id); if (!d || d.purged) return;
  if (d.deleted) { d.deleted = false; touch(d); await DB.put(d); }
  const changingDoc = !cur || cur.id !== id;
  cur = d;
  if (changingDoc) { History.clear(); Find.clear(); MM.preview = false; MM.idx = 0; }
  renderCurrent({ keepScroll: keepScroll && !changingDoc, force: true });
  history.replaceState(null, '', '#doc=' + id);
  try { localStorage.setItem('lekh.lastDoc', id); } catch {}
  renderDocList();
  if (innerWidth < 860) $('#sidebar').classList.add('closed');
}

function renderCurrent({ keepScroll = true, force = false } = {}) {
  if (!cur) return;
  const top = canvas.scrollTop;
  const html = sanitize(cur.html);
  if (force || editor.innerHTML !== html) editor.innerHTML = html || '<p><br></p>';
  if (document.activeElement !== $('#docTitle')) $('#docTitle').value = cur.title === 'Untitled document' ? '' : cur.title;
  if (document.activeElement !== hdr) hdr.innerText = cur.header || '';
  if (document.activeElement !== ftr) ftr.innerText = cur.footer || '';
  document.title = (cur.title || 'Untitled') + ' — Lekh';
  updateTOCs(true); applyTrackUI(); mmApply(); applyDocStyles(); applyPage(); Nav.render();
  if (keepScroll) canvas.scrollTop = top; else canvas.scrollTop = 0;
  scheduleStats();
  if (panelMode) renderPanel();
}

/* ============================================================= saving */
function markChanged() {
  if (!cur) return;
  pendingSave = true; setSaveStatus('Editing…');
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 600); Nav.schedule();
  scheduleStats(); scheduleGuides();
}
function cleanHTML() {
  const cs = $$('.cell-sel', editor), ms = $$('.multi-sel', editor);
  cs.forEach(el => el.classList.remove('cell-sel')); ms.forEach(el => el.classList.remove('multi-sel'));
  const t = $$('.img-selected, .cmt.active, .tc.flash', editor);
  t.forEach(el => el.classList.remove('img-selected', 'active', 'flash'));
  $$('[data-mk]', editor).forEach(m => m.remove());
  const h = editor.innerHTML;
  t.forEach(el => el.classList.add(el.tagName === 'IMG' ? 'img-selected' : el.classList.contains('cmt') ? 'active' : 'flash'));
  cs.forEach(el => el.classList.add('cell-sel')); ms.forEach(el => el.classList.add('multi-sel'));
  return h.replace(/<(span|div) class="pg-gap"[^>]*><\/\1>/g, '').replace(/<tr class="pg-gap"[^>]*>[\s\S]*?<\/tr>/g, '')
    .replace(/ cols-flow/g, '').replace(/(<span class="mf"[^>]*?) data-v="[^"]*"/g, '$1').replace(/ class=""/g, '');
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!cur || !pendingSave) return;
  pendingSave = false;
  if (editor.querySelector('.toc')) updateTOCs(true);
  cur.html = cleanHTML(); cur.pristine = false;
  cur.header = hdr.innerText.replace(/\n+$/, '');
  cur.footer = ftr.innerText.replace(/\n+$/, '');
  touch(cur);
  maybeAutoVersion();
  await persist(cur);
  setSaveStatus('Saved');
}
async function persist(d) {
  try {
    const fresh = await DB.get(d.id);           // keep sync bookkeeping written by other tabs
    if (fresh) { d.base = fresh.base ?? d.base; d.vSynced = fresh.vSynced || d.vSynced; }
    await DB.put(d);
  } catch (e) { toast('Could not save locally: ' + e.message, { err: true }); return; }
  post({ type: 'saved', id: d.id });
  renderDocList(); Sync.schedule();
}
async function commitMeta(d = cur) { if (!d) return; touch(d); await persist(d); }
let saveStatusT = null;
function setSaveStatus(s) {
  $('#stSave').textContent = s;
  clearTimeout(saveStatusT);
  if (s === 'Saved') saveStatusT = setTimeout(() => { $('#stSave').textContent = 'All changes saved'; }, 1500);
  Sync.pill();
}

/* versions */
function maybeAutoVersion() {
  const autos = cur.versions.filter(v => v.auto);
  const lastAuto = autos[0]?.time || 0;
  if (Date.now() - lastAuto < 10 * 60e3) return;
  if (cur.versions[0] && cur.versions[0].html === cur.html) return;
  addVersion(cur, 'Auto-saved', true);
}
function addVersion(d, name, auto) {
  d.versions.unshift({ id: uid('v'), time: Date.now(), name, html: d.html, header: d.header, footer: d.footer, auto, author: me() });
  let a = 0, n = 0;
  d.versions = d.versions.filter(v => v.auto ? ++a <= 15 : ++n <= 30);
  d.vDirty = true;
}

/* ============================================================ the page */
function pageDims(d = cur) {
  let [w, h] = d.page.size === 'Custom' ? [d.page.w || 8.27, d.page.h || 11.69] : (PAGE_SIZES[d.page.size] || PAGE_SIZES.A4);
  if (d.page.orient === 'landscape') [w, h] = [h, w];
  return { w, h };
}
function portraitDims(d) { return d.page.size === 'Custom' ? [d.page.w || 8.27, d.page.h || 11.69] : (PAGE_SIZES[d.page.size] || PAGE_SIZES.A4); }
function applyPage() {
  const { w, h } = pageDims(); const m = cur.page.margins;
  page.style.width = w + 'in';
  page.style.padding = `${m.t}in ${m.r}in ${m.b}in ${m.l}in`;
  $('#pageHeader').style.cssText = `height:${m.t}in;padding:0 ${m.r}in 0 ${m.l}in`;
  $('#pageFooter').style.cssText = `top:${h - m.b}in;height:${m.b}in;padding:0 ${m.r}in 0 ${m.l}in`;
  $('#selPage').value = cur.page.size;
  $('#selVAlign').value = cur.page.valign || 'top';
  const preset = Object.entries(MARGINS).find(([, v]) => v.t === m.t && v.r === m.r && v.b === m.b && v.l === m.l);
  $('#selMargin').value = preset ? preset[0] : 'custom';
  $$('[data-act="orient"]').forEach(b => b.classList.toggle('on', b.dataset.v === cur.page.orient));
  applyZoom(); Pager.run(); Ruler.render();
}

/* ------------------------------------------------------------ pagination
   The document is one continuous editable flow. Pager measures it and inserts
   invisible, non-editable spacers (.pg-gap) wherever a line or block would cross
   the bottom of a page, so text lands on separate page sheets exactly as it will
   print. Spacers are stripped before every save, export and copy. */
const Pager = {
  G: 28, timer: null, sig: '', composing: false, fnCache: new Map(), geo: null, pendingRender: false,
  on() { return settings.pageView !== 'continuous' || document.body.classList.contains('printing'); },
  printing() { return document.body.classList.contains('printing'); },
  cost: 0,
  schedule(ms = 140) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), Math.max(ms, Math.min(900, this.cost * 3))); },
  strip() {
    const parents = new Set();
    $$('.pg-gap', editor).forEach(g => { if (g.tagName === 'SPAN' && g.parentNode) parents.add(g.parentNode); g.remove(); });
    parents.forEach(p => { if (p.isConnected) p.normalize(); });
    $$('.cols-flow', editor).forEach(c => c.classList.remove('cols-flow'));
  },
  leaves(root = editor) {
    const out = [];
    const isBlock = el => /^(P|H[1-6]|PRE|LI|BLOCKQUOTE|UL|OL|TABLE|DIV|HR|SECTION|FIGURE)$/.test(el.tagName) && !el.classList.contains('pg-gap');
    const blockKids = el => [...el.children].some(isBlock);
    const walk = el => {
      for (const c of el.children) {
        if (c.classList.contains('pg-gap')) continue;
        const t = c.tagName;
        if (t === 'TABLE') { for (const tr of c.rows) if (!tr.classList.contains('pg-gap')) out.push({ el: tr, atomic: true }); continue; }
        if (c.classList.contains('page-break')) { out.push({ el: c, pb: true }); continue; }
        if (c.matches('.toc, hr, img, figure')) { out.push({ el: c, atomic: true }); continue; }
        if (c.classList.contains('cols')) { out.push({ el: c, atomic: true, cols: true }); continue; }
        if (t === 'UL' || t === 'OL') { walk(c); continue; }
        if (t === 'LI') {
          if (blockKids(c)) { if ([...c.childNodes].some(n => (n.nodeType === 3 && n.data.trim()) || (n.nodeType === 1 && !isBlock(n)))) out.push({ el: c, own: true }); walk(c); }
          else out.push({ el: c });
          continue;
        }
        if (blockKids(c)) { walk(c); continue; }
        if (isBlock(c)) out.push({ el: c });
      }
    };
    walk(root);
    return out;
  },
  walker(L) {
    return document.createTreeWalker(L.el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (n.classList.contains('pg-gap')) return NodeFilter.FILTER_REJECT;
        if (L.own && /^(UL|OL|P|DIV|TABLE|BLOCKQUOTE|PRE|H[1-6])$/.test(n.tagName)) return NodeFilter.FILTER_REJECT;
        if (n.tagName === 'IMG') return NodeFilter.FILTER_ACCEPT;
        if (n.matches('sup.fn, .mf')) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });
  },
  lines(L, Y) {
    const rects = []; const range = document.createRange(); const w = this.walker(L); let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) { if (!n.data.length) continue; range.selectNodeContents(n); for (const r of range.getClientRects()) if (r.height > 0) rects.push(r); }
      else { const r = n.getBoundingClientRect(); if (r.height > 0) rects.push(r); }
    }
    rects.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of rects) {
      const last = lines[lines.length - 1];
      if (last && r.top < last.cb - 2 && r.bottom > last.ct + 2) { last.ct = Math.min(last.ct, r.top); last.cb = Math.max(last.cb, r.bottom); }
      else lines.push({ ct: r.top, cb: r.bottom });
    }
    lines.forEach(l => { l.top = Y(l.ct); l.bottom = Y(l.cb); });
    return lines;
  },
  lineStart(L, ln) {                       // DOM position of the first character on a line (no hit-testing, works off-screen)
    const range = document.createRange(); const w = this.walker(L); let n;
    const onOrAfter = r => (r.top + r.bottom) / 2 >= ln.ct - 1;
    while ((n = w.nextNode())) {
      if (n.nodeType === 1) { const r = n.getBoundingClientRect(); if (r.height && onOrAfter(r)) return { el: n }; continue; }
      const len = n.data.length; if (!len) continue;
      const rectAt = i => { range.setStart(n, i); range.setEnd(n, i + 1); const rs = range.getClientRects(); return rs.length ? rs[rs.length - 1] : null; };
      let hi = len - 1, last = null; while (hi >= 0 && !(last = rectAt(hi))) hi--;
      if (!last || !onOrAfter(last)) continue;
      let lo = 0;
      while (lo < hi) {
        const mid = (lo + hi) >> 1; let j = mid, r = null;
        while (j < hi && !(r = rectAt(j))) j++;
        if (j >= hi || onOrAfter(r)) hi = mid; else lo = j + 1;
      }
      return { node: n, off: lo };
    }
    return null;
  },
  noteHeight(text, cw) {
    const key = cw + '|' + text; const hit = this.fnCache.get(key); if (hit != null) return hit;
    if (!this.measurer) { this.measurer = document.createElement('div'); this.measurer.className = 'fn-measure'; document.body.appendChild(this.measurer); }
    this.measurer.style.width = cw + 'px';
    this.measurer.innerHTML = `<div class="fn-item"><sup>99</sup><span class="fn-text">${esc(text) || 'x'}</span></div>`;
    const v = this.measurer.firstChild.getBoundingClientRect().height + 2;
    if (this.fnCache.size > 800) this.fnCache.clear();
    this.fnCache.set(key, v); return v;
  },
  run() {
    clearTimeout(this.timer);
    if (!cur || !DB.db) return;
    const t0 = performance.now();
    if (this.composing) { this.schedule(400); return; }
    const pagesOn = this.on(), printing = this.printing();
    const z = printing ? 1 : clamp(settings.zoom, 30, 200) / 100;
    const G = printing ? 0 : this.G;
    const { w, h } = pageDims(); const m = cur.page.margins;
    const H = h * 96, mT = m.t * 96, mB = m.b * 96, mL = m.l * 96, mR = m.r * 96, cw = (w - m.l - m.r) * 96;
    // measure every footnote up front so the loop below never invalidates layout
    const fns = $$('sup.fn', editor);
    fns.forEach(f => this.noteHeight(f.dataset.note || '', cw));
    this.strip();
    editor.style.minHeight = pagesOn ? (H - mT - mB) + 'px' : (H - mT - mB) + 'px';
    const base = page.getBoundingClientRect().top;
    const Y = cy => (cy - base) / z;
    const pTop = p => p * (H + G), cTop = p => pTop(p) + mT;
    const pageOf = y => Math.max(0, Math.floor(y / (H + G)));
    const notes = new Map(), owner = new Map(), gapFor = new Map(), used = new Map();
    const use = (p, b) => used.set(p, Math.max(used.get(p) || 0, b));
    const nh = f => this.noteHeight(f.dataset.note || '', cw);
    const area = p => { const a = notes.get(p); return a && a.length ? 10 + a.reduce((s, f) => s + nh(f), 0) : 0; };
    const limit = p => pTop(p) + H - mB - area(p);
    const remN = f => { const p = owner.get(f); if (p == null) return; owner.delete(f); const a = notes.get(p); a.splice(a.indexOf(f), 1); };
    const addN = (f, p) => { if (owner.get(f) === p) return; remN(f); owner.set(f, p); if (!notes.has(p)) notes.set(p, []); notes.get(p).push(f); };
    const mkGap = tag => { const g = document.createElement(tag); g.className = 'pg-gap'; g.setAttribute('contenteditable', 'false'); g.style.height = '0px'; return g; };
    const fit = (gapEl, measure, target) => {
      for (let k = 0; k < 3; k++) {
        const d = target - measure(); if (Math.abs(d) < 0.5) return;
        gapEl.style.height = Math.max(0, (parseFloat(gapEl.style.height) || 0) + d) + 'px';
      }
    };
    const pageAt = target => Math.round((target - mT) / (H + G));
    const pushBefore = (el, target) => {
      if (el.tagName === 'TR') {
        const tr = mkGap('tr'); tr.removeAttribute('style'); const td = document.createElement('td');
        td.colSpan = Math.max(1, [...el.cells].reduce((s, c) => s + c.colSpan, 0)); td.style.height = '0px'; tr.appendChild(td); el.before(tr);
        fit(td, () => Y(el.getBoundingClientRect().top), target); gapFor.set(pageAt(target), td);
      } else { const g = mkGap('div'); el.before(g); fit(g, () => Y(el.getBoundingClientRect().top), target); gapFor.set(pageAt(target), g); }
    };
    const splitBefore = (pos, target) => {
      const g = mkGap('span');
      if (pos.el) pos.el.before(g);
      else { let n = pos.node; if (pos.off > 0) n = n.splitText(pos.off); n.before(g); }
      fit(g, () => Y(g.getBoundingClientRect().bottom), target); gapFor.set(pageAt(target), g);
    };

    let lastBottom = mT;
    if (pagesOn) {
      const leaves = this.leaves();
      for (let i = 0; i < leaves.length; i++) {
        const L = leaves[i]; const el = L.el; if (!el.isConnected) continue;
        const refs = $$('sup.fn', el).filter(f => !L.own || f.closest('li') === el);
        for (let guard = 0; guard < 300; guard++) {
          refs.forEach(remN);
          const r = el.getBoundingClientRect();
          const top = Y(r.top), bottom = Y(r.bottom), p = pageOf(top);
          if (L.pb) {
            const g = mkGap('div'); el.after(g); fit(g, () => Y(g.getBoundingClientRect().bottom), cTop(p + 1)); gapFor.set(p + 1, g);
            use(p, top); lastBottom = Math.max(lastBottom, cTop(p + 1)); break;
          }
          if (!r.height) break;
          const atTop = top <= cTop(p) + 2;
          if (L.atomic) {
            refs.forEach(f => addN(f, p));
            if (bottom <= limit(p) + 0.5) { lastBottom = Math.max(lastBottom, bottom); use(p, bottom); break; }
            refs.forEach(remN);
            if (L.cols && bottom - top > limit(p) - cTop(p) && !el.classList.contains('cols-flow')) {
              el.classList.add('cols-flow'); leaves.splice(i, 1, ...this.leaves(el)); i--; break;
            }
            if (atTop) { refs.forEach(f => addN(f, p)); lastBottom = Math.max(lastBottom, bottom); use(p, bottom); break; }
            pushBefore(el, cTop(p + 1)); continue;
          }
          const lines = this.lines(L, Y);
          if (!lines.length) {
            if (bottom <= limit(p) + 0.5 || atTop) { lastBottom = Math.max(lastBottom, bottom); use(p, bottom); break; }
            pushBefore(el, cTop(p + 1)); continue;
          }
          let acted = false;
          for (let k = 0; k < lines.length; k++) {
            const ln = lines[k]; const lp = pageOf(ln.top);
            const onLine = refs.filter(f => { const fr = f.getBoundingClientRect(); const fy = (fr.top + fr.bottom) / 2; return fy >= ln.ct - 1 && fy <= ln.cb + 1; });
            onLine.forEach(f => addN(f, lp));
            if (ln.bottom <= limit(lp) + 0.5) continue;
            onLine.forEach(remN);
            if (ln.top - cTop(lp) < (ln.bottom - ln.top) + 2) continue;           // already first on its page; let it overflow
            let b = k;
            if (b === 1 && lines.length > 2) b = 0;                                 // don't leave a single orphan line behind
            else if (b === lines.length - 1 && b >= 2 && pageOf(lines[b - 1].top) === lp) b = b - 1;   // don't carry a single widow line
            const bl = lines[b], target = cTop(pageOf(bl.top) + 1);
            refs.forEach(f => { const fr = f.getBoundingClientRect(); if ((fr.top + fr.bottom) / 2 >= bl.ct - 1) remN(f); });
            if (b === 0) pushBefore(el, target);
            else { const pos = this.lineStart(L, bl); if (pos) splitBefore(pos, target); else pushBefore(el, target); }
            acted = true; break;
          }
          if (!acted) { lastBottom = Math.max(lastBottom, lines[lines.length - 1].bottom, bottom); lines.forEach(l => use(pageOf(l.top), l.bottom)); break; }
        }
      }
      const kids = [...editor.children].filter(c => !c.classList.contains('pg-gap'));
      const lk = kids[kids.length - 1];
      if (lk) lastBottom = Math.max(lastBottom, Y(lk.getBoundingClientRect().bottom));
      // vertical alignment of text on each page (Layout → Vertical)
      const va = cur.page.valign;
      if (va === 'center' || va === 'bottom') {
        const Np = Math.max(1, pageOf(lastBottom - 1) + 1); let prev = 0;
        for (let pg = 0; pg < Np; pg++) {
          if (!used.has(pg)) continue;
          const free = Math.max(0, limit(pg) - used.get(pg)); let off = va === 'center' ? free / 2 : free;
          if (pg === 0) {
            const first = kids[0]; if (!first || off < 1) { prev = 0; continue; }
            const g = mkGap('div'); g.style.height = off + 'px'; first.before(g); prev = off; continue;
          }
          const g = gapFor.get(pg); if (!g) { continue; }
          const h0 = parseFloat(g.style.height) || 0; const h = Math.max(0, h0 + off - prev);
          g.style.height = h + 'px'; prev = prev + (h - h0);
        }
      }
    }
    const notePages = [...notes.keys()].filter(p => notes.get(p).length);
    let N = 1, total;
    const contentH = Y(editor.getBoundingClientRect().bottom);
    if (pagesOn) { N = Math.max(1, pageOf(lastBottom - 1) + 1, ...notePages.map(p => p + 1)); total = N * (H + G) - G; }
    else {
      if (fns.length) { notes.set(0, fns); fns.forEach(f => owner.set(f, 0)); }
      total = Math.max(H, contentH + (fns.length ? area(0) + 16 : 0) + mB);
    }
    page.style.height = total + 'px';
    this.geo = { H, G, z, mT, mB, pagesOn };
    stats.pages = N; renderStatus();
    this.render({ N, H, G, mT, mB, mL, mR, total, notes, area, contentH, pagesOn, fns });
    if (panelMode === 'find') Find.build();
    this.cost = performance.now() - t0;
  },
  render(o) {
    const resolve = (t, k) => t.replace(/\{page\}/g, k + 1).replace(/\{pages\}/g, o.N).replace(/\{title\}/g, cur.title).replace(/\{date\}/g, fmtDate());
    const H_ = hdr.innerText.replace(/\n+$/, ''), F_ = ftr.innerText.replace(/\n+$/, '');
    const idx = new Map(o.fns.map((f, i) => [f, i + 1]));
    const pages = o.pagesOn ? o.N : 1;
    let sheets = '', ov = '';
    for (let k = 0; k < pages; k++) {
      const top = k * (o.H + o.G), hgt = o.pagesOn ? o.H : o.total;
      sheets += `<div class="sheet" style="top:${top}px;height:${hgt}px"></div>`;
      if (settings.ruler && (o.pagesOn || k === 0)) ov += Ruler.vruler(top, hgt, o.mT, o.mB);
      const pad = `padding:0 ${o.mR}px 0 ${o.mL}px`;
      if (H_ || k === 0) ov += `<div class="ov-hf h${k === 0 ? ' p0' : ''}" data-hf="h" style="top:${top}px;height:${o.mT}px;${pad}"><span>${esc(resolve(H_, k))}</span></div>`;
      if (F_ || k === 0) ov += `<div class="ov-hf f${k === 0 ? ' p0' : ''}" data-hf="f" style="top:${top + hgt - o.mB}px;height:${o.mB}px;${pad}"><span>${esc(resolve(F_, k))}</span></div>`;
      const list = (o.notes.get(k) || []).slice().sort((a, b) => idx.get(a) - idx.get(b));
      if (list.length) {
        const ar = o.area(k);
        const fTop = o.pagesOn ? top + o.H - o.mB - ar : o.mT + (o.contentH - o.mT) + 16;
        ov += `<div class="ov-fn${o.pagesOn ? '' : ' endnotes'}" style="top:${fTop}px;left:${o.mL}px;right:${o.mR}px;height:${ar}px">` +
          list.map(f => `<div class="fn-item"><sup>${idx.get(f)}</sup><span class="fn-text" contenteditable="plaintext-only" spellcheck="true" data-fid="${esc(f.dataset.fid)}">${esc(f.dataset.note || '')}</span><button class="fn-del" data-fdel="${esc(f.dataset.fid)}" title="Delete footnote">×</button></div>`).join('') + '</div>';
      }
    }
    $('#pageFooter').style.top = (o.pagesOn ? o.H - o.mB : o.total - o.mB) + 'px';
    const sig = sheets + ov;
    if (sig === this.sig) return;
    if ($('#overlays').contains(document.activeElement)) { this.pendingRender = true; $('#sheets').innerHTML = sheets; return; }
    this.sig = sig; this.pendingRender = false;
    $('#sheets').innerHTML = sheets; $('#overlays').innerHTML = ov;
  },
  focusNote(fid) {
    const el = $(`#overlays .fn-text[data-fid="${CSS.escape(fid)}"]`); if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); setRange(r);
  }
};
function scheduleGuides() { Pager.schedule(); }
let rulerT = null; function rulerSoon() { if (Ruler.drag) return; cancelAnimationFrame(rulerT); rulerT = requestAnimationFrame(() => Ruler.render()); }
editor.addEventListener('compositionstart', () => { Pager.composing = true; });
editor.addEventListener('compositionend', () => { Pager.composing = false; Pager.schedule(); });
editor.addEventListener('load', e => { if (e.target.tagName === 'IMG') Pager.schedule(60); }, true);
if (document.fonts) { document.fonts.addEventListener?.('loadingdone', () => Pager.schedule(30)); document.fonts.ready.then(() => Pager.schedule(30)); }
window.addEventListener('beforeprint', () => {
  if (!cur) return;
  selectImage(null); if (pendingSave) saveNow();
  const { w, h } = pageDims();
  let s = $('#printStyle'); if (!s) { s = document.createElement('style'); s.id = 'printStyle'; document.head.appendChild(s); }
  s.textContent = `@page { size: ${w}in ${h}in; margin: 0; }`;
  document.body.classList.add('printing'); applyZoom(); Pager.run();
});
window.addEventListener('afterprint', () => { document.body.classList.remove('printing'); applyZoom(); Pager.run(); });

/* zoom */
function applyZoom() {
  const z = clamp(settings.zoom, 30, 200) / 100;
  pageWrap.style.zoom = document.body.classList.contains('printing') ? 1 : z;
  $('#zoomRange').value = settings.zoom; $('#zoomLabel').textContent = settings.zoom + '%';
}
function setZoom(v) { settings.zoom = Math.round(clamp(v, 30, 200)); saveSettings(); applyZoom(); hideFloatbars(); Pager.schedule(60); }
function zoomFit() {
  const { w } = pageDims();
  setZoom(Math.floor(((canvas.clientWidth - 32) / (w * 96)) * 100));
}

/* ============================================================ stats */
const stats = { words: 0, chars: 0, pages: 1, page: 1 };
let statsT = null;
function scheduleStats() { clearTimeout(statsT); statsT = setTimeout(computeStats, 300); }
function visibleText(root = editor) {
  let out = '';
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => n.nodeType === 1 ? ((n.matches('del.tc, .toc') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)) : NodeFilter.FILTER_ACCEPT
  });
  let n, lastBlock = null;
  while ((n = w.nextNode())) { const b = blockOf(n); if (b !== lastBlock && out) out += '\n'; lastBlock = b; out += n.data; }
  return out.replace(/​/g, '');
}
function computeStats() {
  const t = visibleText();
  stats.words = (t.match(/[^\s ]+/g) || []).length;
  stats.chars = t.replace(/\n/g, '').length;
  renderStatus();
}
function caretPage() {
  const r = selRange(); if (!r || !cur) return 1;
  const rect = r.getClientRects()[0] || (r.startContainer.nodeType === 1 ? r.startContainer.getBoundingClientRect() : r.startContainer.parentElement.getBoundingClientRect());
  const g = Pager.geo; if (!g || !g.pagesOn) return 1;
  const y = (rect.top - page.getBoundingClientRect().top) / g.z;
  return clamp(Math.floor(y / (g.H + g.G)) + 1, 1, stats.pages);
}
function renderStatus() {
  $('#stPages').textContent = `Page ${Math.min(stats.page, stats.pages)} of ${stats.pages}`;
  $('#stWords').textContent = `${stats.words.toLocaleString()} word${stats.words === 1 ? '' : 's'}`;
}

/* ========================================================= toolbar */
function buildSelects() {
  $('#selFont').innerHTML = FONTS.map(([n, v]) => `<option value="${esc(v)}" style="font-family:${esc(v)}">${esc(n)}</option>`).join('');
  $('#selSize').innerHTML = SIZES.map(s => `<option value="${s}">${s}</option>`).join('');
  $('#selFont').value = FONTS[0][1]; $('#selSize').value = '11';
}
const STATE_CMDS = ['bold', 'italic', 'underline', 'strikeThrough', 'subscript', 'superscript', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull'];
let tbRAF = null;
function updateToolbar() {
  cancelAnimationFrame(tbRAF);
  tbRAF = requestAnimationFrame(() => {
    const r = selRange(); if (!r) return;
    for (const c of STATE_CMDS) {
      let on = false; try { on = document.queryCommandState(c); } catch {}
      $$(`[data-cmd="${c}"]`).forEach(b => b.classList.toggle('on', on));
    }
    const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    if (!node) return;
    const cs = getComputedStyle(node);
    const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    const f = FONTS.find(([n, v]) => n.toLowerCase() === fam || v.split(',')[0].replace(/["']/g, '').trim().toLowerCase() === fam || (fam === 'carlito' && n === 'Calibri'));
    const sf = $('#selFont');
    if (f) sf.value = f[1];
    else { let o = $('option[data-custom]', sf); if (!o) { o = document.createElement('option'); o.dataset.custom = 1; sf.appendChild(o); } o.value = cs.fontFamily; o.textContent = cs.fontFamily.split(',')[0].replace(/["']/g, ''); sf.value = cs.fontFamily; }
    const pt = Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2;
    const ss = $('#selSize');
    if (![...ss.options].some(o => +o.value === pt)) { const o = document.createElement('option'); o.value = pt; o.textContent = pt; ss.appendChild(o); }
    ss.value = String(pt);
    const b = blockOf(node);
    let style = 'p';
    if (b) {
      const tag = b.tagName.toLowerCase();
      style = tag === 'p' ? (b.classList.contains('title') ? 'title' : b.classList.contains('subtitle') ? 'subtitle' : 'p') : (['h1', 'h2', 'h3', 'h4', 'blockquote', 'pre'].includes(tag) ? tag : 'p');
      const bq = closestEl(node, 'blockquote'); if (bq && tag === 'p') style = 'blockquote';
    }
    $('#selStyle').value = style;
    const lst = closestEl(node, 'li')?.parentElement;
    $('[data-act="checklist"]').classList.toggle('on', !!(lst && lst.classList.contains('checklist')));
    $('[data-cmd="insertUnorderedList"]').classList.toggle('on', !!(lst && lst.tagName === 'UL' && !lst.classList.contains('checklist')));
    $('[data-cmd="insertOrderedList"]').classList.toggle('on', !!(lst && lst.tagName === 'OL'));
    stats.page = caretPage(); renderStatus();
  });
}

function exec(cmd, val = null) {
  restoreSel();
  History.push('fmt', true);
  document.execCommand(cmd, false, val);
  markChanged(); updateToolbar();
}
function applyFontSize(pt) {
  restoreSel(); const r = selRange(); if (!r) return;
  History.push('fmt', true);
  if (r.collapsed) {
    const k = 'k' + Math.random().toString(36).slice(2);
    document.execCommand('insertHTML', false, `<span style="font-size:${pt}pt" data-k="${k}">​</span>`);
    const s = $(`[data-k="${k}"]`, editor);
    if (s) { s.removeAttribute('data-k'); placeCaretAtEnd(s); }
  } else {
    document.execCommand('fontSize', false, '7');
    $$('font[size="7"]', editor).forEach(f => { const s = document.createElement('span'); s.style.fontSize = pt + 'pt'; while (f.firstChild) s.appendChild(f.firstChild); f.replaceWith(s); });
    $$('span[style*="xxx-large"]', editor).forEach(s => { s.style.fontSize = pt + 'pt'; });
  }
  markChanged(); updateToolbar();
}
function applyBlockStyle(v) {
  restoreSel(); History.push('fmt', true);
  if (v === 'title' || v === 'subtitle') {
    document.execCommand('formatBlock', false, '<p>');
    getSelectedBlocks().forEach(b => { if (b.tagName === 'P') { b.classList.remove('title', 'subtitle'); b.classList.add(v); } });
  } else {
    if (v === 'p') { const bq = closestEl(selNode(), 'blockquote'); if (bq) { document.execCommand('outdent'); } }
    document.execCommand('formatBlock', false, `<${v}>`);
    getSelectedBlocks().forEach(b => b.classList.remove('title', 'subtitle'));
  }
  markChanged(); updateToolbar();
}
function lineSpacing(v) {
  restoreSel(); History.push('fmt', true);
  getSelectedBlocks().forEach(b => { b.style.lineHeight = v; });
  markChanged();
}
function indent(dir) {
  restoreSel();
  if (closestEl(selNode(), 'li')) { listIndent(dir); return; }
  History.push('fmt', true);
  getSelectedBlocks().forEach(b => {
    const curIn = b.style.marginLeft.endsWith('in') ? parseFloat(b.style.marginLeft) : (parseFloat(b.style.marginLeft) || 0) / 96;
    const n = Math.max(0, Math.round((curIn + dir * 0.5) * 2) / 2);
    b.style.marginLeft = n ? n + 'in' : '';
  });
  markChanged();
}
/* ---- lists: our own implementation (browser list commands nest lists in <p> and lose the caret) ---- */
function withMarkers(fn) {
  const r = selRange() || lastRange;
  if (!r) { fn(); return; }
  const mk = () => { const s = document.createElement('span'); s.dataset.mk = '1'; s.textContent = '​'; return s; };
  const a = mk(), b = r.collapsed ? null : mk();
  if (b) { const re = r.cloneRange(); re.collapse(false); re.insertNode(b); }
  const rs = r.cloneRange(); rs.collapse(true); rs.insertNode(a);
  const sr = document.createRange(); sr.setStartAfter(a); if (b) sr.setEndBefore(b); else sr.collapse(true); setRange(sr);
  try { fn(); } finally {
    const ms = $$('[data-mk]', editor);
    if (ms.length) {
      const nr = document.createRange(); nr.setStartBefore(ms[0]); if (ms.length > 1) nr.setEndBefore(ms[ms.length - 1]); else nr.collapse(true);
      ms.forEach(m => m.remove());
      editor.focus({ preventScroll: true }); setRange(nr);
    }
    $$('li:empty, p:empty', editor).forEach(e => e.innerHTML = '<br>');
  }
}
const isList = n => n && n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL');
function listBlocks() {
  return getSelectedBlocks().map(b => b.tagName === 'LI' ? b : (closestEl(b, 'li') || b)).filter((b, i, a) => a.indexOf(b) === i);
}
function splitAfter(li) {               // items after li move into a new list placed after li's list
  const list = li.parentElement; const rest = []; let n = li.nextSibling;
  while (n) { rest.push(n); n = n.nextSibling; }
  if (!rest.some(x => x.nodeType === 1)) return;
  const nl = list.cloneNode(false); rest.forEach(x => nl.appendChild(x)); list.after(nl);
}
function liToPara(li) {
  const list = li.parentElement; splitAfter(li);
  const p = document.createElement('p'); const nested = [];
  [...li.childNodes].forEach(c => isList(c) ? nested.push(c) : p.appendChild(c));
  if (!p.childNodes.length) p.innerHTML = '<br>';
  list.after(p); p.after(...nested); li.remove();
  if (!list.children.length) list.remove();
  return p;
}
function makeLi(block) {
  const li = document.createElement('li');
  if (block.tagName === 'LI') { while (block.firstChild) li.appendChild(block.firstChild); }
  else { while (block.firstChild) li.appendChild(block.firstChild); if (block.style.textAlign) li.style.textAlign = block.style.textAlign; }
  if (!li.childNodes.length) li.innerHTML = '<br>';
  return li;
}
function toggleList(tag, check = false) {
  restoreSel(); History.push('list', true);
  withMarkers(() => {
    const blocks = listBlocks(); if (!blocks.length) return;
    const matches = b => b.tagName === 'LI' && b.parentElement.tagName === tag && b.parentElement.classList.contains('checklist') === check;
    if (blocks.every(matches)) { blocks.forEach(liToPara); return; }
    let list = null;
    for (const b of blocks) {
      if (b.tagName === 'LI') {
        const pl = b.parentElement;
        if (pl.tagName !== tag || pl.classList.contains('checklist') !== check) {
          const nl = document.createElement(tag); if (check) nl.className = 'checklist';
          while (pl.firstChild) nl.appendChild(pl.firstChild); pl.replaceWith(nl);
          if (check) $$(':scope > li', nl).forEach(l => { if (!l.dataset.checked) l.dataset.checked = 'false'; });
          else $$(':scope > li', nl).forEach(l => l.removeAttribute('data-checked'));
        }
        list = null; continue;
      }
      if (!list) {
        const prev = b.previousElementSibling;
        if (prev && prev.tagName === tag && prev.classList.contains('checklist') === check) list = prev;
        else { list = document.createElement(tag); if (check) list.className = 'checklist'; b.before(list); }
      }
      const li = makeLi(b); if (check) li.dataset.checked = 'false';
      list.appendChild(li); b.remove();
    }
  });
  markChanged(); updateToolbar();
}
function listIndent(dir) {
  History.push('list', true);
  withMarkers(() => {
    const lis = listBlocks().filter(b => b.tagName === 'LI');
    (dir > 0 ? lis : lis.reverse()).forEach(li => {
      const list = li.parentElement;
      if (dir > 0) {
        const prev = li.previousElementSibling; if (!prev || prev.tagName !== 'LI') return;
        let sub = [...prev.children].reverse().find(isList);
        if (!sub || sub.tagName !== list.tagName) { sub = list.cloneNode(false); prev.appendChild(sub); }
        sub.appendChild(li);
      } else {
        const parentLi = list.parentElement;
        if (parentLi && parentLi.tagName === 'LI') {
          splitAfter(li);
          const after = li.nextSibling ? null : null; void after;
          const tail = list.nextElementSibling && isList(list.nextElementSibling) && list.nextElementSibling.parentElement === parentLi ? list.nextElementSibling : null;
          if (tail) li.appendChild(tail);
          parentLi.after(li);
          if (!list.children.length) list.remove();
        } else liToPara(li);
      }
    });
  });
  markChanged(); updateToolbar();
}
function toggleChecklist() { toggleList('UL', true); }
function clearFormat() {
  restoreSel(); History.push('fmt', true);
  document.execCommand('removeFormat');
  const r = selRange();
  if (r && !r.collapsed) $$('span[style]', editor).forEach(s => { if (r.intersectsNode(s) && !s.closest('.cmt')) { s.replaceWith(...s.childNodes); } });
  markChanged(); updateToolbar();
}
function insertAtom(el) {          // insert a non-editable inline element (footnote mark, merge field) at the caret
  restoreSel(); const r = selRange(); if (!r) return;
  History.push('ins', true);
  r.deleteContents(); r.insertNode(el);
  const after = el.nextSibling;
  if (!after || (after.nodeType === 1 && after.tagName === 'BR')) el.after(document.createTextNode('\u200B'));
  const nr = document.createRange(); nr.setStartAfter(el); nr.collapse(true); setRange(nr);
  markChanged();
}
function atom(tag, cls, data) { const e = document.createElement(tag); e.className = cls; e.setAttribute('contenteditable', 'false'); Object.entries(data).forEach(([k, v]) => { e.dataset[k] = v; }); return e; }
function insertHTMLAtCaret(html) {
  restoreSel(); History.push('ins', true);
  document.execCommand('insertHTML', false, html);
  markChanged();
}

/* ======================================================== track changes */
const tcEl = (tag) => { const e = document.createElement(tag); e.className = 'tc'; e.dataset.a = me(); e.dataset.t = Date.now(); return e; };
const closestTC = (n, tag) => closestEl(n, tag + '.tc');

function insertText(text) {             // the one entry point for programmatic text input
  restoreSel(); History.push('type', true);
  if (cur && cur.track) trackedInsert(text);
  else document.execCommand('insertText', false, text);
  markChanged();
}
function nodeBefore(r) {
  const c = r.startContainer;
  if (c.nodeType === 3) return r.startOffset === 0 ? c.previousSibling : null;
  return c.childNodes[r.startOffset - 1] || null;
}
function trackedInsert(text) {
  const sel = getSelection(); if (!sel.rangeCount) return;
  let r = sel.getRangeAt(0);
  if (!r.collapsed) { markDeleted(r, 'forward'); r = sel.getRangeAt(0); }
  const del = closestTC(r.startContainer, 'del');
  if (del) { r = document.createRange(); r.setStartAfter(del); r.collapse(true); setRange(r); }
  const mine = el => el && el.nodeType === 1 && el.matches('ins.tc') && el.dataset.a === me();
  let ins = closestTC(r.startContainer, 'ins');
  if (!mine(ins)) { const prev = nodeBefore(r); if (mine(prev)) { ins = prev; placeCaretAtEnd(prev); r = sel.getRangeAt(0); } else ins = null; }
  if (ins && !text.includes('\n')) {
    const c = r.startContainer;
    if (c.nodeType === 3) { c.insertData(r.startOffset, text); const nr = document.createRange(); nr.setStart(c, r.startOffset + text.length); setRange(nr); }
    else { const t = document.createTextNode(text); r.insertNode(t); const nr = document.createRange(); nr.setStartAfter(t); setRange(nr); }
    return;
  }
  const el = tcEl('ins');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((ln, i) => { if (i) el.appendChild(document.createElement('br')); if (ln) el.appendChild(document.createTextNode(ln === ' ' ? ' ' : ln)); });
  r.insertNode(el);
  placeCaretAtEnd(el);
}
function collectParts(r) {
  const root = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentNode;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => {
      if (n.nodeType === 1) {
        if (n.isContentEditable === false || n.matches('.toc, .page-break')) return NodeFilter.FILTER_REJECT;
        return n.tagName === 'IMG' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const out = []; let n;
  while ((n = w.nextNode())) {
    if (!r.intersectsNode(n)) continue;
    if (n.nodeType === 3) {
      if (/^(TABLE|TBODY|THEAD|TR|UL|OL)$/.test(n.parentNode.tagName)) continue;
      if (!n.data.length) continue;
    }
    out.push(n);
  }
  return out;
}
function markDeleted(range, dir) {
  const a = document.createElement('span'), b = document.createElement('span');
  const re = range.cloneRange(); re.collapse(false); re.insertNode(b);
  const rs = range.cloneRange(); rs.collapse(true); rs.insertNode(a);
  const r = document.createRange(); r.setStartAfter(a); r.setEndBefore(b);
  for (const n of collectParts(r)) {
    if (closestTC(n, 'del')) continue;
    const ins = closestTC(n, 'ins');
    if (ins && ins.dataset.a === me()) { n.remove(); if (!ins.textContent && !ins.querySelector('img')) ins.remove(); continue; }
    const skip = (x, dir) => { while (x && (x === a || x === b || (x.nodeType === 3 && !x.data))) x = x[dir]; return x; };
    const prev = skip(n.previousSibling, 'previousSibling');
    if (prev && prev.nodeType === 1 && prev.matches('del.tc') && prev.dataset.a === me()) { prev.appendChild(n); continue; }
    const next = skip(n.nextSibling, 'nextSibling');
    if (next && next.nodeType === 1 && next.matches('del.tc') && next.dataset.a === me()) { next.insertBefore(n, next.firstChild); continue; }
    const d = tcEl('del'); n.parentNode.insertBefore(d, n); d.appendChild(n);
  }
  const target = dir === 'backward' ? a : b;
  const cr = document.createRange(); cr.setStartBefore(target); cr.collapse(true);
  setRange(cr);
  a.remove(); b.remove();
}
function trackedDelete(type) {
  const sel = getSelection(); if (!sel.rangeCount) return false;
  const orig = sel.getRangeAt(0).cloneRange();
  const back = /Backward/.test(type) || type === 'deleteByCut' || type === 'deleteContent' || type === 'deleteByDrag';
  if (!orig.collapsed) { markDeleted(orig, 'backward'); return true; }
  if (type === 'deleteByCut' || type === 'deleteByDrag') return false;
  const gran = /Word/.test(type) ? 'word' : /Line/.test(type) ? 'lineboundary' : 'character';
  for (let i = 0; i < 80; i++) {
    sel.modify('extend', back ? 'backward' : 'forward', gran);
    const r = sel.getRangeAt(0);
    if (r.collapsed || !r.toString()) { setRange(orig); return false; }   // block boundary → let the browser merge
    const inDel = closestTC(r.commonAncestorContainer, 'del');
    if (inDel) { if (back) sel.collapseToStart(); else sel.collapseToEnd(); continue; }
    markDeleted(r, back ? 'backward' : 'forward');
    return true;
  }
  setRange(orig); return false;
}
function mergeTC() {
  $$('ins.tc, del.tc', editor).forEach(el => {
    let n = el.nextSibling;
    while (n && n.nodeType === 1 && n.tagName === el.tagName && n.classList.contains('tc') && n.dataset.a === el.dataset.a) {
      const nx = n.nextSibling; while (n.firstChild) el.appendChild(n.firstChild); n.remove(); n = nx;
    }
  });
}
function changes() { mergeTC(); return $$('ins.tc, del.tc', editor); }
function acceptEl(el) { if (el.tagName === 'INS') el.replaceWith(...el.childNodes); else el.remove(); }
function rejectEl(el) { if (el.tagName === 'INS') el.remove(); else el.replaceWith(...el.childNodes); }
function acceptAll(accept) {
  const list = changes(); if (!list.length) { toast('No tracked changes'); return; }
  History.push('tc', true);
  list.forEach(el => accept ? acceptEl(el) : rejectEl(el));
  afterDomChange(); toast(`${accept ? 'Accepted' : 'Rejected'} ${list.length} change${list.length > 1 ? 's' : ''}`);
}
async function toggleTrack(force) {
  if (!cur) return;
  cur.track = typeof force === 'boolean' ? force : !cur.track;
  applyTrackUI(); await commitMeta();
  toast(cur.track ? 'Track changes on — edits are marked' : 'Track changes off');
}
function applyTrackUI() {
  $('#btnTrack').classList.toggle('on', !!cur?.track);
  $('#stTrack').innerHTML = cur?.track ? '<span class="tc-on">● Tracking changes</span>' : '';
  editor.classList.toggle('final-view', !settings.markup);
  $('#btnMarkup').classList.toggle('on', settings.markup);
}

/* =============================================================== comments */
function wrapRange(range, make) {
  const a = document.createElement('span'), b = document.createElement('span');
  const re = range.cloneRange(); re.collapse(false); re.insertNode(b);
  const rs = range.cloneRange(); rs.collapse(true); rs.insertNode(a);
  const r = document.createRange(); r.setStartAfter(a); r.setEndBefore(b);
  const out = [];
  for (const n of collectParts(r)) { const w = make(); n.parentNode.insertBefore(w, n); w.appendChild(n); out.push(w); }
  a.remove(); b.remove();
  return out;
}
let draftComment = null;
async function addComment() {
  const r = selRange() || lastRange;
  if (!r || r.collapsed || !r.toString().trim()) { toast('Select the text you want to comment on'); return; }
  History.push('cmt', true);
  const id = uid('c');
  const spans = wrapRange(r, () => { const s = document.createElement('span'); s.className = 'cmt'; s.dataset.c = id; return s; });
  if (!spans.length) { toast('Select some text to comment on'); return; }
  draftComment = id;
  getSelection().removeAllRanges();
  openPanel('comments');
}
function commentSpans(id) { return $$(`.cmt[data-c="${CSS.escape(id)}"]`, editor); }
function removeComment(id) {
  History.push('cmt', true);
  commentSpans(id).forEach(s => s.replaceWith(...s.childNodes));
  cur.comments = cur.comments.filter(c => c.id !== id);
}
function activateComment(id, scroll) {
  $$('.cmt.active', editor).forEach(s => s.classList.remove('active'));
  const spans = commentSpans(id); spans.forEach(s => s.classList.add('active'));
  $$('#rpBody .card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
  if (scroll && spans[0]) spans[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ========================================================== right panel */
let panelMode = null;
function openPanel(mode) {
  panelMode = mode; $('#rpanel').classList.add('open'); renderPanel();
  if (mode === 'find') setTimeout(() => { const f = $('#fq'); f && (f.focus(), f.select()); }, 20);
}
function closePanel() {
  if (draftComment) { removeComment(draftComment); draftComment = null; markChanged(); }
  panelMode = null; $('#rpanel').classList.remove('open'); Find.clear();
  $$('.cmt.active', editor).forEach(s => s.classList.remove('active'));
}
function renderPanel() {
  if (!panelMode || !cur) return;
  const body = $('#rpBody'), act = $('#rpActions');
  act.hidden = true; act.innerHTML = '';
  if (panelMode === 'comments') renderComments(body, act);
  else if (panelMode === 'changes') renderChanges(body, act);
  else if (panelMode === 'versions') renderVersions(body, act);
  else if (panelMode === 'find') Find.render(body);
  icons();
}
let showResolved = false;
function renderComments(body, act) {
  $('#rpTitle').textContent = 'Comments';
  act.hidden = false;
  act.innerHTML = `<button class="btn small outline" data-p="new"><i data-lucide="message-square-plus"></i>New</button>
    <label class="hint" style="display:inline-flex;gap:6px;align-items:center;margin-left:auto"><input type="checkbox" data-p="resolved" ${showResolved ? 'checked' : ''}>Show resolved</label>`;
  $('[data-p="new"]', act).onclick = addComment;
  $('[data-p="resolved"]', act).onchange = e => { showResolved = e.target.checked; renderPanel(); };
  let html = '';
  if (draftComment) {
    html += `<div class="card active" data-id="${draftComment}"><div class="quote">${esc(commentSpans(draftComment).map(s => s.textContent).join(' '))}</div>
      <textarea id="draftText" placeholder="Add a comment…"></textarea>
      <div class="row"><button class="btn small primary" data-c="post">Comment</button><button class="btn small" data-c="cancel">Cancel</button></div></div>`;
  }
  const list = cur.comments.filter(c => showResolved || !c.resolved);
  for (const c of list) {
    const quote = commentSpans(c.id).map(s => s.textContent).join(' ');
    html += `<div class="card ${c.resolved ? 'resolved' : ''}" data-id="${esc(c.id)}">
      <div class="who">${esc(c.author)}</div><div class="when">${fmtTime(c.time)}${c.resolved ? ' · Resolved' : ''}</div>
      <div class="quote">${quote ? esc(quote) : '<i>Text was deleted</i>'}</div>
      <div class="body">${esc(c.text)}</div>
      ${(c.replies || []).map(rp => `<div class="reply"><div class="who">${esc(rp.author)} <span class="when">${fmtTime(rp.time)}</span></div><div class="body">${esc(rp.text)}</div></div>`).join('')}
      <div class="row">
        <button class="btn small" data-c="reply">Reply</button>
        <button class="btn small" data-c="resolve">${c.resolved ? 'Reopen' : 'Resolve'}</button>
        <button class="btn small danger" data-c="delete">Delete</button>
      </div></div>`;
  }
  if (!html) html = `<div class="empty"><i data-lucide="message-square"></i>No comments yet. Select text and press <b>${isMac ? '⌘' : 'Ctrl'}+Alt+M</b>.</div>`;
  body.innerHTML = html;
  const dt = $('#draftText'); if (dt) setTimeout(() => dt.focus(), 10);
  body.onclick = async e => {
    const card = e.target.closest('.card'); if (!card) return;
    const id = card.dataset.id; const btn = e.target.closest('[data-c]');
    const c = cur.comments.find(x => x.id === id);
    if (!btn) { activateComment(id, true); return; }
    const a = btn.dataset.c;
    if (a === 'post') {
      const text = $('#draftText').value.trim(); if (!text) { $('#draftText').focus(); return; }
      cur.comments.unshift({ id, author: me(), time: Date.now(), text, resolved: false, replies: [] });
      draftComment = null; markChanged(); renderPanel();
    } else if (a === 'cancel') { removeComment(id); draftComment = null; markChanged(); renderPanel(); }
    else if (a === 'reply') {
      if ($('textarea', card)) return;
      const box = document.createElement('div'); box.className = 'reply';
      box.innerHTML = `<textarea placeholder="Reply…"></textarea><div class="row"><button class="btn small primary" data-c="send">Reply</button></div>`;
      card.appendChild(box); $('textarea', box).focus();
    } else if (a === 'send') {
      const text = $('textarea', card).value.trim(); if (!text) return;
      c.replies = c.replies || []; c.replies.push({ author: me(), time: Date.now(), text });
      markChanged(); renderPanel();
    } else if (a === 'resolve') {
      c.resolved = !c.resolved; commentSpans(id).forEach(s => s.classList.toggle('resolved', c.resolved));
      markChanged(); renderPanel();
    } else if (a === 'delete') { removeComment(id); markChanged(); renderPanel(); }
  };
  body.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { const b = e.target.closest('.card')?.querySelector('[data-c="post"],[data-c="send"]'); b && b.click(); } };
}
function renderChanges(body, act) {
  $('#rpTitle').textContent = 'Tracked changes';
  act.hidden = false;
  act.innerHTML = `<button class="btn small ${cur.track ? 'primary' : 'outline'}" data-p="track">${cur.track ? 'Tracking: on' : 'Tracking: off'}</button>
    <button class="btn small outline" data-p="acc"><i data-lucide="check-check"></i>Accept all</button>
    <button class="btn small outline" data-p="rej"><i data-lucide="x"></i>Reject all</button>`;
  $('[data-p="track"]', act).onclick = async () => { await toggleTrack(); renderPanel(); };
  $('[data-p="acc"]', act).onclick = () => acceptAll(true);
  $('[data-p="rej"]', act).onclick = () => acceptAll(false);
  const list = changes();
  if (!list.length) { body.innerHTML = `<div class="empty"><i data-lucide="git-compare"></i>No tracked changes.${cur.track ? '' : '<br>Turn on tracking to mark every insertion and deletion.'}</div>`; return; }
  body.innerHTML = list.map((el, i) => {
    const isIns = el.tagName === 'INS';
    const txt = el.textContent.trim() || (el.querySelector('img') ? '[image]' : '[space]');
    return `<div class="card" data-i="${i}"><div class="who">${esc(el.dataset.a || 'Unknown')} <span class="badge">${isIns ? 'Inserted' : 'Deleted'}</span></div>
      <div class="when">${el.dataset.t ? fmtTime(+el.dataset.t) : ''}</div>
      <div class="body ${isIns ? 'chg-ins' : 'chg-del'}">${esc(txt.length > 160 ? txt.slice(0, 160) + '…' : txt)}</div>
      <div class="row"><button class="btn small" data-c="acc"><i data-lucide="check"></i>Accept</button><button class="btn small" data-c="rej"><i data-lucide="x"></i>Reject</button></div></div>`;
  }).join('');
  body.onclick = e => {
    const card = e.target.closest('.card'); if (!card) return;
    const el = list[+card.dataset.i]; if (!el || !editor.contains(el)) { renderPanel(); return; }
    const b = e.target.closest('[data-c]');
    if (!b) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); return; }
    History.push('tc', true);
    b.dataset.c === 'acc' ? acceptEl(el) : rejectEl(el);
    afterDomChange();
  };
}
function renderVersions(body, act) {
  $('#rpTitle').textContent = 'Version history';
  act.hidden = false;
  act.innerHTML = `<button class="btn small primary" data-p="save"><i data-lucide="save"></i>Save current version</button>`;
  $('[data-p="save"]', act).onclick = saveVersionDialog;
  const vs = cur.versions;
  body.innerHTML = `<div class="hint" style="margin-bottom:10px">Lekh saves an automatic snapshot every 10 minutes while you edit (last 15 kept) plus every version you save by name (last 30 kept).</div>` +
    (vs.length ? vs.map(v => `<div class="version-row" data-id="${esc(v.id)}"><div class="meta"><div class="name">${esc(v.name)} ${v.auto ? '<span class="badge">auto</span>' : ''}</div>
      <div class="when">${fmtTime(v.time)}${v.author && v.author !== 'sync' ? ' · ' + esc(v.author) : ''}</div></div>
      <button class="icon-btn" data-v="view" title="Preview"><i data-lucide="eye"></i></button>
      <button class="icon-btn" data-v="restore" title="Restore"><i data-lucide="rotate-ccw"></i></button>
      <button class="icon-btn" data-v="del" title="Delete version"><i data-lucide="trash-2"></i></button></div>`).join('')
      : `<div class="empty"><i data-lucide="history"></i>No versions yet.</div>`);
  body.onclick = async e => {
    const row = e.target.closest('.version-row'); const b = e.target.closest('[data-v]'); if (!row || !b) return;
    const v = cur.versions.find(x => x.id === row.dataset.id); if (!v) return;
    if (b.dataset.v === 'view') {
      const ok = await modal({ title: `${v.name} — ${fmtTime(v.time)}`, wide: true,
        body: `<div class="preview-page">${sanitize(v.html)}</div>`,
        buttons: [{ label: 'Close', value: false }, { label: 'Restore this version', primary: true, value: true }] });
      if (ok) restoreVersion(v);
    } else if (b.dataset.v === 'restore') {
      if (await confirmDialog('Restore version?', `Your current text will be saved as a version first, so you can undo this.`, 'Restore')) restoreVersion(v);
    } else if (b.dataset.v === 'del') {
      cur.versions = cur.versions.filter(x => x !== v); cur.vDirty = true; await commitMeta(); renderPanel();
    }
  };
}
async function restoreVersion(v) {
  await saveNow();
  addVersion(cur, 'Before restoring “' + v.name + '”', false);
  History.push('restore', true);
  editor.innerHTML = sanitize(v.html); hdr.innerText = v.header || ''; ftr.innerText = v.footer || '';
  markChanged(); await saveNow(); renderPanel(); toast('Version restored');
}
async function saveVersionDialog() {
  const r = await promptDialog('Save version', [{ name: 'name', label: 'Version name', value: 'Version ' + new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }], 'Save');
  if (!r) return;
  pendingSave = true; await saveNow();
  addVersion(cur, r.name.trim() || 'Saved version', false);
  await commitMeta(); if (panelMode === 'versions') renderPanel();
  toast('Version saved');
}

/* ================================================================ find */
const Find = {
  matches: [], idx: -1, hl: 'highlights' in CSS,
  render(body) {
    $('#rpTitle').textContent = 'Find and replace';
    const s = this.state || (this.state = { q: '', r: '', cs: false, ww: false, re: false });
    body.innerHTML = `<div class="find-grid">
      <input type="text" id="fq" placeholder="Find" value="${esc(s.q)}">
      <input type="text" id="fr" placeholder="Replace with" value="${esc(s.r)}">
      <div><label class="chk"><input type="checkbox" id="fcs" ${s.cs ? 'checked' : ''}>Match case</label>
      <label class="chk"><input type="checkbox" id="fww" ${s.ww ? 'checked' : ''}>Whole words</label>
      <label class="chk"><input type="checkbox" id="fre" ${s.re ? 'checked' : ''}>Regex</label></div>
      <div class="row" style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn small outline" data-f="prev">Previous</button><button class="btn small outline" data-f="next">Next</button>
        <button class="btn small outline" data-f="one">Replace</button><button class="btn small primary" data-f="all">Replace all</button></div>
      <div class="find-count" id="fcount"></div></div>`;
    const sync = () => { s.q = $('#fq').value; s.r = $('#fr').value; s.cs = $('#fcs').checked; s.ww = $('#fww').checked; s.re = $('#fre').checked; this.build(); };
    ['fq', 'fcs', 'fww', 'fre'].forEach(id => $('#' + id).addEventListener('input', sync));
    $('#fr').addEventListener('input', () => { s.r = $('#fr').value; });
    $('#fq').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.go(e.shiftKey ? -1 : 1); } });
    body.onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; ({ prev: () => this.go(-1), next: () => this.go(1), one: () => this.replaceOne(), all: () => this.replaceAll() })[b.dataset.f](); };
    this.build();
  },
  regex() {
    const s = this.state; if (!s || !s.q) return null;
    let src = s.re ? s.q : s.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (s.ww) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    try { return new RegExp(src, 'gu' + (s.cs ? '' : 'i')); } catch { return null; }
  },
  build() {
    this.matches = []; const re = this.regex();
    if (re) {
      const segs = []; let text = '', lastBlock = null;
      const w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: n => n.nodeType === 1 ? (n.matches('.toc') || (!settings.markup && n.matches('del.tc')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT
      });
      let n;
      while ((n = w.nextNode())) { const b = blockOf(n); if (b !== lastBlock && text) text += '\n'; lastBlock = b; segs.push({ n, s: text.length }); text += n.data; }
      const at = off => { let lo = 0, hi = segs.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].s <= off) lo = mid; else hi = mid - 1; } const sg = segs[lo]; return [sg.n, clamp(off - sg.s, 0, sg.n.length)]; };
      let m, guard = 0;
      while ((m = re.exec(text)) && guard++ < 5000) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const r = document.createRange(); const [sn, so] = at(m.index); const [en, eo] = at(m.index + m[0].length);
        try { r.setStart(sn, so); r.setEnd(en, eo); this.matches.push({ r, text: m[0] }); } catch {}
      }
    }
    if (this.idx >= this.matches.length) this.idx = this.matches.length - 1;
    this.paint();
  },
  paint() {
    const c = $('#fcount');
    if (c) c.textContent = !this.state?.q ? '' : this.matches.length ? `${this.idx >= 0 ? this.idx + 1 + ' of ' : ''}${this.matches.length} match${this.matches.length > 1 ? 'es' : ''}` : (this.regex() ? 'No matches' : 'Invalid pattern');
    if (!this.hl) return;
    CSS.highlights.set('find-all', new Highlight(...this.matches.map(m => m.r)));
    const curM = this.matches[this.idx];
    if (curM) CSS.highlights.set('find-current', new Highlight(curM.r)); else CSS.highlights.delete('find-current');
  },
  go(d) {
    if (!this.matches.length) return;
    this.idx = (this.idx + d + this.matches.length) % this.matches.length;
    const r = this.matches[this.idx].r;
    const el = r.startContainer.parentElement; el && el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setRange(r.cloneRange()); lastRange = r.cloneRange();
    this.paint();
  },
  replacement(m) {
    const s = this.state;
    if (!s.re) return s.r;
    try { return m.text.replace(new RegExp(this.regex().source, this.regex().flags.replace('g', '')), s.r); } catch { return s.r; }
  },
  replaceOne() {
    if (this.idx < 0) { this.go(1); return; }
    const m = this.matches[this.idx]; if (!m) return;
    editor.focus({ preventScroll: true }); setRange(m.r.cloneRange());
    insertText(this.replacement(m));
    this.build(); if (this.matches.length) { this.idx = Math.min(this.idx, this.matches.length - 1) - 1; this.go(1); }
  },
  replaceAll() {
    if (!this.matches.length) return;
    const n = this.matches.length;
    editor.focus({ preventScroll: true }); History.push('replace', true);
    for (let i = this.matches.length - 1; i >= 0; i--) {
      const m = this.matches[i]; setRange(m.r.cloneRange());
      if (cur.track) trackedInsert(this.replacement(m)); else document.execCommand('insertText', false, this.replacement(m));
    }
    markChanged(); this.idx = -1; this.build(); toast(`Replaced ${n} occurrence${n > 1 ? 's' : ''}`);
  },
  clear() { this.matches = []; this.idx = -1; if (this.hl) { CSS.highlights.delete('find-all'); CSS.highlights.delete('find-current'); } }
};

/* ========================================================== insert helpers */
function insertTable(rows, cols) {
  const row = '<tr>' + '<td><br></td>'.repeat(cols) + '</tr>';
  insertHTMLAtCaret(`<table><tbody>${row.repeat(rows)}</tbody></table><p><br></p>`);
}
function tableMenu(anchor) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="grid-picker">${'<div></div>'.repeat(80)}</div><div class="grid-label">Insert table</div>`;
  const cells = $$('.grid-picker div', wrap); let sel = [0, 0];
  cells.forEach((c, i) => {
    const r = Math.floor(i / 10) + 1, col = (i % 10) + 1;
    c.onmouseenter = () => { sel = [r, col]; cells.forEach((cc, j) => cc.classList.toggle('on', Math.floor(j / 10) < r && (j % 10) < col)); $('.grid-label', wrap).textContent = `${r} × ${col}`; };
    c.onmousedown = e => e.preventDefault();
    c.onclick = () => { hideMenu(); insertTable(sel[0], sel[1]); };
  });
  showMenu(anchor, [{ node: wrap }, 'sep', { icon: 'table', label: 'Custom size…', act: async () => {
    const r = await promptDialog('Insert table', [{ name: 'r', label: 'Rows', type: 'number', value: 3 }, { name: 'c', label: 'Columns', type: 'number', value: 3 }], 'Insert');
    if (r) insertTable(clamp(+r.r || 1, 1, 100), clamp(+r.c || 1, 1, 20));
  } }]);
}
function currentCell() { return closestEl(selNode(), 'td, th'); }
const liveRows = tbl => [...tbl.rows].filter(r => !r.classList.contains('pg-gap'));
const ownCells = tbl => $$('td, th', tbl).filter(c => c.closest('table') === tbl && !c.parentElement.classList.contains('pg-gap'));
function tableGrid(tbl) {
  const grid = [], pos = new Map();
  liveRows(tbl).forEach((tr, ri) => {
    grid[ri] = grid[ri] || []; let c = 0;
    for (const cell of tr.cells) {
      while (grid[ri][c]) c++;
      for (let dr = 0; dr < cell.rowSpan; dr++) for (let dc = 0; dc < cell.colSpan; dc++) (grid[ri + dr] = grid[ri + dr] || [])[c + dc] = cell;
      pos.set(cell, { r: ri, c }); c += cell.colSpan;
    }
  });
  return { grid, pos, cols: Math.max(1, ...grid.map(r => r.length)) };
}
function selectedCells() {
  const r = selRange() || lastRange; if (!r) return [];
  const tbl = closestEl(r.startContainer, 'table') || closestEl(r.endContainer, 'table'); if (!tbl) return [];
  const c1 = closestEl(r.startContainer, 'td, th');
  if (r.collapsed) return c1 ? [c1] : [];
  const c2 = closestEl(r.endContainer, 'td, th');
  if (!c1 || !c2 || c1 === c2 || c1.closest('table') !== c2.closest('table')) return c1 ? [c1] : c2 ? [c2] : [];
  return cellRect(c1.closest('table'), c1, c2);
}
function cellRect(tbl, a, b) {          // Word-style rectangular block between two cells
  const { grid, pos } = tableGrid(tbl); const pa = pos.get(a), pb = pos.get(b); if (!pa || !pb) return [a];
  const r0 = Math.min(pa.r, pb.r), r1 = Math.max(pa.r + a.rowSpan, pb.r + b.rowSpan) - 1;
  const c0 = Math.min(pa.c, pb.c), c1 = Math.max(pa.c + a.colSpan, pb.c + b.colSpan) - 1;
  const out = new Set(); for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r]?.[c] && out.add(grid[r][c]);
  return [...out];
}
function paintCellSel() {
  $$('.cell-sel', editor).forEach(c => c.classList.remove('cell-sel'));
  $$('table.multi-sel', editor).forEach(t => t.classList.remove('multi-sel'));
  const r = selRange(); if (!r || r.collapsed) return;
  const cs = selectedCells(); if (cs.length < 2) return;
  cs.forEach(c => c.classList.add('cell-sel')); cs[0].closest('table').classList.add('multi-sel');
}
function colWidthsPx(tbl) {
  const { grid, pos, cols } = tableGrid(tbl); const z = settings.zoom / 100;
  const total = tbl.getBoundingClientRect().width / z; const w = Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    for (const row of grid) { const cell = row[c]; if (cell && cell.colSpan === 1) { w[c] = cell.getBoundingClientRect().width / z; break; } }
    if (!w[c]) w[c] = total / cols;
  }
  return { w, total };
}
function setColWidths(tbl, pcts) {
  tbl.querySelector(':scope > colgroup')?.remove();
  const cg = document.createElement('colgroup');
  pcts.forEach(p => { const c = document.createElement('col'); c.style.width = (Math.round(p * 100) / 100) + '%'; cg.appendChild(c); });
  tbl.prepend(cg);
}
function mergeCells(tbl, cells) {
  if (cells.length < 2) { toast('Select two or more cells to merge (drag across them)'); return false; }
  let { grid, pos } = tableGrid(tbl);
  let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1;
  const grow = x => { const p = pos.get(x); r0 = Math.min(r0, p.r); c0 = Math.min(c0, p.c); r1 = Math.max(r1, p.r + x.rowSpan - 1); c1 = Math.max(c1, p.c + x.colSpan - 1); };
  cells.forEach(grow);
  for (let changed = true; changed;) {
    changed = false;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const x = grid[r]?.[c]; if (!x) continue; const p = pos.get(x);
      if (p.r < r0 || p.c < c0 || p.r + x.rowSpan - 1 > r1 || p.c + x.colSpan - 1 > c1) { grow(x); changed = true; }
    }
  }
  const inRect = new Set(); for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r]?.[c] && inRect.add(grid[r][c]);
  const first = grid[r0][c0];
  const empty = x => !x.textContent.replace(/​/g, '').trim() && !x.querySelector('img, table');
  for (const x of inRect) {
    if (x === first) continue;
    if (!empty(x)) { if (empty(first)) first.innerHTML = ''; else first.appendChild(document.createElement('br')); while (x.firstChild) first.appendChild(x.firstChild); }
    x.remove();
  }
  first.colSpan = c1 - c0 + 1; first.rowSpan = r1 - r0 + 1;
  ({ grid } = tableGrid(tbl));
  liveRows(tbl).forEach((tr, ri) => {
    if (tr.cells.length) return;
    new Set(grid[ri] || []).forEach(x => { if (x.rowSpan > 1) x.rowSpan--; });
    tr.remove();
  });
  if (first.colSpan === 1) first.removeAttribute('colspan'); if (first.rowSpan === 1) first.removeAttribute('rowspan');
  moveCellTo(first); return true;
}
function splitCell(tbl, cell) {
  if (!cell || (cell.colSpan === 1 && cell.rowSpan === 1)) { toast('Click inside a merged cell to split it'); return false; }
  const { pos } = tableGrid(tbl); const p = pos.get(cell); const rows = liveRows(tbl);
  const cs = cell.colSpan, rs = cell.rowSpan; cell.removeAttribute('colspan'); cell.removeAttribute('rowspan');
  for (let r = p.r; r < p.r + rs; r++) for (let c = p.c; c < p.c + cs; c++) {
    if (r === p.r && c === p.c) continue;
    const n = document.createElement(cell.tagName.toLowerCase()); n.innerHTML = '<br>';
    if (cell.style.verticalAlign) n.style.verticalAlign = cell.style.verticalAlign;
    const tr = rows[r]; if (!tr) continue;
    const after = [...tr.cells].find(x => pos.get(x) && pos.get(x).c > c);
    tr.insertBefore(n, after || null);
  }
  return true;
}
function tableOp(op) {
  const tbl = closestEl(selNode(), 'table'); if (!tbl) return;
  const cells = selectedCells(); const cell = cells[0] || currentCell();
  if (!cell && !['delTable', 'banded', 'fitPage', 'fitContent', 'distribute'].includes(op)) return;
  History.push('tbl', true); Pager.strip();
  const row = cell?.parentElement; const idx = cell ? cell.cellIndex : 0;
  const blankRow = like => { const tr = document.createElement('tr'); [...like.cells].forEach(c => { const n = document.createElement(c.tagName === 'TH' && like.rowIndex === 0 ? 'td' : c.tagName.toLowerCase()); n.innerHTML = '<br>'; if (c.colSpan > 1) n.colSpan = c.colSpan; tr.appendChild(n); }); return tr; };
  const dropCols = () => tbl.querySelector(':scope > colgroup')?.remove();
  switch (op) {
    case 'rowAbove': row.before(blankRow(row)); break;
    case 'rowBelow': row.after(blankRow(row)); break;
    case 'colLeft': case 'colRight':
      dropCols();
      liveRows(tbl).forEach(tr => { const ref = tr.cells[Math.min(idx, tr.cells.length - 1)]; const n = document.createElement(ref?.tagName === 'TH' ? 'th' : 'td'); n.innerHTML = '<br>'; ref ? (op === 'colLeft' ? ref.before(n) : ref.after(n)) : tr.appendChild(n); });
      break;
    case 'delRow': if (liveRows(tbl).length <= 1) { tbl.remove(); break; } row.remove(); break;
    case 'delCol': dropCols(); if (row.cells.length <= 1) { tbl.remove(); break; } liveRows(tbl).forEach(tr => tr.cells[idx] && tr.cells[idx].remove()); break;
    case 'delTable': tbl.remove(); break;
    case 'header': {
      const first = liveRows(tbl)[0]; const toTh = [...first.cells].some(c => c.tagName === 'TD');
      const wasIn = cell && cell.parentElement === first ? cell.cellIndex : -1;
      [...first.cells].forEach(c => { const n = document.createElement(toTh ? 'th' : 'td'); n.innerHTML = c.innerHTML; ['colSpan', 'rowSpan'].forEach(k => { if (c[k] > 1) n[k] = c[k]; }); if (c.getAttribute('style')) n.setAttribute('style', c.getAttribute('style')); c.replaceWith(n); });
      if (wasIn >= 0) moveCellTo(first.cells[wasIn]);
      break;
    }
    case 'merge': mergeCells(tbl, cells); break;
    case 'split': splitCell(tbl, cell); break;
    case 'vtop': case 'vmiddle': case 'vbottom': cells.forEach(c => { c.style.verticalAlign = op === 'vtop' ? '' : op.slice(1); }); break;
    case 'shade': cells.forEach(c => { c.style.backgroundColor = $('#shadeColor').value; }); break;
    case 'noShade': cells.forEach(c => { c.style.backgroundColor = ''; }); break;
    case 'banded': if (tbl.hasAttribute('data-banded')) tbl.removeAttribute('data-banded'); else tbl.setAttribute('data-banded', ''); break;
    case 'distribute': { const n = tableGrid(tbl).cols; delete tbl.dataset.fit; setColWidths(tbl, Array(n).fill(100 / n)); break; }
    case 'fitContent': delete tbl.dataset.fit; tbl.dataset.fit = 'auto'; dropCols(); break;
    case 'fitPage': delete tbl.dataset.fit; break;
  }
  $$('[style=""]', tbl).forEach(x => x.removeAttribute('style'));
  markChanged(); updateToolbar(); refreshTableTab(); paintCellSel();
  if (!editor.contains(tbl)) $('#tableBar').classList.remove('show'); else setTimeout(refreshTableBar, 0);
}
function setTableAttr(key, val, dflt) {
  const tbl = closestEl(selNode(), 'table'); if (!tbl) return;
  History.push('tbl', true);
  if (val === dflt) delete tbl.dataset[key]; else tbl.dataset[key] = val;
  if (key === 'ts' && val === 'minimal' && !tbl.dataset.borders) tbl.dataset.borders = 'horiz';
  if (key === 'wrap' && val && !tbl.nextElementSibling) { const p = document.createElement('p'); p.innerHTML = '<br>'; tbl.after(p); }
  markChanged(); refreshTableTab(); Pager.schedule(30);
}
function refreshTableTab() {
  const tbl = closestEl(selNode(), 'table'); const tab = $('#tabTable');
  if (!tbl) {
    if (!tab.hidden && tab.classList.contains('active')) $('.tab[data-tab="home"]').click();
    tab.hidden = true; return;
  }
  tab.hidden = false;
  $('#selTblStyle').value = tbl.dataset.ts || 'grid';
  $('#selTblBorders').value = tbl.dataset.borders || 'all';
  $('#selTblWrap').value = tbl.dataset.wrap || '';
  const first = liveRows(tbl)[0];
  $('#btnTblHeader').classList.toggle('on', !!first && [...first.cells].every(c => c.tagName === 'TH'));
  $('#btnTblBanded').classList.toggle('on', tbl.hasAttribute('data-banded'));
  $('#btnFitContent').classList.toggle('on', tbl.dataset.fit === 'auto');
  $('#btnFitPage').classList.toggle('on', tbl.dataset.fit !== 'auto');
  const va = (currentCell()?.style.verticalAlign) || 'top';
  [['vaTop', 'top'], ['vaMiddle', 'middle'], ['vaBottom', 'bottom']].forEach(([id, v]) => $('#' + id).classList.toggle('on', va === v));
}
/* drag a column border to resize */
let colDrag = null;
editor.addEventListener('mousemove', e => {
  if (colDrag) return;
  const cell = e.target.closest?.('td, th'); let hit = null;
  if (cell && editor.contains(cell) && !cell.parentElement.classList.contains('pg-gap')) {
    const r = cell.getBoundingClientRect();
    if (Math.abs(e.clientX - r.right) < 5 && cell.nextElementSibling) hit = cell;
    else if (Math.abs(e.clientX - r.left) < 5 && cell.previousElementSibling) hit = cell.previousElementSibling;
  }
  editor.classList.toggle('col-resize', !!hit); colDrag === null && (editor._rc = hit);
});
editor.addEventListener('mousedown', e => {
  const cell = editor._rc; if (!cell || !editor.classList.contains('col-resize') || e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const tbl = cell.closest('table'); History.push('tbl', true); Pager.strip();
  const { pos, cols } = tableGrid(tbl); const ci = pos.get(cell).c + cell.colSpan - 1;
  if (ci >= cols - 1) return;
  const { w, total } = colWidthsPx(tbl);
  delete tbl.dataset.fit;
  colDrag = { tbl, w, total, ci, x0: e.clientX, z: settings.zoom / 100 };
  document.body.classList.add('dragging-col');
}, true);
window.addEventListener('mousemove', e => {
  if (!colDrag) return;
  const { w, total, ci, x0, z, tbl } = colDrag; const d = (e.clientX - x0) / z; const min = 24;
  const ww = w.slice(); const a = clamp(ww[ci] + d, min, ww[ci] + ww[ci + 1] - min); ww[ci + 1] = ww[ci] + ww[ci + 1] - a; ww[ci] = a;
  const sum = ww.reduce((s, x) => s + x, 0) || total;
  setColWidths(tbl, ww.map(x => (x / sum) * 100));
});
window.addEventListener('mouseup', () => { if (!colDrag) return; colDrag = null; document.body.classList.remove('dragging-col'); markChanged(); });
function moveCell(dir) {
  const cell = currentCell(); if (!cell) return false;
  Pager.strip();
  const tbl = cell.closest('table'); const all = $$('td, th', tbl).filter(c => c.closest('table') === tbl);
  let i = all.indexOf(cell) + dir;
  if (i >= all.length) { tableOp('rowBelow'); i = all.length; return moveCellTo($$('td, th', tbl).filter(c => c.closest('table') === tbl)[i]); }
  if (i < 0) return true;
  return moveCellTo(all[i]);
}
function moveCellTo(c) { if (!c) return true; const r = document.createRange(); r.selectNodeContents(c); setRange(r); return true; }

async function compressImage(file) {
  const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  if (file.type === 'image/gif') return { data: dataUrl };
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const max = 1600; const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight || 1));
  const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const png = file.type === 'image/png' || file.type === 'image/svg+xml' || file.type === 'image/webp';
  if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(img, 0, 0, w, h);
  let out = c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86);
  if (png && out.length > 900e3) { ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); out = c.toDataURL('image/jpeg', 0.86); }
  return { data: out.length < dataUrl.length || s < 1 || file.type === 'image/svg+xml' || file.type === 'image/webp' ? out : dataUrl, w };
}
async function insertImageFile(file) {
  try {
    const { data, w } = await compressImage(file);
    const contentW = (pageDims().w - cur.page.margins.l - cur.page.margins.r) * 96;
    const pct = w ? Math.min(100, Math.round((w / contentW) * 100)) : 100;
    insertHTMLAtCaret(`<img src="${data}" alt="${esc(file.name.replace(/\.[^.]+$/, ''))}" style="width:${pct}%">`);
  } catch (e) { toast('Could not insert that image', { err: true }); }
}

function updateTOCs(silent) {
  const tocs = $$('.toc', editor); if (!tocs.length) return;
  const hs = $$('h1, h2, h3', editor).filter(h => !h.closest('.toc') && h.textContent.trim());
  hs.forEach(h => { if (!h.id) h.id = 'h-' + Math.random().toString(36).slice(2, 9); });
  const inner = `<div class="toc-title">Contents</div>` + (hs.length
    ? hs.map(h => `<a class="l${h.tagName[1]}" href="#${h.id}">${esc(h.textContent.trim())}</a>`).join('')
    : `<div style="color:#8a919d">Add headings (Heading 1–3) and they will appear here.</div>`);
  tocs.forEach(t => { t.setAttribute('contenteditable', 'false'); if (t.innerHTML !== inner) t.innerHTML = inner; });
  if (!silent) { markChanged(); toast('Contents updated'); }
}

async function linkDialog(existing) {
  const r0 = selRange() || lastRange; const a = existing || closestEl(r0?.startContainer, 'a');
  const text = a ? a.textContent : (r0 ? r0.toString() : '');
  const res = await promptDialog(a ? 'Edit link' : 'Insert link', [
    { name: 'url', label: 'Address', value: a ? a.getAttribute('href') : '', placeholder: 'https://…' },
    { name: 'text', label: 'Text to display', value: text }], a ? 'Save' : 'Insert');
  if (!res || !res.url.trim()) return;
  let url = res.url.trim();
  if (/^\s*(javascript|data|vbscript):/i.test(url)) { toast('That kind of link is not allowed', { err: true }); return; }
  if (!/^(https?:|mailto:|tel:|#|\/)/i.test(url)) url = (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url) ? 'mailto:' : 'https://') + url;
  editor.focus({ preventScroll: true }); History.push('link', true);
  if (a) { a.href = url; if (res.text && res.text !== a.textContent) a.textContent = res.text; markChanged(); return; }
  if (r0) setRange(r0);
  if (r0 && !r0.collapsed && (!res.text || res.text === text)) document.execCommand('createLink', false, url);
  else document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(res.text || url)}</a>&nbsp;`);
  markChanged();
}

/* ================================================================ floatbars */
let selImg = null, selLink = null;
function placeBar(bar, rect, above) {
  bar.classList.add('show');
  const cr = canvas.getBoundingClientRect();
  let top = above ? rect.top - cr.top + canvas.scrollTop - bar.offsetHeight - 8 : rect.bottom - cr.top + canvas.scrollTop + 8;
  if (above && top < canvas.scrollTop + 4) top = rect.bottom - cr.top + canvas.scrollTop + 8;
  const left = clamp(rect.left - cr.left + canvas.scrollLeft, canvas.scrollLeft + 8, canvas.scrollLeft + canvas.clientWidth - bar.offsetWidth - 8);
  bar.style.top = top + 'px'; bar.style.left = left + 'px';
}
function hideFloatbars(except) { ['tableBar', 'imageBar', 'linkBar'].forEach(id => { if (id !== except) $('#' + id).classList.remove('show'); }); if (except !== 'imageBar') selectImage(null); }
function selectImage(img) {
  if (selImg && selImg !== img) selImg.classList.remove('img-selected');
  selImg = img;
  if (img) { img.classList.add('img-selected'); placeBar($('#imageBar'), img.getBoundingClientRect(), false); placeHandle(); }
  else { $('#imageBar').classList.remove('show'); imgHandle.classList.remove('show'); }
}
function refreshTableBar() {
  const tbl = closestEl(selNode(), 'table');
  if (tbl && document.activeElement === editor) placeBar($('#tableBar'), tbl.getBoundingClientRect(), true);
  else $('#tableBar').classList.remove('show');
}
async function imageOp(op) {
  const img = selImg; if (!img) return;
  History.push('img', true);
  if (/^\d+$/.test(op)) img.style.width = op + '%';
  else if (op === 'wrap') {
    History.lastType = '';
    const cur = imgWrapOf(img);
    const item = (v, label, icon) => ({ icon: cur === v ? 'check' : icon, label, act: () => { History.push('img', true); setImgWrap(img, v); afterImgChange(); } });
    showMenu($('[data-img="wrap"]'), [
      item('inline', 'In line with text', 'type'),
      { header: 'Text wraps around' },
      item('left', 'Image on the left', 'align-left'), item('right', 'Image on the right', 'align-right'),
      { header: 'On its own line (top and bottom)' },
      item('block-left', 'Left', 'align-left'), item('block-center', 'Centre', 'align-center'), item('block-right', 'Right', 'align-right')
    ]);
    return;
  }
  else if (['left', 'right', 'center'].includes(op)) setImgWrap(img, op === 'center' ? 'block-center' : op);
  else if (op === 'delete') { img.remove(); selectImage(null); markChanged(); return; }
  else if (op === 'alt') { const r = await promptDialog('Alt text', [{ name: 'alt', label: 'Describe the image for screen readers', value: img.alt }], 'Save'); if (r) img.alt = r.alt; }
  afterImgChange();
}
function imgWrapOf(img) {
  const s = img.style;
  if (s.float === 'left' || s.float === 'right') return s.float;
  if (s.display === 'block') return s.marginLeft === 'auto' && s.marginRight === 'auto' ? 'block-center' : s.marginLeft === 'auto' ? 'block-right' : 'block-left';
  return 'inline';
}
function setImgWrap(img, v) {
  const s = img.style; s.float = ''; s.display = ''; s.margin = '';
  if (v === 'left') { s.float = 'left'; s.margin = '2px 14px 6px 0'; }
  else if (v === 'right') { s.float = 'right'; s.margin = '2px 0 6px 14px'; }
  else if (v === 'block-center') { s.display = 'block'; s.margin = '6px auto'; }
  else if (v === 'block-left') { s.display = 'block'; s.margin = '6px auto 6px 0'; }
  else if (v === 'block-right') { s.display = 'block'; s.margin = '6px 0 6px auto'; }
}
function afterImgChange() { markChanged(); Pager.schedule(30); setTimeout(() => selImg && selectImage(selImg), 60); }
/* drag the corner handle to resize an image */
const imgHandle = $('#imgHandle'); let imgDrag = null;
function placeHandle() {
  if (!selImg) { imgHandle.classList.remove('show'); return; }
  const r = selImg.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
  imgHandle.style.left = (r.right - cr.left + canvas.scrollLeft - 8) + 'px';
  imgHandle.style.top = (r.bottom - cr.top + canvas.scrollTop - 8) + 'px';
  imgHandle.classList.add('show');
}
imgHandle.addEventListener('pointerdown', e => {
  if (!selImg) return; e.preventDefault(); imgHandle.setPointerCapture(e.pointerId);
  History.push('img', true);
  imgDrag = { x0: e.clientX, w0: selImg.getBoundingClientRect().width, z: settings.zoom / 100, cw: editor.clientWidth };
  $('#imageBar').classList.remove('show');
});
imgHandle.addEventListener('pointermove', e => {
  if (!imgDrag || !selImg) return;
  const w = (imgDrag.w0 + (e.clientX - imgDrag.x0)) / imgDrag.z;
  selImg.style.width = clamp(Math.round(w / imgDrag.cw * 1000) / 10, 3, 100) + '%';
  placeHandle();
});
imgHandle.addEventListener('pointerup', () => { if (!imgDrag) return; imgDrag = null; afterImgChange(); });

/* =================================================================== editor events */
function gapBeside(back) {
  const r = selRange(); if (!r || !r.collapsed) return null;
  const c = r.startContainer, o = r.startOffset; let n;
  if (c.nodeType === 3) { if (back ? o > 0 : o < c.length) return null; n = back ? c.previousSibling : c.nextSibling; }
  else n = back ? c.childNodes[o - 1] : c.childNodes[o];
  while (n && n.nodeType === 3 && !n.data.length) n = back ? n.previousSibling : n.nextSibling;
  if (n && n.nodeType === 1 && n.classList.contains('pg-gap')) return n;
  const blk = blockOf(c) || closestEl(c, 'li'); if (!blk) return null;     // caret at the start/end of a block next to a page gap
  const pre = document.createRange();
  if (back) { pre.setStart(blk, 0); pre.setEnd(c, o); } else { pre.setStart(c, o); pre.setEnd(blk, blk.childNodes.length); }
  if (pre.toString().replace(/\u200B/g, '') || pre.cloneContents().querySelector?.('img, sup.fn')) return null;
  let x = blk;
  while (x && x !== editor) { const sib = back ? x.previousElementSibling : x.nextElementSibling; if (sib) return sib.classList.contains('pg-gap') ? sib : null; x = x.parentElement; }
  return null;
}
editor.addEventListener('beforeinput', e => {
  if (!cur) return;
  const t = e.inputType;
  if (t.startsWith('delete')) {
    const back = /Backward/.test(t);
    const g = gapBeside(back);
    if (g) {
      e.preventDefault(); g.remove();
      History.push('del', true);
      if (cur.track) { trackedDelete(t) || document.execCommand(back ? 'delete' : 'forwardDelete'); }
      else document.execCommand(back ? 'delete' : 'forwardDelete');
      markChanged(); return;
    }
  }
  if (t === 'historyUndo') { e.preventDefault(); History.undo(); return; }
  if (t === 'historyRedo') { e.preventDefault(); History.redoOp(); return; }
  History.push(t.startsWith('insert') ? 'type' : t.startsWith('delete') ? 'del' : t, t === 'insertParagraph' || t.startsWith('format'));
  if (t === 'insertText' && AC.quote(e)) { markChanged(); return; }
  if (!cur.track) return;
  if (t === 'insertText' || t === 'insertReplacementText') {
    let text = e.data ?? (e.dataTransfer && e.dataTransfer.getData('text/plain'));
    if (text == null) return;
    e.preventDefault();
    if (t === 'insertReplacementText') { const tr = e.getTargetRanges?.()[0]; if (tr) { const r = document.createRange(); r.setStart(tr.startContainer, tr.startOffset); r.setEnd(tr.endContainer, tr.endOffset); setRange(r); } }
    trackedInsert(text); markChanged();
  } else if (t.startsWith('delete')) {
    if (trackedDelete(t)) { e.preventDefault(); markChanged(); }
  } else if (t === 'insertFromDrop') { e.preventDefault(); }
});
editor.addEventListener('input', e => {
  if (!editor.firstElementChild && editor.textContent.trim() === '') editor.innerHTML = '<p><br></p>';
  if (e.inputType === 'insertText' && e.data && e.data.length === 1) AC.onInput(e.data);
  const li = closestEl(selNode(), 'ul.checklist > li');
  if (li && e.inputType === 'insertParagraph') li.dataset.checked = 'false';
  markChanged();
});
editor.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    if (moveCell(e.shiftKey ? -1 : 1)) return;
    if (closestEl(selNode(), 'li')) { listIndent(e.shiftKey ? -1 : 1); return; }
    if (e.shiftKey) { indent(-1); return; }
    if (cur.track) insertText('\t');
    else insertHTMLAtCaret('<span style="white-space:pre">\t</span>');
    return;
  }
  if (e.key === 'Enter' && mod) { e.preventDefault(); act.pageBreak(); return; }
  const li = closestEl(selNode(), 'li'); const r = selRange();
  if (li && r && r.collapsed && !mod && !e.shiftKey && (e.key === 'Enter' || e.key === 'Backspace')) {
    const own = [...li.childNodes].filter(c => !isList(c));
    const empty = !own.some(c => (c.textContent || '').replace(/\u200B/g, '').trim() || (c.nodeType === 1 && c.querySelector?.('img')) || c.tagName === 'IMG');
    const pre = document.createRange(); pre.setStart(li, 0); pre.setEnd(r.startContainer, r.startOffset);
    const atStart = !pre.toString().replace(/\u200B/g, '') && !pre.cloneContents().querySelector('img');
    if ((e.key === 'Enter' && empty) || (e.key === 'Backspace' && atStart && !cur.track)) { e.preventDefault(); listIndent(-1); }
  }
});
editor.addEventListener('paste', async e => {
  const cd = e.clipboardData; if (!cd || !cur) return;
  const files = [...(cd.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); for (const f of files) await insertImageFile(f); return; }
  const plain = cd.getData('text/plain'); const html = cd.getData('text/html');
  if (cur.track || forcePlain || !html) {
    e.preventDefault(); forcePlain = false;
    if (plain) insertText(plain);
    return;
  }
  e.preventDefault();
  History.push('paste', true);
  document.execCommand('insertHTML', false, cleanPastedHTML(html));
  markChanged();
});
function cleanPastedHTML(html) {
  html = html.replace(/<(span|div)[^>]*class="pg-gap"[^>]*><\/\1>/g, '').replace(/<tr[^>]*class="pg-gap"[^>]*>[\s\S]*?<\/tr>/g, '');
  const clean = DOMPurify.sanitize(html.replace(/<!--[\s\S]*?-->/g, ''), { ...SANITIZE, FORBID_ATTR: ['class', 'id', 'lang', 'width', 'height'] });
  const t = document.createElement('template'); t.innerHTML = clean;
  const keep = ['font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'color', 'background-color', 'vertical-align', 'text-align', 'font-size', 'font-family', 'text-indent', 'line-height', 'margin-left'];
  $$('[style]', t.content).forEach(el => {
    const s = el.style; const out = [];
    for (const p of keep) {
      let v = s.getPropertyValue(p); if (!v) continue;
      if (p === 'color' && /^(rgb\(0, 0, 0\)|#000000|black|windowtext)$/i.test(v)) continue;
      if (p === 'background-color' && /^(transparent|rgba\(0, 0, 0, 0\)|rgb\(255, 255, 255\)|#ffffff|white)$/i.test(v)) continue;
      if (p === 'font-weight' && /^(normal|400)$/.test(v)) continue;
      if (p === 'font-style' && v === 'normal') continue;
      out.push(`${p}:${v}`);
    }
    if (el.tagName === 'IMG') out.push('max-width:100%');
    out.length ? el.setAttribute('style', out.join(';')) : el.removeAttribute('style');
  });
  $$('b, strong', t.content).forEach(b => { if (/^(normal|400)$/.test(b.style.fontWeight)) b.replaceWith(...b.childNodes); });
  $$('span:not([style])', t.content).forEach(s => s.replaceWith(...s.childNodes));
  return t.innerHTML;
}
editor.addEventListener('drop', async e => {
  const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
  if (pos) { editor.focus(); setRange(pos); }
  for (const f of files) await insertImageFile(f);
});
editor.addEventListener('mousedown', e => {
  const li = e.target.closest && e.target.closest('ul.checklist > li');
  if (li && editor.contains(li) && e.clientX < li.getBoundingClientRect().left) {
    e.preventDefault(); History.push('check', true);
    li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true'; markChanged();
  }
});
editor.addEventListener('click', e => {
  const img = e.target.closest('img');
  if (img && editor.contains(img)) { hideFloatbars('imageBar'); selectImage(img); return; }
  selectImage(null);
  const tocA = e.target.closest('.toc a');
  if (tocA) { e.preventDefault(); const h = document.getElementById(tocA.getAttribute('href').slice(1)); h && h.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const a = e.target.closest('a');
  if (a && editor.contains(a)) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); return; }
    selLink = a; $('#linkHref').textContent = a.getAttribute('href'); $('#linkOpen').href = a.href;
    placeBar($('#linkBar'), a.getBoundingClientRect(), false);
  } else $('#linkBar').classList.remove('show');
  const fnRef = e.target.closest('sup.fn');
  if (fnRef) { Pager.focusNote(fnRef.dataset.fid); return; }
  const cm = e.target.closest('.cmt');
  if (cm) { if (panelMode !== 'comments') openPanel('comments'); activateComment(cm.dataset.c, false); }
});
document.addEventListener('selectionchange', () => {
  const r = selRange();
  if (r) { lastRange = r.cloneRange(); updateToolbar(); refreshTableBar(); refreshTableTab(); paintCellSel(); Nav.mark(); rulerSoon(); }
});
editor.addEventListener('blur', () => setTimeout(() => { if (!document.activeElement || !$('#tableBar').contains(document.activeElement)) refreshTableBar(); }, 150));
canvas.addEventListener('scroll', () => { if (selImg) { placeBar($('#imageBar'), selImg.getBoundingClientRect(), false); placeHandle(); } }, { passive: true });
[hdr, ftr].forEach(f => {
  f.addEventListener('input', markChanged);
  f.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.blur(); } });
  f.addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\n+/g, ' ')); });
});

/* toolbar wiring: keep editor selection when clicking buttons */
$$('.ribbon button, .floatbar button, .floatbar a').forEach(b => b.addEventListener('mousedown', e => { if (!b.closest('.tabs')) e.preventDefault(); }));
$$('[data-cmd]').forEach(b => b.addEventListener('click', () => {
  const c = b.dataset.cmd;
  if (c === 'insertUnorderedList') toggleList('UL'); else if (c === 'insertOrderedList') toggleList('OL'); else exec(c);
}));
$('#selStyle').addEventListener('change', e => applyBlockStyle(e.target.value));
$('#selFont').addEventListener('change', e => exec('fontName', e.target.value));
$('#selSize').addEventListener('change', e => applyFontSize(+e.target.value));
$('#selLine').addEventListener('change', e => { if (e.target.value) lineSpacing(e.target.value); e.target.value = ''; });
$('#foreColor').addEventListener('input', e => { $('#foreSwatch').style.background = e.target.value; });
$('#foreColor').addEventListener('change', e => exec('foreColor', e.target.value));
$('#backColor').addEventListener('input', e => { $('#backSwatch').style.background = e.target.value; });
$('#backColor').addEventListener('change', e => exec('hiliteColor', e.target.value));
$$('[data-tbl]').forEach(b => b.addEventListener('click', () => tableOp(b.dataset.tbl)));
$('#selTblStyle').addEventListener('change', e => setTableAttr('ts', e.target.value, 'grid'));
$('#selTblBorders').addEventListener('change', e => setTableAttr('borders', e.target.value, 'all'));
$('#selTblWrap').addEventListener('change', e => setTableAttr('wrap', e.target.value, ''));
$('#shadeColor').addEventListener('input', e => { $('#shadeSwatch').style.background = e.target.value; });
$('#shadeColor').addEventListener('change', () => tableOp('shade'));
$$('[data-img]').forEach(b => b.addEventListener('click', () => imageOp(b.dataset.img)));
$$('[data-lnk]').forEach(b => b.addEventListener('click', () => {
  if (!selLink) return;
  if (b.dataset.lnk === 'edit') linkDialog(selLink);
  else { History.push('link', true); selLink.replaceWith(...selLink.childNodes); markChanged(); }
  $('#linkBar').classList.remove('show');
}));
$$('.tab[data-tab]').forEach(t => t.addEventListener('click', () => {
  $$('.tab[data-tab]').forEach(x => x.classList.toggle('active', x === t));
  $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === t.dataset.tab));
}));
$('#zoomRange').addEventListener('input', e => setZoom(+e.target.value));
$('#selPage').addEventListener('change', async e => {
  if (e.target.value === 'Custom') {
    const [pw, ph] = portraitDims(cur);
    const r = await promptDialog('Custom page size (inches)', [{ name: 'w', label: 'Width', type: 'number', step: '0.01', value: pw }, { name: 'h', label: 'Height', type: 'number', step: '0.01', value: ph }], 'Apply');
    if (!r) { applyPage(); return; }
    const a = clamp(+r.w || 8.27, 2, 30), b = clamp(+r.h || 11.69, 2, 40);
    Object.assign(cur.page, { size: 'Custom', w: Math.min(a, b), h: Math.max(a, b), orient: a > b ? 'landscape' : 'portrait' });
  } else { cur.page.size = e.target.value; delete cur.page.w; delete cur.page.h; }
  applyPage(); await commitMeta();
});
$('#selVAlign').addEventListener('change', async e => { cur.page.valign = e.target.value === 'top' ? undefined : e.target.value; if (!cur.page.valign) delete cur.page.valign; Pager.run(); await commitMeta(); });
$('#selMargin').addEventListener('change', async e => {
  if (e.target.value === 'custom') {
    const m = cur.page.margins;
    const r = await promptDialog('Custom margins (inches)', ['t', 'b', 'l', 'r'].map(k => ({ name: k, label: { t: 'Top', b: 'Bottom', l: 'Left', r: 'Right' }[k], type: 'number', step: '0.05', value: m[k] })), 'Apply');
    if (r) cur.page.margins = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clamp(+v || 0, 0, 4)]));
  } else cur.page.margins = { ...MARGINS[e.target.value] };
  applyPage(); await commitMeta();
});
let titleT = null;
$('#docTitle').addEventListener('input', e => {
  if (!cur) return;
  cur.title = e.target.value.trim() || 'Untitled document'; document.title = cur.title + ' — Lekh';
  clearTimeout(titleT); titleT = setTimeout(() => commitMeta(), 500);
});
$('#docTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } });
$('#docSearch').addEventListener('input', renderDocList);
$('#fileImage').addEventListener('change', async e => { for (const f of e.target.files) await insertImageFile(f); e.target.value = ''; });
$('#fileImport').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await importFile(f); });
$('#syncPill').addEventListener('click', () => Vault.locked() ? unlockDialog() : act.syncSettings());

/* ============================================================ footnotes */
function insertFootnote() {
  restoreSel(); if (!selRange()) { toast('Click in the text where the footnote number should go'); return; }
  const r = selRange(); if (!r.collapsed) { r.collapse(false); setRange(r); }
  const fid = uid('f');
  insertAtom(atom('sup', 'fn', { fid, note: '' }));
  Pager.run(); setTimeout(() => Pager.focusNote(fid), 30);
}
const supFor = fid => editor.querySelector(`sup.fn[data-fid="${CSS.escape(fid)}"]`);
const ov = $('#overlays');
ov.addEventListener('input', e => {
  const t = e.target.closest('.fn-text'); if (!t) return;
  const sup = supFor(t.dataset.fid); if (!sup) return;
  History.push('fn'); sup.dataset.note = t.innerText.replace(/\n+$/, ''); markChanged();
});
ov.addEventListener('keydown', e => {
  const t = e.target.closest('.fn-text'); if (!t) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const sup = supFor(t.dataset.fid); t.blur(); if (sup) { editor.focus({ preventScroll: true }); const r = document.createRange(); r.setStartAfter(sup); r.collapse(true); setRange(r); } }
  if (e.key === 'Escape') t.blur();
});
ov.addEventListener('paste', e => { if (!e.target.closest('.fn-text')) return; e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s+/g, ' ')); });
ov.addEventListener('focusout', () => setTimeout(() => { if (Pager.pendingRender && !ov.contains(document.activeElement)) Pager.run(); }, 50));
ov.addEventListener('mousedown', e => { if (e.target.closest('.fn-del, .ov-hf')) e.preventDefault(); });
ov.addEventListener('click', async e => {
  const del = e.target.closest('[data-fdel]');
  if (del) { const sup = supFor(del.dataset.fdel); if (sup) { History.push('fn', true); sup.remove(); markChanged(); Pager.run(); toast('Footnote deleted'); } return; }
  const hf = e.target.closest('.ov-hf');
  if (hf && !hf.classList.contains('p0')) {
    const isH = hf.dataset.hf === 'h'; const field = isH ? hdr : ftr;
    const r = await promptDialog(isH ? 'Header' : 'Footer', [{ name: 't', label: 'Text (same on every page)', value: field.innerText.replace(/\n+$/, ''), hint: 'Fields: <code>{page}</code> <code>{pages}</code> <code>{title}</code> <code>{date}</code>' }], 'Save');
    if (r) { field.innerText = r.t; markChanged(); Pager.run(); }
  }
});
[[hdr, 'edit-h'], [ftr, 'edit-f']].forEach(([f, c]) => { f.addEventListener('focus', () => page.classList.add(c)); f.addEventListener('blur', () => { page.classList.remove(c); Pager.run(); }); });

/* ============================================================ columns */
function topBlockOf(n) { while (n && n.parentNode && n.parentNode !== editor) n = n.parentNode; return n && n.parentNode === editor ? n : null; }
function setColumns(n) {
  restoreSel(); const r = selRange() || lastRange; if (!r) return;
  History.push('cols', true);
  const existing = closestEl(r.startContainer, '.cols');
  if (existing && (n === 1 || r.collapsed || existing.contains(r.endContainer))) {
    if (n === 1) withMarkers(() => existing.replaceWith(...existing.childNodes));
    else { existing.dataset.cols = n; existing.style.columnCount = n; }
    markChanged(); Pager.run(); return;
  }
  if (n === 1) { toast('Already one column'); return; }
  withMarkers(() => {
    Pager.strip();
    const rr = selRange();
    let blocks;
    if (!rr || rr.collapsed) blocks = [...editor.children].filter(c => !c.classList.contains('cols'));
    else {
      const a = topBlockOf(rr.startContainer), b = topBlockOf(rr.endContainer); blocks = [];
      for (let x = a; x; x = x.nextElementSibling) { blocks.push(x); if (x === b) break; }
    }
    blocks = blocks.filter(b => b && !b.classList.contains('cols'));
    if (!blocks.length) return;
    const div = document.createElement('div'); div.className = 'cols'; div.dataset.cols = n;
    div.style.columnCount = n; div.style.columnGap = '0.4in';
    blocks[0].before(div); blocks.forEach(b => div.appendChild(b));
    if (!div.nextElementSibling) { const p = document.createElement('p'); p.innerHTML = '<br>'; div.after(p); }
  });
  markChanged(); Pager.run();
}

/* ============================================================ mail merge */
const MM = { preview: false, idx: 0 };
const mmData = () => (cur && cur.merge && cur.merge.fields && cur.merge.fields.length ? cur.merge : null);
function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"' && !f) q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const clean = rows.filter(r => r.some(x => x.trim()));
  if (!clean.length) return { fields: [], rows: [] };
  const seen = new Set();
  const fields = clean[0].map((h, i) => { let n = h.trim() || 'Column ' + (i + 1); while (seen.has(n)) n += '_'; seen.add(n); return n; });
  return { fields, rows: clean.slice(1).map(r => fields.map((_, i) => (r[i] ?? '').trim())) };
}
function toCSV({ fields, rows }) {
  const q = v => /[",\n;\t]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  return [fields, ...rows].map(r => r.map(x => q(String(x ?? ''))).join(',')).join('\n');
}
function mmValue(row, field) {
  const d = mmData(); if (!d) return '';
  let i = d.fields.indexOf(field); if (i < 0) i = d.fields.findIndex(f => f.toLowerCase() === String(field).toLowerCase());
  return i < 0 ? '' : (row[i] ?? '');
}
function mmApply() {
  const d = mmData();
  if (MM.preview && !d) MM.preview = false;
  const row = d ? d.rows[clamp(MM.idx, 0, Math.max(0, d.rows.length - 1))] || [] : [];
  editor.classList.toggle('merge-preview', MM.preview);
  $$('.mf', editor).forEach(m => { if (MM.preview) m.dataset.v = mmValue(row, m.dataset.field); else m.removeAttribute('data-v'); });
  $('#mmPos').textContent = d && d.rows.length ? `${clamp(MM.idx, 0, d.rows.length - 1) + 1} / ${d.rows.length}` : '—';
  $('#btnPreview').classList.toggle('on', MM.preview);
  if (MM.preview) Pager.schedule(30);
}
async function mmRecipients() {
  const d = cur.merge;
  const body = document.createElement('div');
  body.innerHTML = `<div class="hint" style="margin-bottom:8px">Paste a list with a header row (from Excel or Google Sheets), or import a .csv file. Each column becomes a merge field.</div>
    <div class="field"><textarea id="mmCsv" style="min-height:200px;font-family:'Roboto Mono',monospace;font-size:12.5px" placeholder="Name,Email,City\nAsha Rao,asha@example.com,Pune">${esc(d ? toCSV(d) : '')}</textarea></div>
    <div style="display:flex;gap:8px;align-items:center"><button class="btn small outline" id="mmFileBtn"><i data-lucide="file-up"></i>Import .csv</button><span class="hint" id="mmSum"></span></div>
    <input type="file" id="mmFile" accept=".csv,.tsv,.txt" hidden>`;
  const summary = () => { const p = parseCSV($('#mmCsv', body).value); $('#mmSum', body).textContent = p.fields.length ? `${p.rows.length} recipient${p.rows.length === 1 ? '' : 's'} · fields: ${p.fields.join(', ')}` : 'No data yet'; };
  const res = await modal({ title: 'Mail merge recipients', body, wide: true, onOpen: () => {
    summary(); $('#mmCsv', body).addEventListener('input', summary);
    $('#mmFileBtn', body).onclick = () => $('#mmFile', body).click();
    $('#mmFile', body).onchange = async ev => { const f = ev.target.files[0]; if (f) { $('#mmCsv', body).value = await f.text(); summary(); } };
  }, buttons: [{ label: 'Cancel', value: null }, { label: 'Save list', primary: true, value: () => $('#mmCsv', body).value }] });
  if (res == null) return;
  const parsed = parseCSV(res);
  cur.merge = parsed.fields.length ? parsed : null; MM.idx = 0;
  await commitMeta(); mmApply();
  toast(parsed.fields.length ? `${parsed.rows.length} recipient(s) saved` : 'Recipient list cleared');
}
function mergedHTML(row) {
  const t = document.createElement('template'); t.innerHTML = cleanHTML();
  $$('.mf', t.content).forEach(m => m.replaceWith(document.createTextNode(mmValue(row, m.dataset.field))));
  return t.innerHTML;
}
async function mmFinish(kind) {
  const d = mmData(); if (!d || !d.rows.length) { toast('Add recipients first (Mailings → Recipients)'); return; }
  if (!editor.querySelector('.mf')) { toast('Insert at least one merge field first'); return; }
  if (pendingSave) await saveNow();
  const base = { header: cur.header, footer: cur.footer, page: JSON.parse(JSON.stringify(cur.page)) };
  if (kind === 'doc' || kind === 'print') {
    const html = d.rows.map(mergedHTML).join('<div class="page-break" contenteditable="false"></div>');
    await createDoc({ ...base, title: cur.title + ' — merged', html });
    toast(`Merged ${d.rows.length} letters into a new document`);
    if (kind === 'print') setTimeout(() => window.print(), 700);
    return;
  }
  const make = async html => { const tmp = normalizeDoc({ ...cur, ...base, html, id: 'tmp', track: false }); const root = mountOffscreen(tmp); try { return await buildDocx(tmp, root); } finally { root.remove(); } };
  if (kind === 'docx') {
    toast('Building Word file…');
    download(await make(d.rows.map(mergedHTML).join('<div class="page-break" contenteditable="false"></div>')), safeName(cur.title + ' merged') + '.docx');
    return;
  }
  const Z = await libReady('JSZip', 'the zip builder'); const zip = new Z(); const used = new Set();
  toast(`Building ${d.rows.length} Word files…`);
  for (let i = 0; i < d.rows.length; i++) {
    let name = safeName((d.rows[i].find(v => v && v.trim()) || 'Record ' + (i + 1)).slice(0, 60));
    while (used.has(name)) name += '-' + (i + 1); used.add(name);
    zip.file(name + '.docx', await make(mergedHTML(d.rows[i])));
  }
  download(await zip.generateAsync({ type: 'blob' }), safeName(cur.title + ' merged') + '.zip');
}

/* ============================================================ encrypted sync (vault) */
const Vault = {
  key: null, salt: null, remote: undefined,
  b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
  unb64(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; },
  async derive(pass, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: this.unb64(salt), iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  },
  async seal(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return JSON.stringify({ lekhEnc: 1, iv: this.b64(iv), data: this.b64(new Uint8Array(ct)) });
  },
  async open(key, obj) { const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.unb64(obj.iv) }, key, this.unb64(obj.data)); return new TextDecoder().decode(pt); },
  async load() {
    try { const v = await DB.kvGet('vault'); if (v && v.gistId === settings.gistId) { this.key = v.key; this.salt = v.salt; } else { this.key = null; this.salt = null; } } catch {}
    try { const s = localStorage.getItem('lekh.enc.' + settings.gistId); this.remote = s === 'off' ? null : s ? JSON.parse(s) : undefined; } catch {}
  },
  async store(key, salt) { this.key = key; this.salt = salt; await DB.kvSet('vault', { gistId: settings.gistId, key, salt }); },
  async clear() { this.key = null; this.salt = null; try { await DB.kvSet('vault', null); } catch {} },
  setRemote(r) { this.remote = r; try { localStorage.setItem('lekh.enc.' + settings.gistId, r ? JSON.stringify(r) : 'off'); } catch {} },
  on() { return !!this.remote; },
  locked() { return !!(this.remote && (!this.key || this.salt !== this.remote.salt)); },
  async unlock(pass) {
    const k = await this.derive(pass, this.remote.salt);
    let ok = false; try { ok = (await this.open(k, this.remote.check)) === 'lekh-ok'; } catch {}
    if (!ok) throw new Error('That passphrase is not correct.');
    await this.store(k, this.remote.salt);
  }
};
async function unlockDialog() {
  const r = await promptDialog('Unlock synced documents', [{ name: 'p', label: 'Encryption passphrase', type: 'password', hint: 'The passphrase you set when you turned on encryption. It is never sent anywhere.' }], 'Unlock');
  if (!r) return false;
  try { await Vault.unlock(r.p); toast('Unlocked — syncing'); Sync.etag = ''; await Sync.run(true); return true; }
  catch (e) { toast(e.message, { err: true }); return false; }
}
async function passphraseDialog(title) {
  const r = await promptDialog(title, [
    { name: 'a', label: 'New passphrase (at least 8 characters)', type: 'password' },
    { name: 'b', label: 'Type it again', type: 'password' }], 'Encrypt',
    `<div class="notice warn"><b>Write it down.</b> If you forget it, the synced copies can't be opened by anyone — not even you. Documents already on your devices stay readable.</div>`);
  if (!r) return null;
  if (r.a.length < 8) { toast('Use at least 8 characters', { err: true }); return null; }
  if (r.a !== r.b) { toast('The two passphrases don’t match', { err: true }); return null; }
  return r.a;
}
async function migrateVault(pass) {
  toast(pass ? 'Encrypting and re-uploading your documents…' : 'Re-uploading without encryption…', { ms: 5000 });
  try {
    const ok = await Sync.migrate(pass);
    toast(pass ? 'Done — synced documents are now encrypted' + (ok ? '' : ' (the old gist could not be deleted; delete it on github.com)') : 'Encryption turned off', { ms: 6000 });
  } catch (e) { toast('Could not finish: ' + e.message, { err: true }); }
}

/* ============================================================ navigation pane */
const Nav = {
  open: false, timer: null,
  isHead: el => el && el.nodeType === 1 && (/^H[1-4]$/.test(el.tagName) || el.matches('p.title')),
  level: el => el.matches('p.title') ? 0 : +el.tagName[1],
  heads() { return [...editor.children].filter(Nav.isHead).filter(h => h.textContent.trim()); },
  schedule() { if (!this.open) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.render(), 350); },
  section(h) { const lv = this.level(h); const out = [h]; let n = h.nextElementSibling; while (n && !(this.isHead(n) && this.level(n) <= lv)) { out.push(n); n = n.nextElementSibling; } return out; },
  render() {
    if (!this.open || !cur) return;
    if (navDrag != null) { this.schedule(); return; }
    const hs = this.heads(); const list = $('#navList');
    if (!hs.length) { list.innerHTML = `<div class="empty"><i data-lucide="list-tree"></i>No headings yet. Use Heading 1–4 (Ctrl+Alt+1…4) to build an outline.</div>`; icons(); return; }
    list.innerHTML = hs.map((h, i) => `<div class="nav-item l${this.level(h)}${h.matches('p.title') ? ' title' : ''}" draggable="true" data-i="${i}"><span class="t">${esc(h.textContent.trim())}</span>
      <button class="icon-btn mv" data-mv="up" title="Move section up"><i data-lucide="chevron-up"></i></button><button class="icon-btn mv" data-mv="down" title="Move section down"><i data-lucide="chevron-down"></i></button></div>`).join('');
    icons(); this.mark();
  },
  mark() {
    if (!this.open) return; const r = selRange() || lastRange; if (!r) return;
    const hs = this.heads(); let curI = -1;
    hs.forEach((h, i) => { if (h.compareDocumentPosition(r.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING || h.contains(r.startContainer)) curI = i; });
    $$('#navList .nav-item').forEach((el, i) => el.classList.toggle('current', i === curI));
  },
  move(h, before) {
    const nodes = this.section(h); if (before && nodes.includes(before)) return;
    History.push('nav', true); Pager.strip();
    nodes.forEach(n => before ? editor.insertBefore(n, before) : editor.appendChild(n));
    if (!editor.lastElementChild || Nav.isHead(editor.lastElementChild)) { const p = document.createElement('p'); p.innerHTML = '<br>'; editor.appendChild(p); }
    markChanged(); updateTOCs(true); this.render(); Pager.run();
    h.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },
  step(h, dir) {
    const lv = this.level(h); const hs = this.heads(); const i = hs.indexOf(h);
    if (dir < 0) { for (let j = i - 1; j >= 0; j--) { const l2 = this.level(hs[j]); if (l2 < lv) break; if (l2 === lv) return this.move(h, hs[j]); } }
    else {
      const end = this.section(h); const after = end[end.length - 1].nextElementSibling;
      let nx = after; while (nx && !this.isHead(nx)) nx = nx.nextElementSibling;
      if (nx && this.level(nx) === lv) { const ns = this.section(nx); return this.move(h, ns[ns.length - 1].nextElementSibling || null); }
    }
    toast('Already at the edge of this level');
  }
};
function showSidePane(which) {
  $$('.side-tab').forEach(t => t.classList.toggle('active', t.dataset.side === which));
  $$('.side-pane').forEach(p => { p.hidden = p.dataset.pane !== which; });
  Nav.open = which === 'nav'; $('#btnNav').classList.toggle('on', Nav.open);
  if (Nav.open) Nav.render();
}
$$('.side-tab').forEach(t => t.addEventListener('click', () => showSidePane(t.dataset.side)));
const navList = $('#navList'); let navDrag = null;
navList.addEventListener('click', e => {
  const it = e.target.closest('.nav-item'); if (!it) return;
  const h = Nav.heads()[+it.dataset.i]; if (!h) return;
  const mv = e.target.closest('[data-mv]'); if (mv) { Nav.step(h, mv.dataset.mv === 'up' ? -1 : 1); return; }
  h.scrollIntoView({ block: 'start', behavior: 'smooth' });
  editor.focus({ preventScroll: true }); const r = document.createRange(); r.selectNodeContents(h); r.collapse(true); setRange(r);
  if (innerWidth < 860) $('#sidebar').classList.add('closed');
});
navList.addEventListener('dragstart', e => { const it = e.target.closest('.nav-item'); if (!it) return; navDrag = +it.dataset.i; it.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'section'); });
navList.addEventListener('dragover', e => { if (navDrag == null) return; e.preventDefault(); $$('.nav-item', navList).forEach(x => x.classList.remove('drop-before')); const it = e.target.closest('.nav-item'); if (it) it.classList.add('drop-before'); });
navList.addEventListener('dragend', () => { navDrag = null; $$('.nav-item', navList).forEach(x => x.classList.remove('drop-before', 'dragging')); });
navList.addEventListener('drop', e => {
  e.preventDefault(); if (navDrag == null) return;
  const hs = Nav.heads(); const src = hs[navDrag]; const it = e.target.closest('.nav-item');
  const target = it ? hs[+it.dataset.i] : null; navDrag = null;
  if (src && src !== target) Nav.move(src, target);
});

/* ============================================================ rulers */
const Ruler = {
  drag: null,
  unit() { return settings.units === 'cm' ? { px: 96 / 2.54, minor: 4, label: 1, snap: 0.1 / 2.54 } : { px: 96, minor: 8, label: 1, snap: 1 / 16 }; },
  ticks(len, start, vertical) {             // tick marks measured from the margin edge, both directions
    const u = this.unit(); const step = u.px / u.minor; let s = '';
    for (let k = -Math.floor(start / step); start + k * step <= len; k++) {
      const x = start + k * step; if (x < 0) continue; const major = k % u.minor === 0; const half = k % (u.minor / 2) === 0;
      const t = major ? 0 : half ? 5 : 8, b = major ? 0 : 12 - (half ? 5 : 8);
      if (major && k !== 0) s += vertical ? `<text x="8" y="${x + 3}" font-size="8" text-anchor="middle" fill="#7b8494">${Math.abs(k / u.minor)}</text>` : `<text x="${x}" y="13" font-size="8.5" text-anchor="middle" fill="#7b8494">${Math.abs(k / u.minor)}</text>`;
      else if (!major) s += vertical ? `<line x1="${4 + t / 2}" x2="${12 - t / 2}" y1="${x}" y2="${x}" stroke="#9aa1ad" stroke-width=".8"/>` : `<line x1="${x}" x2="${x}" y1="${4 + t / 2}" y2="${16 - t / 2}" stroke="#9aa1ad" stroke-width=".8"/>`;
      void b;
    }
    return s;
  },
  values() {
    const { w } = pageDims(); const m = cur.page.margins; const W = w * 96;
    const b = (() => { const n = selNode(); return n ? (closestEl(n, 'li') || blockOf(n)) : null; })();
    let li = 0, fi = 0, ri = 0;
    if (b) { const cs = getComputedStyle(b); li = parseFloat(cs.marginLeft) || 0; ri = parseFloat(cs.marginRight) || 0; fi = parseFloat(cs.textIndent) || 0; if (b.tagName === 'LI') li += parseFloat(getComputedStyle(b.parentElement).paddingLeft) || 0; }
    return { W, mL: m.l * 96, mR: m.r * 96, li, fi, ri, block: b };
  },
  render(over) {
    if (!cur) return;
    pageWrap.classList.toggle('no-ruler', !settings.ruler);
    $('#btnRuler').classList.toggle('on', !!settings.ruler);
    if (!settings.ruler) return;
    const v = { ...this.values(), ...(over || {}) };
    const { W, mL, mR, li, fi, ri } = v; const cx = W - mR;
    const fx = mL + li + fi, lx = mL + li, rx = cx - ri;
    $('#hRuler').style.width = W + 'px';
    $('#hRuler').innerHTML = `<svg width="${W}" height="20">
      <rect x="0" y="2" width="${mL}" height="16" fill="#dfe3ea"/><rect x="${cx}" y="2" width="${mR}" height="16" fill="#dfe3ea"/>
      <rect x="${mL}" y="2" width="${Math.max(0, cx - mL)}" height="16" fill="#fff"/>
      <g transform="translate(${mL} 0)">${this.ticks(W - mL, 0, false)}</g><g transform="translate(${mL} 0) scale(-1 1)">${this.ticks(mL, 0, false).replace(/<text[^>]*>[^<]*<\/text>/g, '')}</g>
      <rect class="r-mark" data-k="ml" x="${mL - 3}" y="0" width="6" height="20" fill="transparent"><title>Left margin</title></rect>
      <rect class="r-mark" data-k="mr" x="${cx - 3}" y="0" width="6" height="20" fill="transparent"><title>Right margin</title></rect>
      <path class="r-mark" data-k="fi" d="M${fx - 5} 0 h10 l-5 7 z" fill="#2457a6"><title>First line indent</title></path>
      <path class="r-mark" data-k="li" d="M${lx - 5} 20 h10 l-5 -7 z" fill="#2457a6"><title>Left indent</title></path>
      <path class="r-mark" data-k="ri" d="M${rx - 5} 20 h10 l-5 -7 z" fill="#2457a6"><title>Right indent</title></path>
    </svg>`;
  },
  vruler(top, H, mT, mB) {
    return `<div class="ruler-v" style="top:${top}px;height:${H}px"><svg width="16" height="${H}">
      <rect x="0" y="0" width="16" height="${mT}" fill="#dfe3ea"/><rect x="0" y="${H - mB}" width="16" height="${mB}" fill="#dfe3ea"/>
      <rect x="0" y="${mT}" width="16" height="${Math.max(0, H - mT - mB)}" fill="#fff"/>
      <g transform="translate(0 ${mT})">${this.ticks(H - mT, 0, true)}</g>
      <rect class="r-mark" data-k="mt" x="0" y="${mT - 3}" width="16" height="6" fill="transparent"><title>Top margin</title></rect>
      <rect class="r-mark" data-k="mb" x="0" y="${H - mB - 3}" width="16" height="6" fill="transparent"><title>Bottom margin</title></rect></svg></div>`;
  },
  start(e, k) {
    if (!cur) return; e.preventDefault(); e.stopPropagation();
    const v = this.values(); const { w, h } = pageDims();
    if (['fi', 'li', 'ri'].includes(k) && !v.block) { toast('Click in a paragraph first'); return; }
    this.drag = { k, v, x0: e.clientX, y0: e.clientY, z: settings.zoom / 100, W: w * 96, H: h * 96, m: { ...cur.page.margins } };
    document.body.classList.add(k === 'mt' || k === 'mb' ? 'r-drag-v' : 'r-drag');
    this.tip = document.createElement('div'); this.tip.className = 'r-tip'; document.body.appendChild(this.tip);
    this.move(e);
  },
  fmt(px) { return settings.units === 'cm' ? (px / (96 / 2.54)).toFixed(2) + ' cm' : (px / 96).toFixed(2) + '"'; },
  snap(px) { const s = this.unit().snap * 96; return Math.round(px / s) * s; },
  move(e) {
    const d = this.drag; if (!d) return;
    const dx = (e.clientX - d.x0) / d.z, dy = (e.clientY - d.y0) / d.z; const v = d.v;
    let out = {}, label = '';
    const minContent = 96;
    switch (d.k) {
      case 'ml': out.mL = clamp(this.snap(v.mL + dx), 0, d.W - v.mR - minContent); label = 'Left margin ' + this.fmt(out.mL); break;
      case 'mr': out.mR = clamp(this.snap(v.mR - dx), 0, d.W - v.mL - minContent); label = 'Right margin ' + this.fmt(out.mR); break;
      case 'fi': out.fi = this.snap(v.fi + dx); label = 'First line ' + this.fmt(out.fi); break;
      case 'li': out.li = clamp(this.snap(v.li + dx), 0, d.W - v.mL - v.mR - 48); out.fi = v.fi; label = 'Left indent ' + this.fmt(out.li); break;
      case 'ri': out.ri = clamp(this.snap(v.ri - dx), 0, d.W - v.mL - v.mR - 48); label = 'Right indent ' + this.fmt(out.ri); break;
      case 'mt': out.mT = clamp(this.snap(d.m.t * 96 + dy), 0, d.H / 2); label = 'Top margin ' + this.fmt(out.mT); break;
      case 'mb': out.mB = clamp(this.snap(d.m.b * 96 - dy), 0, d.H / 2); label = 'Bottom margin ' + this.fmt(out.mB); break;
    }
    d.out = out;
    if (!['mt', 'mb'].includes(d.k)) this.render(out);
    this.tip.textContent = label; this.tip.style.left = (e.clientX + 12) + 'px'; this.tip.style.top = (e.clientY + 14) + 'px';
  },
  async end() {
    const d = this.drag; if (!d) return; this.drag = null;
    document.body.classList.remove('r-drag', 'r-drag-v'); this.tip?.remove();
    const o = d.out || {}; const r4 = x => Math.round((x / 96) * 1000) / 1000;
    if (['ml', 'mr', 'mt', 'mb'].includes(d.k)) {
      const m = cur.page.margins;
      if (o.mL != null) m.l = r4(o.mL); if (o.mR != null) m.r = r4(o.mR); if (o.mT != null) m.t = r4(o.mT); if (o.mB != null) m.b = r4(o.mB);
      applyPage(); await commitMeta(); return;
    }
    History.push('indent', true);
    const blocks = getSelectedBlocks().length ? getSelectedBlocks() : [d.v.block];
    blocks.forEach(b => {
      const isLi = b.tagName === 'LI'; const pad = isLi ? parseFloat(getComputedStyle(b.parentElement).paddingLeft) || 0 : 0;
      if (o.li != null) b.style.marginLeft = o.li - pad > 0.5 ? r4(o.li - pad) + 'in' : (isLi ? '' : '');
      if (o.fi != null) b.style.textIndent = Math.abs(o.fi) > 0.5 ? r4(o.fi) + 'in' : '';
      if (o.ri != null) b.style.marginRight = o.ri > 0.5 ? r4(o.ri) + 'in' : '';
      if (!b.getAttribute('style')) b.removeAttribute('style');
    });
    markChanged(); this.render(); Pager.schedule(30);
  }
};
document.addEventListener('pointerdown', e => { const m = e.target.closest && e.target.closest('.r-mark'); if (m) Ruler.start(e, m.dataset.k); }, true);
window.addEventListener('pointermove', e => { if (Ruler.drag) Ruler.move(e); });
window.addEventListener('pointerup', () => { if (Ruler.drag) Ruler.end(); });

/* ============================================================ styles & paragraph */
const STYLE_KEYS = [['normal', 'Normal'], ['title', 'Title'], ['subtitle', 'Subtitle'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4'], ['quote', 'Quote']];
const DEFAULT_STYLES = {
  normal: { font: 'Calibri, Carlito, sans-serif', size: 11, color: '#1c2230', bold: false, italic: false, before: 0, after: 8, line: 1.38 },
  title: { font: '', size: 28, color: '#1c2230', bold: false, italic: false, before: 0, after: 4 },
  subtitle: { font: '', size: 14, color: '#5b6472', bold: false, italic: false, before: 0, after: 14 },
  h1: { font: '', size: 20, color: '#1f3864', bold: true, italic: false, before: 18, after: 6 },
  h2: { font: '', size: 15, color: '#2f5496', bold: true, italic: false, before: 14, after: 4 },
  h3: { font: '', size: 12.5, color: '#2f5496', bold: true, italic: false, before: 12, after: 4 },
  h4: { font: '', size: 11, color: '#2f5496', bold: true, italic: true, before: 10, after: 2 },
  quote: { font: '', size: 11, color: '#485160', bold: false, italic: true, before: 8, after: 8 }
};
function fullStyles(d = cur) { const s = d && d.styles || {}; return Object.fromEntries(STYLE_KEYS.map(([k]) => [k, { ...DEFAULT_STYLES[k], ...(s[k] || {}) }])); }
function styleCSS(d = cur) {
  if (!d || !d.styles) return '';
  const st = fullStyles(d); const sel = { title: '#editor p.title', subtitle: '#editor p.subtitle', h1: '#editor h1', h2: '#editor h2', h3: '#editor h3', h4: '#editor h4', quote: '#editor blockquote' };
  const n = st.normal;
  let css = `#editor{font-family:${n.font};font-size:${n.size}pt;color:${n.color};line-height:${n.line}}#editor p{margin:${n.before}pt 0 ${n.after}pt}${n.bold ? '#editor p{font-weight:700}' : ''}${n.italic ? '#editor p{font-style:italic}' : ''}`;
  for (const [k, s] of Object.entries(sel)) {
    const v = st[k];
    css += `${s}{${v.font ? `font-family:${v.font};` : ''}font-size:${v.size}pt;color:${v.color};font-weight:${v.bold ? 700 : k === 'title' ? 300 : 400};font-style:${v.italic ? 'italic' : 'normal'};margin-top:${v.before}pt;margin-bottom:${v.after}pt}`;
  }
  return css;
}
function applyDocStyles() { let el = $('#docStyles'); if (!el) { el = document.createElement('style'); el.id = 'docStyles'; document.head.appendChild(el); } el.textContent = styleCSS(); }
async function stylesDialog() {
  const st = fullStyles();
  const fontOpts = (v, allowSame) => (allowSame ? `<option value="" ${!v ? 'selected' : ''}>Same as Normal</option>` : '') + FONTS.map(([n, f]) => `<option value="${esc(f)}" ${f === v ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const body = document.createElement('div');
  body.innerHTML = `<div class="hint" style="margin-bottom:10px">Changes apply to every paragraph that uses the style in this document. Text you formatted by hand keeps its formatting.</div>
    <div class="style-grid" style="grid-template-columns:96px 1fr 62px 46px 30px 30px 62px 62px">
      <div class="hd">Style</div><div class="hd">Font</div><div class="hd">Size</div><div class="hd">Colour</div><div class="hd">B</div><div class="hd">I</div><div class="hd">Before pt</div><div class="hd">After pt</div>
      ${STYLE_KEYS.map(([k, label]) => { const v = st[k]; return `<div><b>${label}</b></div>
        <select data-s="${k}" data-f="font">${fontOpts(v.font, k !== 'normal')}</select>
        <input type="number" step="0.5" min="6" max="96" data-s="${k}" data-f="size" value="${v.size}">
        <input type="color" data-s="${k}" data-f="color" value="${v.color}">
        <div class="chk"><input type="checkbox" data-s="${k}" data-f="bold" ${v.bold ? 'checked' : ''}></div>
        <div class="chk"><input type="checkbox" data-s="${k}" data-f="italic" ${v.italic ? 'checked' : ''}></div>
        <input type="number" step="1" min="0" max="96" data-s="${k}" data-f="before" value="${v.before}">
        <input type="number" step="1" min="0" max="96" data-s="${k}" data-f="after" value="${v.after}">`; }).join('')}
    </div>
    <div class="field" style="margin-top:12px;max-width:260px"><label>Line spacing (Normal)</label>
      <select data-s="normal" data-f="line">${[['1.2', 'Single (1.0)'], ['1.38', '1.15'], ['1.8', '1.5 lines'], ['2.4', 'Double']].map(([v, l]) => `<option value="${v}" ${+v === +st.normal.line ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <label class="ac-row"><input type="checkbox" id="stDefault"> Use these styles for new documents too</label>`;
  const read = () => { const out = {}; $$('[data-s]', body).forEach(el => { const k = el.dataset.s, f = el.dataset.f; out[k] = out[k] || {}; out[k][f] = el.type === 'checkbox' ? el.checked : (f === 'size' || f === 'before' || f === 'after' || f === 'line') ? +el.value : el.value; }); return out; };
  const res = await modal({ title: 'Styles', body, wide: true, buttons: [
    { label: 'Reset to defaults', value: 'reset' }, { label: 'Cancel', value: null }, { label: 'Apply', primary: true, value: () => ({ s: read(), def: $('#stDefault', body).checked }) }] });
  if (!res) return;
  if (res === 'reset') { delete cur.styles; }
  else { cur.styles = res.s; if (res.def) { settings.defaultStyles = res.s; saveSettings(); } }
  applyDocStyles(); Pager.run(); Ruler.render(); await commitMeta(); toast('Styles updated');
}
async function paragraphDialog() {
  restoreSel(); const blocks = getSelectedBlocks(); if (!blocks.length) { toast('Click in a paragraph first'); return; }
  const b = blocks[0]; const cs = getComputedStyle(b); const pt = px => Math.round(parseFloat(px) * 0.75 * 10) / 10; const inch = px => Math.round(parseFloat(px) / 96 * 100) / 100;
  const ti = parseFloat(cs.textIndent) || 0; const lhRatio = cs.lineHeight === 'normal' ? 1.38 : Math.round((parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)) * 100) / 100;
  const lineOpt = [['1.2', 'Single'], ['1.38', '1.15'], ['1.8', '1.5 lines'], ['2.4', 'Double']]; const nearest = lineOpt.reduce((a, o) => Math.abs(+o[0] - lhRatio) < Math.abs(+a[0] - lhRatio) ? o : a)[0];
  const r = await promptDialog('Paragraph', [
    { name: 'align', label: 'Alignment', type: 'select', value: b.style.textAlign || cs.textAlign.replace('start', 'left'), options: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['justify', 'Justified']] },
    { name: 'left', label: 'Indent left (inches)', type: 'number', step: '0.05', value: b.tagName === 'LI' ? inch(b.style.marginLeft || 0) : inch(cs.marginLeft) },
    { name: 'right', label: 'Indent right (inches)', type: 'number', step: '0.05', value: inch(cs.marginRight) },
    { name: 'special', label: 'First line', type: 'select', value: ti > 0 ? 'first' : ti < 0 ? 'hanging' : 'none', options: [['none', 'None'], ['first', 'First line indent'], ['hanging', 'Hanging indent']] },
    { name: 'by', label: 'By (inches)', type: 'number', step: '0.05', value: Math.abs(inch(ti)) || 0.5 },
    { name: 'before', label: 'Space before (pt)', type: 'number', step: '1', value: pt(cs.marginTop) },
    { name: 'after', label: 'Space after (pt)', type: 'number', step: '1', value: pt(cs.marginBottom) },
    { name: 'line', label: 'Line spacing', type: 'select', value: nearest, options: lineOpt }], 'Apply');
  if (!r) return;
  History.push('para', true);
  blocks.forEach(x => {
    x.style.textAlign = r.align === 'left' ? '' : r.align;
    x.style.marginLeft = +r.left > 0 ? (+r.left) + 'in' : '';
    x.style.marginRight = +r.right > 0 ? (+r.right) + 'in' : '';
    x.style.textIndent = r.special === 'none' ? '' : (r.special === 'hanging' ? '-' : '') + (+r.by || 0.5) + 'in';
    if (r.special === 'hanging' && !(+r.left)) x.style.marginLeft = (+r.by || 0.5) + 'in';
    x.style.marginTop = (+r.before) + 'pt'; x.style.marginBottom = (+r.after) + 'pt';
    x.style.lineHeight = r.line;
    if (!x.getAttribute('style')) x.removeAttribute('style');
  });
  markChanged(); Ruler.render(); Pager.schedule(30);
}

/* ============================================================ format painter */
const Painter = {
  fmt: null, sticky: false,
  capture() {
    const r = selRange() || lastRange; if (!r) { toast('Click in text that has the formatting you want to copy'); return false; }
    const node = r.startContainer.nodeType === 1 ? (r.startContainer.childNodes[r.startOffset] && r.startContainer.childNodes[r.startOffset].nodeType === 1 ? r.startContainer.childNodes[r.startOffset] : r.startContainer) : r.startContainer.parentElement;
    const cs = getComputedStyle(node); const blk = blockOf(node);
    let deco = '', bg = '', x = node;
    while (x && x !== editor && x !== blk) { const c = getComputedStyle(x); deco += ' ' + c.textDecorationLine; if (!bg && x.style && x.style.backgroundColor) bg = x.style.backgroundColor; x = x.parentElement; }
    this.fmt = {
      font: cs.fontFamily, size: Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2, color: cs.color, bg,
      bold: +cs.fontWeight >= 600, italic: cs.fontStyle === 'italic', underline: /underline/.test(deco), strike: /line-through/.test(deco),
      sub: !!closestEl(node, 'sub'), sup: !!closestEl(node, 'sup'),
      block: blk ? { tag: blk.tagName.toLowerCase(), cls: blk.classList.contains('title') ? 'title' : blk.classList.contains('subtitle') ? 'subtitle' : '', style: ['textAlign', 'lineHeight', 'marginLeft', 'marginRight', 'textIndent', 'marginTop', 'marginBottom'].map(k => [k, blk.style[k]]) } : null
    };
    return true;
  },
  on(sticky) { if (!this.capture()) return; this.sticky = sticky; document.body.classList.add('painter'); $('#btnPainter').classList.add('on'); toast(sticky ? 'Format painter on — select text to paint, Esc to stop' : 'Now select the text to format'); },
  off() { this.fmt = null; document.body.classList.remove('painter'); $('#btnPainter').classList.remove('on'); },
  apply() {
    const f = this.fmt; if (!f) return; const sel = getSelection(); let r = selRange(); if (!r) return;
    if (r.collapsed) { sel.modify('move', 'backward', 'word'); sel.modify('extend', 'forward', 'word'); r = selRange(); if (!r || r.collapsed) return; }
    History.push('paint', true);
    const blocks = getSelectedBlocks();
    const fullPara = blocks.length > 1 || (blocks[0] && r.toString().trim() === blocks[0].textContent.trim());
    if (fullPara && f.block) {
      if (blocks.some(b => b.tagName.toLowerCase() !== f.block.tag || (b.classList.contains('title') ? 'title' : b.classList.contains('subtitle') ? 'subtitle' : '') !== f.block.cls)) {
        if (f.block.cls) applyBlockStyleRaw(f.block.cls); else if (/^(p|h[1-4]|blockquote|pre)$/.test(f.block.tag)) applyBlockStyleRaw(f.block.tag);
      }
      getSelectedBlocks().forEach(b => f.block.style.forEach(([k, v]) => { b.style[k] = v; }));
    }
    document.execCommand('removeFormat');
    const rr = selRange(); if (rr) $$('span[style]', editor).forEach(s => { if (rr.intersectsNode(s) && !s.closest('.cmt') && !s.classList.length) s.replaceWith(...s.childNodes); });
    const st = c => { try { return document.queryCommandState(c); } catch { return false; } };
    [['bold', f.bold], ['italic', f.italic], ['underline', f.underline], ['strikeThrough', f.strike], ['subscript', f.sub], ['superscript', f.sup]].forEach(([c, want]) => { if (st(c) !== want) document.execCommand(c); });
    document.execCommand('fontName', false, f.font);
    document.execCommand('foreColor', false, f.color);
    if (f.bg) document.execCommand('hiliteColor', false, f.bg);
    const node = selRange()?.startContainer; const curPt = node ? Math.round(parseFloat(getComputedStyle(node.nodeType === 1 ? node : node.parentElement).fontSize) * 0.75 * 2) / 2 : f.size;
    if (curPt !== f.size) { document.execCommand('fontSize', false, '7'); $$('font[size="7"]', editor).forEach(x => { const s = document.createElement('span'); s.style.fontSize = f.size + 'pt'; while (x.firstChild) s.appendChild(x.firstChild); x.replaceWith(s); }); $$('span[style*="xxx-large"]', editor).forEach(s => { s.style.fontSize = f.size + 'pt'; }); }
    markChanged(); updateToolbar();
    if (!this.sticky) this.off();
  }
};
function applyBlockStyleRaw(v) {
  if (v === 'title' || v === 'subtitle') { document.execCommand('formatBlock', false, '<p>'); getSelectedBlocks().forEach(b => { if (b.tagName === 'P') { b.classList.remove('title', 'subtitle'); b.classList.add(v); } }); }
  else { document.execCommand('formatBlock', false, `<${v}>`); getSelectedBlocks().forEach(b => b.classList.remove('title', 'subtitle')); }
}
let painterClick = 0;
$('#btnPainter').addEventListener('click', e => {
  e.stopImmediatePropagation();
  const now = Date.now();
  if (now - painterClick < 350) { Painter.off(); Painter.on(true); painterClick = 0; return; }
  painterClick = now;
  if (Painter.fmt) { Painter.off(); return; }
  Painter.on(false);
}, true);
editor.addEventListener('mouseup', () => { if (Painter.fmt) setTimeout(() => Painter.apply(), 0); });

/* ============================================================ right-click menu */
editor.addEventListener('contextmenu', e => {
  if (e.shiftKey) return;                       // Shift + right-click = browser menu (spelling suggestions)
  e.preventDefault();
  const r0 = selRange();
  const inside = r0 && !r0.collapsed && [...r0.getClientRects()].some(rc => e.clientX >= rc.left && e.clientX <= rc.right && e.clientY >= rc.top && e.clientY <= rc.bottom);
  if (!inside) { const p = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null; if (p) { editor.focus({ preventScroll: true }); setRange(p); lastRange = p.cloneRange(); } }
  const img = e.target.closest('img'), link = e.target.closest('a'), cell = e.target.closest('td, th');
  const hasSel = !!(selRange() && !selRange().collapsed);
  const items = [];
  if (hasSel) items.push({ icon: 'scissors', label: 'Cut', kbd: (isMac ? '⌘' : 'Ctrl+') + 'X', act: () => { editor.focus(); document.execCommand('cut'); } }, { icon: 'copy', label: 'Copy', kbd: (isMac ? '⌘' : 'Ctrl+') + 'C', act: () => { editor.focus(); document.execCommand('copy'); } });
  items.push({ icon: 'clipboard', label: 'Paste', kbd: (isMac ? '⌘' : 'Ctrl+') + 'V', act: () => pasteFromClipboard(false) }, { icon: 'clipboard-paste', label: 'Paste as plain text', act: () => pasteFromClipboard(true) });
  if (img) { selectImage(img); items.push('sep', { header: 'Image' },
    { icon: 'align-left', label: 'Wrap: image on the left', act: () => { History.push('img', true); setImgWrap(img, 'left'); afterImgChange(); } },
    { icon: 'align-right', label: 'Wrap: image on the right', act: () => { History.push('img', true); setImgWrap(img, 'right'); afterImgChange(); } },
    { icon: 'align-center', label: 'On its own line, centred', act: () => { History.push('img', true); setImgWrap(img, 'block-center'); afterImgChange(); } },
    { icon: 'type', label: 'In line with text', act: () => { History.push('img', true); setImgWrap(img, 'inline'); afterImgChange(); } },
    { icon: 'pencil', label: 'Alt text…', act: () => imageOp('alt') }, { icon: 'trash-2', label: 'Delete image', danger: true, act: () => imageOp('delete') }); }
  if (link) items.push('sep', { icon: 'external-link', label: 'Open link', act: () => window.open(link.href, '_blank', 'noopener') }, { icon: 'pencil', label: 'Edit link…', act: () => linkDialog(link) }, { icon: 'unlink', label: 'Remove link', act: () => { History.push('link', true); link.replaceWith(...link.childNodes); markChanged(); } });
  if (cell) {
    const multi = selectedCells().length > 1;
    items.push('sep', { header: 'Table' },
      { icon: 'arrow-up-to-line', label: 'Insert row above', act: () => tableOp('rowAbove') }, { icon: 'arrow-down-to-line', label: 'Insert row below', act: () => tableOp('rowBelow') },
      { icon: 'arrow-left-to-line', label: 'Insert column left', act: () => tableOp('colLeft') }, { icon: 'arrow-right-to-line', label: 'Insert column right', act: () => tableOp('colRight') });
    if (multi) items.push({ icon: 'table-cells-merge', label: 'Merge cells', act: () => tableOp('merge') });
    if (cell.colSpan > 1 || cell.rowSpan > 1) items.push({ icon: 'table-cells-split', label: 'Split cell', act: () => tableOp('split') });
    items.push({ icon: 'align-vertical-justify-center', label: 'Cell: align middle', act: () => tableOp('vmiddle') },
      { icon: 'rows-3', label: 'Delete row', danger: true, act: () => tableOp('delRow') }, { icon: 'columns-3', label: 'Delete column', danger: true, act: () => tableOp('delCol') });
  }
  items.push('sep');
  if (hasSel) items.push({ icon: 'message-square-plus', label: 'New comment', act: addComment });
  items.push({ icon: 'link', label: 'Link…', act: () => linkDialog() }, { icon: 'superscript', label: 'Insert footnote', act: insertFootnote },
    { icon: 'pilcrow', label: 'Paragraph…', act: paragraphDialog }, { icon: 'paintbrush', label: 'Copy formatting', act: () => Painter.on(false) },
    'sep', { icon: 'text-select', label: 'Select all', kbd: (isMac ? '⌘' : 'Ctrl+') + 'A', act: () => { editor.focus(); document.execCommand('selectAll'); } },
    { header: 'Spelling suggestions: Shift + right-click' });
  showMenu({ getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }, items);
});
async function pasteFromClipboard(plain) {
  restoreSel();
  try {
    if (!plain && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const img = it.types.find(t => t.startsWith('image/'));
        if (img) { const b = await it.getType(img); await insertImageFile(new File([b], 'pasted.' + img.split('/')[1], { type: img })); return; }
        if (it.types.includes('text/html') && !cur.track) { const h = await (await it.getType('text/html')).text(); History.push('paste', true); document.execCommand('insertHTML', false, cleanPastedHTML(h)); markChanged(); return; }
      }
    }
    const t = await navigator.clipboard.readText(); if (t) insertText(t);
  } catch { toast(`Your browser blocked menu paste — press ${isMac ? '⌘' : 'Ctrl'}+V instead`); }
}

/* ============================================================ AutoCorrect */
const AC_SYMBOLS = [['(c)', '©'], ['(r)', '®'], ['(tm)', '™'], ['--', '—'], ['...', '…'], ['->', '→'], ['<-', '←'], ['=>', '⇒'], ['<=', '≤'], ['>=', '≥'], ['!=', '≠'], ['+-', '±'], ['1/2', '½'], ['1/4', '¼'], ['3/4', '¾']];
const AC_ABBR = /\b(e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|No|Rs|approx|viz|cf|Fig|Vol|pp)\.\s*$/i;
const acOn = k => (settings.ac || {})[k] !== false;
const AC = {
  textBefore(block, node, off) { const r = document.createRange(); r.setStart(block, 0); r.setEnd(node, off); return r.toString(); },
  onInput(ch) {
    if (!cur || cur.track || Pager.composing) return;
    const r = selRange(); if (!r || !r.collapsed) return;
    const n = r.startContainer, off = r.startOffset; if (n.nodeType !== 3) return;
    if (closestEl(n, 'pre, code, .toc, .mf, a')) return;
    const block = closestEl(n, 'li') || blockOf(n); if (!block) return;
    const before = this.textBefore(block, n, off).replace(/​/g, '');
    // 1) list & heading shortcuts at the start of a paragraph
    if (ch === ' ' && acOn('lists') && block.tagName === 'P' && !closestEl(n, 'li, td, th, blockquote') && before.length <= 5) {
      const m = /^(\d{1,3}[.)]|[a-z][.)]|[-*•]|\[ ?\]|>|#{1,4}) $/.exec(before.replace(/ /g, ' '));
      if (m && n.data.slice(0, off).replace(/ /g, ' ') === before.replace(/ /g, ' ')) {
        History.push('ac', true);
        n.deleteData(0, off); if (!block.textContent) block.innerHTML = '<br>';
        const c = document.createRange(); c.setStart(block, 0); c.collapse(true); setRange(c);
        const k = m[1];
        if (/^\d/.test(k)) toggleList('OL');
        else if (/^[a-z]/.test(k)) { toggleList('OL'); const ol = closestEl(selNode(), 'ol'); if (ol) ol.setAttribute('type', 'a'); }
        else if (/^\[/.test(k)) toggleList('UL', true);
        else if (k === '>') applyBlockStyle('blockquote');
        else if (k[0] === '#') applyBlockStyle('h' + k.length);
        else toggleList('UL');
        markChanged(); return;
      }
    }
    if (!/[\s .,;:!?)\]]/.test(ch)) return;
    const prev = before.slice(0, -1); const tdata = n.data; const end = off - 1;      // `end` = index of the typed character in this text node
    if (end < 0 || tdata[end] !== ch && !(ch === ' ' && tdata[end] === ' ')) return;
    const replaceAt = (len, to) => {
      if (end - len < 0 || tdata.slice(end - len, end) !== prev.slice(-len)) return false;
      History.push('ac', true);
      n.replaceData(end - len, len, to);
      const c = document.createRange(); c.setStart(n, end - len + to.length + 1); c.collapse(true); setRange(c); markChanged(); return true;
    };
    // 2) your own shortcuts and symbols
    const custom = (settings.acCustom || []).filter(([a]) => a);
    for (const [from, to] of custom) {
      if (prev.endsWith(from) && (prev.length === from.length || /[\s (["'“‘]/.test(prev[prev.length - from.length - 1]))) { if (replaceAt(from.length, to)) return; }
    }
    if (acOn('symbols')) for (const [from, to] of AC_SYMBOLS) {
      if (!prev.endsWith(from)) continue;
      if (/^\d/.test(from) && prev.length > from.length && /[\d/]/.test(prev[prev.length - from.length - 1])) continue;
      if (replaceAt(from.length, to)) return;
    }
    // 3) capitals: "i" → "I", and the first word of a sentence
    if (acOn('caps')) {
      if (/(^|[\s (])i$/.test(prev)) { replaceAt(1, 'I'); return; }
      const m = /([a-z][a-z'’-]*)$/.exec(prev); if (!m) return;
      const head = prev.slice(0, prev.length - m[1].length);
      const start = !head.trim() || (/[.!?]["'”’)]?[\s ]+$/.test(head) && !AC_ABBR.test(head.trimEnd()));
      if (start && !/^(www|http|https|e|i)$/.test(m[1]) && !/[@/\\.]/.test(m[1])) replaceAt(m[1].length, m[1][0].toUpperCase() + m[1].slice(1));
    }
  },
  quote(e) {                                            // smart quotes, from beforeinput
    if (!acOn('quotes') || !cur || (e.data !== '"' && e.data !== "'")) return false;
    const r = selRange(); if (!r) return false;
    if (closestEl(r.startContainer, 'pre, code')) return false;
    const block = closestEl(r.startContainer, 'li') || blockOf(r.startContainer); if (!block) return false;
    const prev = this.textBefore(block, r.startContainer, r.startOffset).slice(-1);
    const open = !prev || /[\s (\[{“‘—–-]/.test(prev);
    e.preventDefault();
    insertText(e.data === '"' ? (open ? '“' : '”') : (open ? '‘' : '’'));
    return true;
  }
};
async function autoCorrectDialog() {
  const a = settings.ac || {};
  const body = document.createElement('div');
  body.innerHTML = `${[['lists', 'Start lists and headings as you type (“1. ”, “- ”, “[] ”, “# ”, “> ”)'], ['symbols', 'Replace symbols: -- → —, ... → …, (c) → ©, -> → →, 1/2 → ½'], ['caps', 'Capitalise the first letter of sentences and “i”'], ['quotes', 'Use curly quotes “ ” ‘ ’']].map(([k, l]) => `<label class="ac-row"><input type="checkbox" data-k="${k}" ${a[k] !== false ? 'checked' : ''}>${esc(l)}</label>`).join('')}
    <div class="field" style="margin-top:12px"><label>Your own shortcuts — one per line, <code>shortcut = replacement</code></label>
      <textarea id="acCustom" style="min-height:130px;font-family:'Roboto Mono',monospace;font-size:12.5px" placeholder="addr = 12 MG Road, New Delhi&#10;sig = Regards, Your Name">${esc((settings.acCustom || []).map(([f, t]) => `${f} = ${t}`).join('\n'))}</textarea>
      <div class="hint">Type the shortcut followed by a space or punctuation. Press ${isMac ? '⌘' : 'Ctrl'}+Z right after any correction to undo it.</div></div>`;
  const res = await modal({ title: 'AutoCorrect', body, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: () => ({
    ac: Object.fromEntries($$('[data-k]', body).map(x => [x.dataset.k, x.checked])),
    custom: $('#acCustom', body).value.split('\n').map(l => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; }).filter(x => x && x[0] && x[1]) }) }] });
  if (!res) return;
  settings.ac = res.ac; settings.acCustom = res.custom.sort((x, y) => y[0].length - x[0].length); saveSettings(); toast('AutoCorrect saved');
}

/* ================================================================ actions */
const act = {
  fileMenu(el) {
    showMenu(el, [
      { icon: 'file-plus', label: 'New document', kbd: 'Alt+N', act: act.newDoc },
      { icon: 'folder-open', label: 'Open…', act: () => { $('#sidebar').classList.remove('closed'); $('#docSearch').focus(); } },
      { icon: 'file-up', label: 'Import (.docx, .md, .html, .txt)', act: act.import },
      { icon: 'copy', label: 'Make a copy', act: () => duplicateDoc(cur) },
      'sep', { header: 'Download as' },
      { icon: 'file-down', label: 'Word document (.docx)', act: () => exportAs('docx') },
      { icon: 'printer', label: 'PDF (Print → Save as PDF)', act: () => exportAs('pdf') },
      { icon: 'code', label: 'Web page (.html)', act: () => exportAs('html') },
      { icon: 'file-text', label: 'Markdown (.md)', act: () => exportAs('md') },
      { icon: 'type', label: 'Plain text (.txt)', act: () => exportAs('txt') },
      'sep',
      { icon: 'printer', label: 'Print', kbd: isMac ? '⌘P' : 'Ctrl+P', act: () => window.print() },
      { icon: 'download', label: 'Back up all documents (.json)', act: backupAll },
      { icon: 'upload', label: 'Restore from backup', act: act.import },
      'sep',
      { icon: 'cloud', label: 'Sync settings', act: act.syncSettings },
      { icon: 'settings', label: 'Settings', act: act.settings },
      { icon: 'wand-sparkles', label: 'AutoCorrect options', act: autoCorrectDialog },
      { icon: 'type', label: 'Keyboard shortcuts', act: showShortcuts }
    ]);
  },
  exportMenu(el) {
    showMenu(el, [
      { icon: 'file-down', label: 'Word document (.docx)', act: () => exportAs('docx') },
      { icon: 'printer', label: 'PDF', act: () => exportAs('pdf') },
      { icon: 'code', label: 'Web page (.html)', act: () => exportAs('html') },
      { icon: 'file-text', label: 'Markdown (.md)', act: () => exportAs('md') },
      { icon: 'type', label: 'Plain text (.txt)', act: () => exportAs('txt') }
    ], { right: true });
  },
  newDoc: () => templatesDialog(),
  undo: () => { editor.focus({ preventScroll: true }); History.undo(); },
  redo: () => { editor.focus({ preventScroll: true }); History.redoOp(); },
  import: () => $('#fileImport').click(),
  pastePlain: async () => {
    try { const t = await navigator.clipboard.readText(); if (t) insertText(t); }
    catch { forcePlain = true; toast(`Press ${isMac ? '⌘' : 'Ctrl'}+V to paste as plain text`); editor.focus(); }
  },
  applyFore: () => exec('foreColor', $('#foreColor').value),
  applyBack: () => exec('hiliteColor', $('#backColor').value),
  clearFormat, checklist: toggleChecklist,
  indent: () => indent(1), outdent: () => indent(-1),
  find: () => openPanel('find'),
  replace: () => { openPanel('find'); setTimeout(() => $('#fr') && $('#fr').focus(), 30); },
  tableMenu: el => tableMenu(el),
  image: () => $('#fileImage').click(),
  link: () => linkDialog(),
  hr: () => insertHTMLAtCaret('<hr><p><br></p>'),
  pageBreak: () => insertHTMLAtCaret('<div class="page-break" contenteditable="false"></div><p><br></p>'),
  codeBlock: () => applyBlockStyle('pre'),
  charMenu(el) {
    const chars = '₹ € £ $ ¥ © ® ™ § ¶ † ‡ • · … – — ‘ ’ “ ” « » ° ± × ÷ ≠ ≈ ≤ ≥ ∞ √ ∑ π µ Ω α β γ δ λ θ Δ → ← ↑ ↓ ↔ ⇒ ✓ ✗ ★ ☆ ♥ ☐ ☑ ½ ¼ ¾ ² ³ ¹ ‰ ‽ ¿ ¡ ä é ñ ö ü ç ß'.split(' ');
    const wrap = document.createElement('div'); wrap.className = 'char-grid';
    chars.forEach(c => { const b = document.createElement('button'); b.textContent = c; b.title = 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'); b.onmousedown = e => e.preventDefault(); b.onclick = () => { hideMenu(); insertText(c); }; wrap.appendChild(b); });
    showMenu(el, [{ node: wrap }]);
  },
  dateMenu(el) {
    const d = new Date();
    const opts = [
      d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
      d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      d.toLocaleDateString('en-GB'), d.toISOString().slice(0, 10),
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    ];
    showMenu(el, opts.map(o => ({ label: o, act: () => insertText(o) })));
  },
  toc: () => { insertHTMLAtCaret('<div class="toc" contenteditable="false"></div><p><br></p>'); updateTOCs(true); markChanged(); },
  tocUpdate: () => { if (!editor.querySelector('.toc')) { toast('Insert a table of contents first (Insert → Contents)'); return; } History.push('toc', true); updateTOCs(false); },
  comment: addComment,
  painter: () => {},
  paragraph: () => paragraphDialog(),
  stylesDialog: () => stylesDialog(),
  toggleRuler: () => { settings.ruler = !settings.ruler; saveSettings(); Ruler.render(); Pager.sig = ''; Pager.run(); },
  toggleNav: () => { const sb = $('#sidebar'); if (Nav.open && !sb.classList.contains('closed')) { showSidePane('docs'); return; } sb.classList.remove('closed'); showSidePane('nav'); },
  acOptions: () => autoCorrectDialog(),
  tblShade: () => tableOp('shade'),
  tblDelete(el) { showMenu(el, [{ icon: 'rows-3', label: 'Delete row', act: () => tableOp('delRow') }, { icon: 'columns-3', label: 'Delete column', act: () => tableOp('delCol') }, { icon: 'trash-2', label: 'Delete table', danger: true, act: () => tableOp('delTable') }]); },
  footnote: insertFootnote,
  columnsMenu(el) {
    showMenu(el, [{ header: 'Selected paragraphs, or whole document' },
      { label: 'One column', act: () => setColumns(1) }, { label: 'Two columns', act: () => setColumns(2) }, { label: 'Three columns', act: () => setColumns(3) }]);
  },
  mmRecipients: () => mmRecipients(),
  mmField(el) {
    const d = mmData();
    if (!d) { toast('Add a recipient list first'); mmRecipients(); return; }
    showMenu(el, d.fields.map(f => ({ icon: 'braces', label: f, act: () => { insertAtom(atom('span', 'mf', { field: f })); mmApply(); } })));
  },
  mmPreview: () => { if (!mmData()) { toast('Add a recipient list first'); return; } MM.preview = !MM.preview; mmApply(); },
  mmPrev: () => { const d = mmData(); if (!d) return; MM.idx = (MM.idx - 1 + d.rows.length) % d.rows.length; MM.preview = true; mmApply(); },
  mmNext: () => { const d = mmData(); if (!d) return; MM.idx = (MM.idx + 1) % d.rows.length; MM.preview = true; mmApply(); },
  mmFinish(el) {
    showMenu(el, [
      { icon: 'file-plus', label: 'Merge to a new document', act: () => mmFinish('doc') },
      { icon: 'printer', label: 'Print / PDF all letters', act: () => mmFinish('print') },
      { icon: 'file-down', label: 'One Word file (.docx)', act: () => mmFinish('docx') },
      { icon: 'files', label: 'Separate Word files (.zip)', act: () => mmFinish('zip') }]);
  },
  orient: async el => { cur.page.orient = el.dataset.v; applyPage(); await commitMeta(); },
  editHeader: () => { hdr.focus(); placeCaretAtEnd(hdr); },
  editFooter: () => { ftr.focus(); placeCaretAtEnd(ftr); },
  pageNumbers(el) {
    const set = async (where, text) => { (where === 'h' ? hdr : ftr).innerText = text; markChanged(); };
    showMenu(el, [
      { label: 'Footer: Page 1 of N', act: () => set('f', 'Page {page} of {pages}') },
      { label: 'Footer: 1', act: () => set('f', '{page}') },
      { label: 'Header: Title · Page 1', act: () => set('h', '{title} · Page {page}') },
      { label: 'Remove page numbers', act: () => { [hdr, ftr].forEach(f => { f.innerText = f.innerText.replace(/\s*(Page\s*)?\{page\}(\s*of\s*\{pages\})?/gi, '').replace(/\s*·\s*$/, ''); }); markChanged(); } }
    ]);
  },
  toggleTrack: () => toggleTrack(),
  toggleMarkup: () => { settings.markup = !settings.markup; saveSettings(); applyTrackUI(); },
  changesPanel: () => openPanel('changes'),
  acceptAll: () => acceptAll(true), rejectAll: () => acceptAll(false),
  commentsPanel: () => openPanel('comments'),
  saveVersion: saveVersionDialog,
  versionsPanel: () => openPanel('versions'),
  toggleSpell: () => { settings.spell = !settings.spell; saveSettings(); applySpell(); },
  wordCount: () => {
    const r = selRange(); const selText = r && !r.collapsed ? r.toString() : '';
    const t = visibleText();
    const words = (t.match(/[^\s ]+/g) || []).length;
    const rows = [['Pages', stats.pages], ['Words', words], ['Characters (no spaces)', t.replace(/\s/g, '').length], ['Characters (with spaces)', t.replace(/\n/g, '').length],
      ['Paragraphs', t.split('\n').filter(x => x.trim()).length], ['Reading time', Math.max(1, Math.round(words / 230)) + ' min']];
    if (selText) rows.push(['Words in selection', (selText.match(/[^\s ]+/g) || []).length]);
    modal({ title: 'Word count', body: `<table style="width:100%;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:var(--muted)">${k}</td><td style="text-align:right;font-weight:600">${v.toLocaleString ? v.toLocaleString() : v}</td></tr>`).join('')}</table>`, buttons: [{ label: 'Close', primary: true }] });
  },
  zoomIn: () => setZoom(settings.zoom + 10), zoomOut: () => setZoom(settings.zoom - 10), zoomReset: () => setZoom(100), zoomFit,
  togglePages: () => { settings.pageView = settings.pageView === 'continuous' ? 'pages' : 'continuous'; saveSettings(); $('#btnPages').classList.toggle('on', settings.pageView !== 'continuous'); Pager.run(); toast(settings.pageView === 'continuous' ? 'Continuous view — page breaks hidden' : 'Page view'); },
  focusMode: () => { document.body.classList.toggle('focus'); hideFloatbars(); },
  fullscreen: () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); },
  theme: el => setTheme(el.dataset.v),
  themeCycle: () => setTheme({ system: 'light', light: 'dark', dark: 'system' }[settings.theme] || 'system'),
  closePanel,
  syncSettings: () => syncDialog(),
  settings: () => settingsDialog()
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const f = act[b.dataset.act]; if (f) { e.preventDefault(); f(b); }
});

function applySpell() { editor.spellcheck = settings.spell; $('#btnSpell').classList.toggle('on', settings.spell); }
function setTheme(t) {
  settings.theme = t; saveSettings();
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const ic = $('[data-act="themeCycle"]'); ic.innerHTML = `<i data-lucide="${t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'monitor'}"></i>`; ic.title = 'Theme: ' + t; icons();
}

/* global shortcuts */
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
  const inEd = document.activeElement === editor;
  if (e.key === 'Escape') {
    if ($('#overlay').classList.contains('show')) { closeModal(null); return; }
    if (Painter.fmt) { Painter.off(); return; }
    if (menuEl.classList.contains('show')) { hideMenu(); return; }
    if (document.body.classList.contains('focus')) { document.body.classList.remove('focus'); return; }
    if (panelMode) { closePanel(); return; }
    hideFloatbars();
  }
  if ($('#overlay').classList.contains('show')) return;
  if (e.altKey && !mod && k === 'n') { e.preventDefault(); act.newDoc(); return; }
  if (!mod) return;
  const map = {
    s: () => (e.shiftKey ? saveVersionDialog() : (pendingSave = true, saveNow().then(() => { Sync.run(); toast(Sync.enabled() ? 'Saved — syncing' : 'Saved'); }))),
    f: () => openPanel('find'), h: () => act.replace(), k: () => linkDialog(),
    '\\': () => clearFormat()
  };
  if (!e.altKey && map[k] && !(k === 'h' && e.shiftKey)) { e.preventDefault(); map[k](); return; }
  if (e.shiftKey && !e.altKey) {
    const sm = { 7: () => toggleList('OL'), 8: () => toggleList('UL'), 9: toggleChecklist,
      l: () => exec('justifyLeft'), e: () => (inEd || !cur ? exec('justifyCenter') : 0), r: () => exec('justifyRight'), j: () => exec('justifyFull'),
      x: () => toggleTrack(), o: () => $('#sidebar').classList.toggle('closed'), v: () => { forcePlain = true; } };
    const code = e.code.replace(/^(Digit|Key)/, '').toLowerCase();
    if (sm[code]) { if (code !== 'v') e.preventDefault(); sm[code](); return; }
  }
  if (e.altKey) {
    const code = e.code.replace(/^(Digit|Key)/, '').toLowerCase();
    if (code === 'm') { e.preventDefault(); addComment(); return; }
    if (code === 'f') { e.preventDefault(); insertFootnote(); return; }
    if (/^[0-4]$/.test(code) && inEd) { e.preventDefault(); applyBlockStyle(code === '0' ? 'p' : 'h' + code); return; }
  }
  if (inEd && !e.altKey) {
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); History.undo(); return; }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); History.redoOp(); return; }
  }
});

/* ========================================================== documents UI */
function renderDocList() {
  const q = $('#docSearch').value.trim().toLowerCase();
  const all = [...docs.values()].filter(d => !d.purged);
  const match = d => !q || d.title.toLowerCase().includes(q) || d.html.replace(/<[^>]+>/g, ' ').toLowerCase().includes(q);
  const live = all.filter(d => !d.deleted && match(d)).sort((a, b) => b.updatedAt - a.updatedAt);
  const trash = all.filter(d => d.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
  const row = (d, isTrash) => `<div class="doc-item ${cur && d.id === cur.id ? 'active' : ''}" data-id="${esc(d.id)}" ${isTrash ? 'data-trash="1"' : ''}>
      <i data-lucide="${isTrash ? 'trash-2' : 'file-text'}"></i><div class="meta"><div class="name">${esc(d.title)}</div><div class="when">${timeAgo(d.updatedAt)}${d.dirty && Sync.enabled() ? ' · not synced' : ''}</div></div>
      <button class="icon-btn" data-docmenu title="More"><i data-lucide="ellipsis-vertical"></i></button></div>`;
  let html = live.map(d => row(d)).join('') || `<div class="empty">${q ? 'No matches' : 'No documents'}</div>`;
  if (trash.length && !q) html += `<div class="side-section">Trash</div>` + trash.map(d => row(d, true)).join('');
  $('#docList').innerHTML = html; icons();
}
$('#docList').addEventListener('click', e => {
  const item = e.target.closest('.doc-item'); if (!item) return;
  const d = docs.get(item.dataset.id); if (!d) return;
  if (e.target.closest('[data-docmenu]')) {
    const btn = e.target.closest('[data-docmenu]');
    if (d.deleted) showMenu(btn, [
      { icon: 'rotate-ccw', label: 'Restore', act: async () => { d.deleted = false; await commitMeta(d); renderDocList(); } },
      { icon: 'trash-2', label: 'Delete forever', danger: true, act: () => purgeDoc(d) }]);
    else showMenu(btn, [
      { icon: 'pencil', label: 'Rename', act: async () => { const r = await promptDialog('Rename', [{ name: 't', label: 'Title', value: d.title }], 'Rename'); if (r) { d.title = r.t.trim() || 'Untitled document'; if (d === cur) $('#docTitle').value = d.title; await commitMeta(d); } } },
      { icon: 'copy', label: 'Make a copy', act: () => duplicateDoc(d) },
      { icon: 'file-down', label: 'Download .docx', act: () => exportAs('docx', d) },
      'sep', { icon: 'trash-2', label: 'Move to trash', danger: true, act: () => trashDoc(d) }]);
    return;
  }
  if (d.deleted) { toast('Restore it from the ⋮ menu to open'); return; }
  openDoc(d.id);
});
async function createDoc(t) {
  const d = makeDoc(t); if (Array.isArray(t.comments)) d.comments = t.comments; docs.set(d.id, d); await DB.put(d); post({ type: 'saved', id: d.id });
  await openDoc(d.id); Sync.schedule(); setTimeout(() => editor.focus(), 50);
  return d;
}
async function duplicateDoc(d) {
  if (d === cur) { pendingSave = true; await saveNow(); }
  const c = makeDoc({ title: d.title + ' (copy)', html: d.html, header: d.header, footer: d.footer, page: JSON.parse(JSON.stringify(d.page)) });
  c.comments = JSON.parse(JSON.stringify(d.comments));
  docs.set(c.id, c); await DB.put(c); await openDoc(c.id); Sync.schedule(); toast('Copy created');
}
async function trashDoc(d) {
  d.deleted = true; await commitMeta(d);
  if (cur && d.id === cur.id) { const next = liveDocs().sort((a, b) => b.updatedAt - a.updatedAt)[0]; if (next) openDoc(next.id); else createDoc(LEKH_TEMPLATES[0]); }
  renderDocList(); toast('Moved to trash');
}
async function purgeDoc(d) {
  if (!await confirmDialog('Delete forever?', `“${esc(d.title)}” will be removed from this device${Sync.enabled() ? ' and from your sync gist' : ''}. This can't be undone.`, 'Delete', true)) return;
  if (d.base) { d.purged = true; d.html = ''; d.versions = []; d.comments = []; touch(d); await DB.put(d); Sync.schedule(500); }
  else { docs.delete(d.id); await DB.del(d.id); }
  post({ type: 'reload' }); renderDocList();
}
function templatesDialog() {
  const wrap = document.createElement('div'); wrap.className = 'tpl-grid';
  LEKH_TEMPLATES.forEach(t => {
    const b = document.createElement('button'); b.className = 'tpl';
    b.innerHTML = `<div class="thumb">${sanitize(t.html)}</div><div class="tname">${esc(t.name)}</div>`;
    b.onclick = () => { closeModal(null); createDoc(t); };
    wrap.appendChild(b);
  });
  modal({ title: 'New document', body: wrap, wide: true, buttons: [] });
}

/* ================================================================= import */
async function importFile(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const base = f.name.replace(/\.[^.]+$/, '');
  try {
    if (ext === 'json') return restoreBackup(await f.text());
    let html = '', note = '';
    if (ext === 'docx' && window.LekhDocx) {
      try {
        await libReady('JSZip', 'the Word importer');
        const r = await LekhDocx.convert(await f.arrayBuffer());
        await createDoc({ title: base, html: sanitize(r.html) || '<p><br></p>', header: r.header, footer: r.footer, page: r.page, comments: r.comments });
        toast(`Imported “${base}”`); return;
      } catch (err) { console.warn('[import] falling back to basic importer', err); }
    }
    if (ext === 'docx') {
      const m = await libReady('mammoth', 'the Word importer');
      const res = await m.convertToHtml({ arrayBuffer: await f.arrayBuffer() }, {
        styleMap: ["p[style-name='Title'] => p.title:fresh", "p[style-name='Subtitle'] => p.subtitle:fresh",
          "p[style-name='Quote'] => blockquote:fresh", "p[style-name='Intense Quote'] => blockquote:fresh", "u => u", "strike => s"]
      });
      html = res.value; note = 'Imported. Text, headings, lists, tables, links and images come across; fonts, colours and headers/footers don’t.';
    } else if (ext === 'md' || ext === 'markdown') {
      const mk = await libReady('marked', 'the Markdown importer');
      const t = document.createElement('template'); t.innerHTML = mk.parse(await f.text());
      $$('li > input[type=checkbox]', t.content).forEach(cb => { const li = cb.parentElement; li.dataset.checked = cb.hasAttribute('checked') ? 'true' : 'false'; li.parentElement.classList.add('checklist'); cb.remove(); });
      html = t.innerHTML;
    } else if (ext === 'html' || ext === 'htm') {
      const d = new DOMParser().parseFromString(await f.text(), 'text/html'); html = d.body.innerHTML;
    } else {
      html = (await f.text()).replace(/\r\n?/g, '\n').split('\n').map(l => l.trim() ? `<p>${esc(l)}</p>` : '<p><br></p>').join('');
    }
    await createDoc({ title: base, html: sanitize(html) || '<p><br></p>' });
    toast(note || 'Imported “' + base + '”');
  } catch (e) { console.error(e); toast('Import failed: ' + e.message, { err: true }); }
}
function backupAll() {
  const out = { app: 'lekh', version: 1, exportedAt: new Date().toISOString(), docs: [...docs.values()].filter(d => !d.purged).map(d => { const c = { ...d }; delete c.dirty; delete c.base; delete c.vDirty; delete c.vSynced; return c; }) };
  download(new Blob([JSON.stringify(out)], { type: 'application/json' }), `lekh-backup-${new Date().toISOString().slice(0, 10)}.json`);
}
async function restoreBackup(text) {
  const data = safeJSON(text);
  if (!data || data.app !== 'lekh' || !Array.isArray(data.docs)) { toast('That isn’t a Lekh backup file', { err: true }); return; }
  if (!await confirmDialog('Restore backup?', `${data.docs.length} document(s). Documents that already exist here are kept if they are newer; older ones are replaced.`, 'Restore')) return;
  let n = 0;
  for (const raw of data.docs) {
    const d = normalizeDoc(raw); const ex = docs.get(d.id);
    if (ex && ex.updatedAt >= d.updatedAt) continue;
    d.dirty = true; d.vDirty = true; d.base = ex?.base || null; d.vSynced = ex?.vSynced || false; d.ver = uid('v');
    docs.set(d.id, d); await DB.put(d); n++;
  }
  post({ type: 'reload' }); renderDocList(); Sync.schedule();
  toast(`Restored ${n} document(s)`);
  if (cur && docs.get(cur.id) !== cur) { cur = docs.get(cur.id); renderCurrent({ force: true }); }
}

/* ================================================================= export */
function finalClone(root = editor) {
  const c = root.cloneNode(true);
  $$('.pg-gap', c).forEach(g => g.remove());
  $$('.cols-flow', c).forEach(x => x.classList.remove('cols-flow'));
  $$('.mf', c).forEach(m => m.replaceWith(document.createTextNode('«' + m.dataset.field + '»')));
  const fns = $$('sup.fn', c);
  if (fns.length) {
    const ol = document.createElement('ol'); ol.className = 'footnotes';
    fns.forEach((f, i) => { const s = document.createElement('sup'); s.textContent = i + 1; f.replaceWith(s); const li = document.createElement('li'); li.textContent = f.dataset.note || ''; ol.appendChild(li); });
    c.appendChild(document.createElement('hr')); c.appendChild(ol);
  }
  $$('del.tc', c).forEach(d => d.remove());
  $$('ins.tc, .cmt', c).forEach(i => i.replaceWith(...i.childNodes));
  $$('.img-selected', c).forEach(i => i.classList.remove('img-selected'));
  c.innerHTML = c.innerHTML.replace(/​/g, '');
  return c;
}
async function exportAs(kind, d = cur) {
  if (!d) return;
  if (d === cur && pendingSave) await saveNow();
  const name = safeName(d.title);
  try {
    if (kind === 'pdf') { if (d !== cur) await openDoc(d.id); toast('Choose “Save as PDF” as the printer'); setTimeout(() => window.print(), 300); return; }
    const root = d === cur ? editor : mountOffscreen(d);
    try {
      if (kind === 'docx') { toast('Building Word file…'); download(await buildDocx(d, root), name + '.docx'); }
      else if (kind === 'html') download(new Blob([standaloneHTML(d, finalClone(root).innerHTML)], { type: 'text/html' }), name + '.html');
      else if (kind === 'md') {
        const TD = await libReady('TurndownService', 'the Markdown exporter');
        const td = new TD({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
        if (window.turndownPluginGfm) td.use(turndownPluginGfm.gfm);
        td.addRule('checklist', { filter: n => n.nodeName === 'LI' && n.parentNode.classList?.contains('checklist'), replacement: (c, n) => `- [${n.dataset.checked === 'true' ? 'x' : ' '}] ${c.trim()}\n` });
        td.addRule('pagebreak', { filter: n => n.classList?.contains('page-break'), replacement: () => '\n\n---\n\n' });
        td.addRule('subtitle', { filter: n => n.nodeName === 'P' && n.classList?.contains('title'), replacement: c => `# ${c}\n\n` });
        download(new Blob([`# ${d.title}\n\n` + td.turndown(finalClone(root))], { type: 'text/markdown' }), name + '.md');
      } else if (kind === 'txt') {
        const c = finalClone(root); document.body.appendChild(c); c.style.cssText = 'position:absolute;left:-99999px;white-space:normal';
        const text = c.innerText; c.remove();
        download(new Blob([text], { type: 'text/plain' }), name + '.txt');
      }
    } finally { if (root !== editor) root.remove(); }
  } catch (e) { console.error(e); toast('Export failed: ' + e.message, { err: true }); }
}
function mountOffscreen(d) {
  const { w } = pageDims(d); const m = d.page.margins;
  const el = document.createElement('div'); el.id = 'editor-offscreen';
  el.style.cssText = `position:absolute;left:-99999px;top:0;width:${(w - m.l - m.r)}in`;
  el.innerHTML = sanitize(d.html); document.body.appendChild(el);
  return el;
}
function standaloneHTML(d, body) {
  const { w, h } = pageDims(d); const m = d.page.margins;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.title)}</title>
<style>@page{size:${w}in ${h}in;margin:${m.t}in ${m.r}in ${m.b}in ${m.l}in}body{font:11pt/1.45 Calibri,Carlito,'Segoe UI',Arial,sans-serif;color:#1c2230;max-width:${w - m.l - m.r}in;margin:40px auto;padding:0 16px}
p{margin:0 0 8pt}h1{font-size:20pt;color:#1f3864}h2{font-size:15pt;color:#2f5496}h3{font-size:12.5pt;color:#2f5496}.title{font-size:28pt;font-weight:300;margin:0 0 4pt}.subtitle{font-size:14pt;color:#5b6472}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #a9b0bc;padding:4pt 6pt;vertical-align:top}th{background:#eef1f6;text-align:left}img{max-width:100%;height:auto}
blockquote{border-left:3px solid #c5cbd6;margin:8pt 0;padding:2pt 0 2pt 14pt;color:#485160;font-style:italic}pre{background:#f3f4f6;padding:8pt;border-radius:4px;white-space:pre-wrap}
.footnotes{font-size:9pt;color:#333}ul.checklist{list-style:none}ul.checklist li::before{content:'☐ '}ul.checklist li[data-checked=true]::before{content:'☑ '}.page-break{break-after:page;border:0}.toc a{display:block;color:inherit;text-decoration:none}.toc .l2{padding-left:14pt}.toc .l3{padding-left:28pt}.toc-title{font-weight:700}
</style></head><body>${body}</body></html>`;
}

/* ---------- HTML → .docx ---------- */
const PT = { 'xx-small': 7, 'x-small': 7.5, small: 10, medium: 12, large: 13.5, 'x-large': 18, 'xx-large': 24, 'xxx-large': 36 };
function toHex(c) {
  if (!c) return undefined;
  c = c.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.slice(1).toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return c.slice(1).split('').map(x => x + x).join('').toUpperCase();
  const m = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
  if (m) { if (m[4] !== undefined && +m[4] === 0) return undefined; return [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, '0')).join('').toUpperCase(); }
  const named = { black: '000000', white: 'FFFFFF', red: 'FF0000', blue: '0000FF', green: '008000', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500' };
  return named[c.toLowerCase()];
}
function toPt(v) {
  if (!v) return undefined; if (PT[v]) return PT[v];
  const n = parseFloat(v); if (!n) return undefined;
  return v.endsWith('px') ? n * 0.75 : v.endsWith('em') || v.endsWith('rem') ? n * 11 : n;
}
const twip = inches => Math.round(inches * 1440);
function lenToTwip(v) { if (!v) return 0; const n = parseFloat(v) || 0; return v.endsWith('in') ? twip(n) : v.endsWith('pt') ? Math.round(n * 20) : v.endsWith('cm') ? twip(n / 2.54) : Math.round(n * 15); }

async function buildDocx(d, root) {
  const D = await libReady('docx', 'the Word exporter');
  mergeTCIn(root);
  const z = root === editor ? settings.zoom / 100 : 1;
  const st = { revId: 1, olInstance: 0, rightTab: false, fnCount: 0, footnotes: {} };
  const [cw0, ch0] = portraitDims(d);
  const contentTw = twip((d.page.orient === 'landscape' ? ch0 : cw0) - d.page.margins.l - d.page.margins.r);
  const date = new Date().toISOString();

  function fmtFrom(el, fmt) {
    const f = { ...fmt }; const tag = el.tagName; const s = el.style;
    if (tag === 'B' || tag === 'STRONG') f.bold = true;
    if (tag === 'I' || tag === 'EM') f.italics = true;
    if (tag === 'U') f.underline = true;
    if (tag === 'S' || tag === 'STRIKE') f.strike = true;
    if (tag === 'SUB') f.sub = true; if (tag === 'SUP') f.sup = true;
    if (tag === 'MARK') f.bg = 'FFF59D';
    if (tag === 'CODE') f.font = 'Consolas';
    if (tag === 'FONT') { if (el.color) f.color = toHex(el.color); if (el.face) f.font = el.face.split(',')[0].replace(/["']/g, '').trim(); }
    if (tag === 'INS' && el.classList.contains('tc')) f.ins = { author: el.dataset.a || 'Unknown', date: el.dataset.t ? new Date(+el.dataset.t).toISOString() : date };
    if (tag === 'DEL' && el.classList.contains('tc')) f.del = { author: el.dataset.a || 'Unknown', date: el.dataset.t ? new Date(+el.dataset.t).toISOString() : date };
    if (s) {
      if (s.fontWeight === 'bold' || +s.fontWeight >= 600) f.bold = true; else if (s.fontWeight === 'normal' || (+s.fontWeight && +s.fontWeight < 600)) f.bold = false;
      if (s.fontStyle === 'italic') f.italics = true;
      const td = s.textDecorationLine || s.textDecoration || '';
      if (td.includes('underline')) f.underline = true; if (td.includes('line-through')) f.strike = true;
      if (s.color) { const c = toHex(s.color); if (c) f.color = c; }
      if (s.backgroundColor) { const c = toHex(s.backgroundColor); if (c) f.bg = c; }
      if (s.fontSize) { const p = toPt(s.fontSize); if (p) f.size = p; }
      if (s.fontFamily) { const fam = s.fontFamily.split(',')[0].replace(/["']/g, '').trim(); f.font = fam === 'Carlito' ? 'Calibri' : fam === 'EB Garamond' ? 'Garamond' : fam; }
      if (s.verticalAlign === 'sub') f.sub = true; if (s.verticalAlign === 'super') f.sup = true;
    }
    return f;
  }
  function runOpts(f) {
    const o = {};
    if (f.bold) o.bold = true; if (f.italics) o.italics = true; if (f.underline) o.underline = {}; if (f.strike) o.strike = true;
    if (f.sub) o.subScript = true; if (f.sup) o.superScript = true; if (f.color) o.color = f.color;
    if (f.size) o.size = Math.round(f.size * 2); if (f.font) o.font = f.font;
    if (f.bg) o.shading = { type: D.ShadingType.CLEAR, fill: f.bg, color: 'auto' };
    if (f.link) o.style = 'Hyperlink';
    return o;
  }
  function textRun(text, f) {
    const o = { ...runOpts(f), text };
    if (f.ins) return new D.InsertedTextRun({ ...o, id: st.revId++, author: f.ins.author, date: f.ins.date });
    if (f.del) return new D.DeletedTextRun({ ...o, id: st.revId++, author: f.del.author, date: f.del.date });
    return new D.TextRun(o);
  }
  function imageRun(img) {
    let src = img.getAttribute('src') || '';
    const m = /^data:image\/([a-z+]+);base64,(.*)$/i.exec(src);
    let type = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : null;
    let b64 = m ? m[2] : null;
    if (!m || !['png', 'jpg', 'gif', 'bmp'].includes(type)) {
      try { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); b64 = c.toDataURL('image/png').split(',')[1]; type = 'png'; }
      catch { return new D.TextRun({ text: `[image${img.alt ? ': ' + img.alt : ''}]`, italics: true, color: '888888' }); }
    }
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const rect = img.getBoundingClientRect();
    let w = rect.width / z, h = rect.height / z;
    if (!w || !h) { w = img.naturalWidth || 300; h = img.naturalHeight || 200; const max = 624; if (w > max) { h = h * max / w; w = max; } }
    const fl = img.style.float;
    const floating = fl === 'left' || fl === 'right' ? {
      horizontalPosition: { relative: D.HorizontalPositionRelativeFrom.COLUMN, align: fl === 'left' ? D.HorizontalPositionAlign.LEFT : D.HorizontalPositionAlign.RIGHT },
      verticalPosition: { relative: D.VerticalPositionRelativeFrom.PARAGRAPH, offset: 0 },
      wrap: { type: D.TextWrappingType.SQUARE, side: D.TextWrappingSide.BOTH_SIDES },
      margins: { left: fl === 'right' ? 127000 : 0, right: fl === 'left' ? 127000 : 0, top: 0, bottom: 63500 }
    } : undefined;
    return new D.ImageRun({ type, data: bytes, transformation: { width: Math.round(w), height: Math.round(h) }, floating, altText: { title: img.alt || 'Image', description: img.alt || '', name: img.alt || 'image' } });
  }
  function inlines(node, fmt, out, pre) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        let t = c.data.replace(/​/g, '');
        if (!pre && !(c.parentElement && c.parentElement.style.whiteSpace === 'pre')) t = t.replace(/[ \n\r]+/g, ' ');
        if (!t) continue;
        const pieces = pre ? t.split(/(\n|\t)/) : t.split(/(\t)/);
        for (const p of pieces) {
          if (p === '\n') out.push(new D.TextRun({ break: 1 }));
          else if (p === '\t') out.push(new D.TextRun({ ...runOpts(fmt), children: [new D.Tab()] }));
          else if (p) out.push(textRun(p, fmt));
        }
      } else if (c.nodeType === 1) {
        const tag = c.tagName;
        if (c.classList.contains('pg-gap')) continue;
        if (tag === 'BR') { out.push(new D.TextRun({ break: 1 })); continue; }
        if (tag === 'SUP' && c.classList.contains('fn')) { const n = ++st.fnCount; st.footnotes[n] = { children: [new D.Paragraph(c.dataset.note || '')] }; out.push(new D.FootnoteReferenceRun(n)); continue; }
        if (c.classList.contains('mf')) { out.push(new D.SimpleMailMergeField(c.dataset.field || 'Field')); continue; }
        if (tag === 'IMG') { out.push(imageRun(c)); continue; }
        if (/^(UL|OL|TABLE)$/.test(tag)) continue;
        if (c.style && c.style.cssFloat === 'right') { st.rightTab = true; out.push(new D.TextRun({ children: [new D.Tab()] })); }
        if (tag === 'A' && c.getAttribute('href') && !c.getAttribute('href').startsWith('#')) {
          const kids = []; inlines(c, { ...fmtFrom(c, fmt), link: true, color: fmt.color || '1D5BBF', underline: true }, kids, pre);
          out.push(new D.ExternalHyperlink({ link: c.href, children: kids }));
          continue;
        }
        inlines(c, fmtFrom(c, fmt), out, pre || tag === 'PRE');
      }
    }
    return out;
  }
  function paraOpts(el, extra = {}) {
    const o = { ...extra }; const s = el.style || {};
    const ta = s.textAlign || el.getAttribute?.('align');
    if (ta === 'center') o.alignment = D.AlignmentType.CENTER; else if (ta === 'right') o.alignment = D.AlignmentType.RIGHT; else if (ta === 'justify') o.alignment = D.AlignmentType.JUSTIFIED;
    const lh = parseFloat(s.lineHeight); if (lh && !String(s.lineHeight).match(/px|pt|%/)) o.spacing = { ...(o.spacing || {}), line: Math.round(240 * lh / 1.2), lineRule: D.LineRuleType.AUTO };
    const ml = lenToTwip(s.marginLeft), ti = lenToTwip(s.textIndent);
    const mr = lenToTwip(s.marginRight);
    if (ml || ti || mr) o.indent = { ...(o.indent || {}), ...(ml ? { left: ml } : {}), ...(mr ? { right: mr } : {}), ...(ti > 0 ? { firstLine: ti } : ti < 0 ? { hanging: -ti } : {}) };
    if (s.marginTop || s.marginBottom) o.spacing = { ...(o.spacing || {}), ...(s.marginTop ? { before: lenToTwip(s.marginTop) } : {}), ...(s.marginBottom ? { after: lenToTwip(s.marginBottom) } : {}) };
    return o;
  }
  const isBlock = n => n.nodeType === 1 && /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR|SECTION|ARTICLE|HEADER|FOOTER|FIGURE)$/.test(n.tagName);
  function para(el, base = {}, fmt = {}) {
    st.rightTab = false;
    const kids = inlines(el, fmtFrom(el, fmt), [], el.tagName === 'PRE');
    const o = paraOpts(el, base);
    if (st.rightTab) { o.tabStops = [{ type: D.TabStopType.RIGHT, position: contentTw }]; st.rightTab = false; }
    const only = el.children.length === 1 && el.firstElementChild.tagName === 'IMG' && !el.textContent.trim() ? el.firstElementChild : null;
    if (only && only.style.display === 'block') {
      const l = only.style.marginLeft === 'auto', r = only.style.marginRight === 'auto';
      o.alignment = l && r ? D.AlignmentType.CENTER : l ? D.AlignmentType.RIGHT : D.AlignmentType.LEFT;
    }
    return new D.Paragraph({ ...o, children: kids });
  }
  function list(el, level, out) {
    const ordered = el.tagName === 'OL'; const check = el.classList.contains('checklist');
    const inst = ordered ? ++st.olInstance : 0;
    for (const li of el.children) {
      if (isList(li)) { list(li, level + 1, out); continue; }
      if (li.tagName !== 'LI') continue;
      const kids = [];
      if (check) kids.push(new D.TextRun((li.dataset.checked === 'true' ? '☑' : '☐') + ' '));
      const nested = [];
      let first = true;
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) { nested.push(c); continue; }
        if (c.nodeType === 1 && c.tagName === 'LI') { const w = document.createElement('ul'); w.appendChild(c.cloneNode(true)); nested.push(w); continue; }
        if (c.nodeType === 1 && /^(P|DIV)$/.test(c.tagName)) { if (!first) kids.push(new D.TextRun({ break: 1 })); inlines(c, fmtFrom(c, {}), kids); first = false; continue; }
        const tmp = document.createElement('span'); tmp.appendChild(c.cloneNode(true)); inlines(tmp, {}, kids); first = false;
      }
      const o = paraOpts(li, ordered ? { numbering: { reference: 'ol', level: Math.min(level, 5), instance: inst } } : check ? { indent: { left: 720 * (level + 1), hanging: 360 } } : { bullet: { level: Math.min(level, 5) } });
      out.push(new D.Paragraph({ ...o, children: kids }));
      nested.forEach(n => list(n, level + 1, out));
    }
  }
  function table(tbl) {
    const ts = tbl.dataset.ts || 'grid', bd = tbl.dataset.borders || (ts === 'minimal' ? 'horiz' : 'all');
    const banded = tbl.hasAttribute('data-banded') || ts === 'banded';
    const { pos, cols } = tableGrid(tbl);
    const cg = tbl.querySelector(':scope > colgroup');
    const pct = cg && cg.children.length === cols ? [...cg.children].map(c => parseFloat(c.style.width) || 100 / cols) : null;
    const fit = tbl.dataset.fit === 'auto';
    const L = D.BorderStyle.SINGLE, N = D.BorderStyle.NONE;
    const line = (on, color = 'A9B0BC', size = 4) => ({ style: on ? L : N, size: on ? size : 0, color: on ? color : 'FFFFFF' });
    const edge = bd === 'all' || bd === 'outer' || bd === 'horiz', sides = bd === 'all' || bd === 'outer';
    const col = ts === 'blue' ? 'C3D0E6' : 'A9B0BC';
    const borders = {
      top: line(edge, col), bottom: line(edge, col), left: line(sides, col), right: line(sides, col),
      insideHorizontal: line(bd === 'all' || bd === 'horiz', ts === 'minimal' ? 'DFE3EA' : col), insideVertical: line(bd === 'all', col)
    };
    const headFill = ts === 'blue' ? '2457A6' : (ts === 'minimal' || ts === 'plain') ? null : 'EEF1F6';
    let bodyIdx = 0;
    const rows = liveRows(tbl).map((tr, ri) => {
      const isHead = ri === 0 && [...tr.cells].every(c => c.tagName === 'TH');
      if (!isHead) bodyIdx++;
      const band = banded && !isHead && bodyIdx % 2 === 0;
      return new D.TableRow({
        tableHeader: isHead,
        children: [...tr.cells].map(td => {
          const th = td.tagName === 'TH';
          const kids = blocks(td, th ? { bold: true, ...(ts === 'blue' && isHead ? { color: 'FFFFFF' } : {}) } : {});
          const own = toHex(td.style.backgroundColor);
          const fill = own || (th ? headFill : band ? 'F3F6FB' : null);
          const va = td.style.verticalAlign;
          const p = pos.get(td);
          const w = pct && p ? pct.slice(p.c, p.c + td.colSpan).reduce((a, b) => a + b, 0) : null;
          return new D.TableCell({
            children: kids.length ? kids : [new D.Paragraph('')],
            columnSpan: td.colSpan > 1 ? td.colSpan : undefined, rowSpan: td.rowSpan > 1 ? td.rowSpan : undefined,
            shading: fill ? { fill, type: D.ShadingType.CLEAR, color: 'auto' } : undefined,
            verticalAlign: va === 'middle' ? D.VerticalAlign.CENTER : va === 'bottom' ? D.VerticalAlign.BOTTOM : undefined,
            width: w ? { size: Math.round(w * 50), type: D.WidthType.PERCENTAGE } : undefined,
            borders: th && ts === 'minimal' ? { bottom: { style: L, size: 12, color: '1C2230' } } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 }
          });
        })
      });
    });
    const wrap = tbl.dataset.wrap;
    return new D.Table({
      rows, borders,
      ...(wrap ? { float: { horizontalAnchor: D.TableAnchorType.MARGIN, relativeHorizontalPosition: wrap === 'right' ? D.RelativeHorizontalPosition.RIGHT : D.RelativeHorizontalPosition.LEFT, verticalAnchor: D.TableAnchorType.TEXT, leftFromText: wrap === 'right' ? 280 : 0, rightFromText: wrap === 'left' ? 280 : 0, bottomFromText: 160 } } : {}),
      width: fit || wrap ? { size: 0, type: D.WidthType.AUTO } : { size: 100, type: D.WidthType.PERCENTAGE },
      layout: fit || wrap ? D.TableLayoutType.AUTOFIT : D.TableLayoutType.FIXED,
      columnWidths: pct ? pct.map(x => Math.round(x / 100 * contentTw)) : Array(cols).fill(Math.round(contentTw / cols))
    });
  }
  function blocks(container, fmt = {}, extra = {}, nodeList = null) {
    const out = []; let inlineBuf = [];
    const flush = () => {
      if (!inlineBuf.length) return;
      const span = document.createElement('span'); inlineBuf.forEach(n => span.appendChild(n.cloneNode(true)));
      if (span.textContent.trim() || span.querySelector('img, br')) out.push(new D.Paragraph({ ...extra, children: inlines(span, fmt, []) }));
      inlineBuf = [];
    };
    for (const n of nodeList || container.childNodes) {
      if (n.nodeType === 1 && n.classList.contains('pg-gap')) continue;
      if (!isBlock(n)) { if (n.nodeType === 3 && !n.data.trim() && !inlineBuf.length) continue; inlineBuf.push(n); continue; }
      flush();
      const t = n.tagName;
      if (t === 'DIV' && n.classList.contains('cols')) { out.push(...blocks(n, fmt, extra)); continue; }
      if (t === 'DIV' && n.classList.contains('page-break')) { out.push(new D.Paragraph({ children: [new D.PageBreak()] })); continue; }
      if (t === 'DIV' && n.classList.contains('toc')) {
        for (const c of n.children) out.push(new D.Paragraph({ children: [new D.TextRun({ text: c.textContent, bold: c.classList.contains('toc-title') })], indent: c.classList.contains('l2') ? { left: 280 } : c.classList.contains('l3') ? { left: 560 } : undefined }));
        continue;
      }
      if (t === 'HR') { out.push(new D.Paragraph({ border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: 'B9BFC9', space: 1 } }, children: [] })); continue; }
      if (t === 'UL' || t === 'OL') { list(n, 0, out); continue; }
      if (t === 'TABLE') { out.push(table(n)); out.push(new D.Paragraph({ children: [], spacing: { after: 80 } })); continue; }
      if (t === 'BLOCKQUOTE') { if ([...n.children].some(isBlock)) out.push(...blocks(n, { ...fmt }, { style: 'Quote' })); else out.push(para(n, { style: 'Quote' }, fmt)); continue; }
      if (/^H[1-6]$/.test(t)) { out.push(para(n, { ...extra, heading: D.HeadingLevel['HEADING_' + t[1]] }, fmt)); continue; }
      if (t === 'P' && n.classList.contains('title')) { out.push(para(n, { heading: D.HeadingLevel.TITLE }, fmt)); continue; }
      if (t === 'P' && n.classList.contains('subtitle')) { out.push(para(n, { style: 'Subtitle' }, fmt)); continue; }
      if (t === 'PRE') { out.push(para(n, { style: 'Code' }, fmt)); continue; }
      if (t === 'P') { out.push(para(n, extra, fmt)); continue; }
      if ([...n.childNodes].some(isBlock)) out.push(...blocks(n, fmt, extra)); else out.push(para(n, extra, fmt));
    }
    flush();
    return out;
  }
  const hfParas = text => text.split('\n').map(line => new D.Paragraph({
    alignment: D.AlignmentType.CENTER,
    children: line.split(/(\{page\}|\{pages\}|\{title\}|\{date\})/).filter(Boolean).map(p =>
      p === '{page}' ? new D.TextRun({ children: [D.PageNumber.CURRENT], size: 18, color: '6B7280' })
        : p === '{pages}' ? new D.TextRun({ children: [D.PageNumber.TOTAL_PAGES], size: 18, color: '6B7280' })
          : new D.TextRun({ text: p === '{title}' ? d.title : p === '{date}' ? fmtDate() : p, size: 18, color: '6B7280' }))
  }));

  const secs = []; let run = [];
  const flushRun = () => { if (run.length) { const k = blocks(root, {}, {}, run); if (k.length) secs.push({ kids: k, cols: 1 }); run = []; } };
  for (const n of [...root.childNodes]) {
    if (n.nodeType === 1 && n.classList.contains('cols')) { flushRun(); const k = blocks(n); if (k.length) secs.push({ kids: k, cols: clamp(+n.dataset.cols || 2, 1, 6), gap: lenToTwip(n.style.columnGap || '0.4in') }); }
    else run.push(n);
  }
  flushRun();
  if (!secs.length) secs.push({ kids: [new D.Paragraph('')], cols: 1 });
  const [pw, ph] = portraitDims(d); const m = d.page.margins;
  const hdrText = d === cur ? hdr.innerText.trim() : d.header; const ftrText = d === cur ? ftr.innerText.trim() : d.footer;
  const docx = new D.Document({
    creator: me(), title: d.title, description: 'Created with Lekh',
    features: { trackRevisions: !!d.track },
    styles: (() => {
      const st = fullStyles(d); const fam = f => { const x = (f || st.normal.font).split(',')[0].replace(/["']/g, '').trim(); return x === 'Carlito' ? 'Calibri' : x === 'EB Garamond' ? 'Garamond' : x; };
      const hex = c => (toHex(c) || '000000');
      const run = (v, extra = {}) => ({ font: fam(v.font), size: Math.round(v.size * 2), color: hex(v.color), bold: !!v.bold, italics: !!v.italic, ...extra });
      const para = v => ({ spacing: { before: Math.round(v.before * 20), after: Math.round(v.after * 20) } });
      return {
        default: {
          document: { run: run(st.normal), paragraph: { spacing: { after: Math.round(st.normal.after * 20), before: Math.round(st.normal.before * 20), line: Math.round(240 * st.normal.line / 1.2) } } },
          title: { run: run(st.title, d.styles?.title?.font ? {} : { font: fam(st.normal.font) === 'Calibri' ? 'Calibri Light' : fam(st.normal.font) }), paragraph: para(st.title) },
          heading1: { run: run(st.h1), paragraph: para(st.h1) }, heading2: { run: run(st.h2), paragraph: para(st.h2) },
          heading3: { run: run(st.h3), paragraph: para(st.h3) }, heading4: { run: run(st.h4), paragraph: para(st.h4) },
          hyperlink: { run: { color: '1D5BBF', underline: { type: D.UnderlineType.SINGLE } } }
        },
        paragraphStyles: [
          { id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal', next: 'Normal', run: run(st.subtitle), paragraph: para(st.subtitle) },
          { id: 'Quote', name: 'Quote', basedOn: 'Normal', next: 'Normal', run: run(st.quote), paragraph: { ...para(st.quote), indent: { left: 360 }, border: { left: { style: D.BorderStyle.SINGLE, size: 12, color: 'C5CBD6', space: 8 } } } },
          { id: 'Code', name: 'Code', basedOn: 'Normal', run: { font: 'Consolas', size: 20 }, paragraph: { shading: { type: D.ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } } }
        ]
      };
    })(),
    numbering: { config: [{ reference: 'ol', levels: [0, 1, 2, 3, 4, 5].map(i => ({ level: i, format: [D.LevelFormat.DECIMAL, D.LevelFormat.LOWER_LETTER, D.LevelFormat.LOWER_ROMAN][i % 3], text: `%${i + 1}.`, alignment: D.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } } })) }] },
    footnotes: st.footnotes,
    sections: secs.map((sec, i) => ({
      properties: {
        ...(i ? { type: D.SectionType.CONTINUOUS } : {}),
        ...(d.page.valign === 'center' || d.page.valign === 'bottom' ? { verticalAlign: d.page.valign === 'center' ? D.VerticalAlign.CENTER : D.VerticalAlign.BOTTOM } : {}),
        ...(sec.cols > 1 ? { column: { count: sec.cols, space: sec.gap || 576, equalWidth: true } } : {}),
        page: { size: { width: twip(pw), height: twip(ph), orientation: d.page.orient === 'landscape' ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT }, margin: { top: twip(m.t), right: twip(m.r), bottom: twip(m.b), left: twip(m.l), header: twip(Math.min(0.5, m.t / 2)), footer: twip(Math.min(0.5, m.b / 2)) } }
      },
      headers: i === 0 && hdrText ? { default: new D.Header({ children: hfParas(hdrText) }) } : undefined,
      footers: i === 0 && ftrText ? { default: new D.Footer({ children: hfParas(ftrText) }) } : undefined,
      children: sec.kids
    }))
  });
  return D.Packer.toBlob(docx);
}
function mergeTCIn(root) {
  if (root === editor) { mergeTC(); return; }
  $$('ins.tc, del.tc', root).forEach(el => { let n = el.nextSibling; while (n && n.nodeType === 1 && n.tagName === el.tagName && n.classList.contains('tc') && n.dataset.a === el.dataset.a) { const nx = n.nextSibling; while (n.firstChild) el.appendChild(n.firstChild); n.remove(); n = nx; } });
}

/* ================================================================= dialogs */
async function settingsDialog() {
  let est = '';
  try { const e = await navigator.storage.estimate(); est = `${(e.usage / 1048576).toFixed(1)} MB used on this device`; } catch {}
  const r = await promptDialog('Settings', [
    { name: 'author', label: 'Your name (for comments and tracked changes)', value: settings.author },
    { name: 'units', label: 'Ruler units', type: 'select', value: settings.units || 'in', options: [['in', 'Inches'], ['cm', 'Centimetres']] }
  ], 'Save', est ? `<div class="notice">${esc(est)}. Documents are stored in this browser${Sync.enabled() ? ' and backed up to your GitHub Gist' : ' only — set up Sync or download a backup now and then'}.</div>` : '');
  if (r) { settings.author = r.author.trim() || 'Me'; settings.units = r.units; saveSettings(); Ruler.render(); Pager.sig = ''; Pager.run(); toast('Settings saved'); }
}
function showShortcuts() {
  const k = isMac ? '⌘' : 'Ctrl';
  const rows = [
    ['Bold / Italic / Underline', `${k}+B / I / U`], ['Undo / Redo', `${k}+Z / ${k}+Y`], ['Save now & sync', `${k}+S`], ['Save a named version', `${k}+Shift+S`],
    ['Find / Replace', `${k}+F / ${k}+H`], ['Insert link', `${k}+K`], ['Page break', `${k}+Enter`], ['Heading 1–4 / Normal', `${k}+Alt+1…4 / 0`],
    ['Bullets / Numbering / Checklist', `${k}+Shift+8 / 7 / 9`], ['Align left / centre / right / justify', `${k}+Shift+L / E / R / J`],
    ['Comment', `${k}+Alt+M`], ['Footnote', `${k}+Alt+F`], ['Format painter', 'Paintbrush button (double-click to keep on)'], ['Browser spelling menu', 'Shift + right-click'], ['Track changes on/off', `${k}+Shift+X`], ['Paste as plain text', `${k}+Shift+V`], ['Clear formatting', `${k}+\\`],
    ['Indent in lists / next table cell', 'Tab'], ['New document', 'Alt+N'], ['Documents sidebar', `${k}+Shift+O`], ['Print / PDF', `${k}+P`]
  ];
  modal({ title: 'Keyboard shortcuts', body: `<table style="width:100%;border-collapse:collapse">${rows.map(([a, b]) => `<tr><td style="padding:5px 0">${a}</td><td style="text-align:right"><code>${esc(b)}</code></td></tr>`).join('')}</table>`, buttons: [{ label: 'Close', primary: true }] });
}

/* ==================================================================== SYNC */
const Sync = {
  running: false, again: false, timer: null, error: null,
  token() { try { return localStorage.getItem('lekh.token') || ''; } catch { return ''; } },
  enabled() { return !!(this.token() && settings.gistId); },
  get etag() { try { return localStorage.getItem('lekh.etag.' + settings.gistId) || ''; } catch { return ''; } },
  set etag(v) { try { v ? localStorage.setItem('lekh.etag.' + settings.gistId, v) : localStorage.removeItem('lekh.etag.' + settings.gistId); } catch {} },
  async api(path, opts = {}) {
    const res = await fetch('https://api.github.com' + path, {
      ...opts, cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + this.token(), 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) }
    });
    return res;
  },
  schedule(ms = 4000) { if (!this.enabled()) { this.pill(); return; } clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), ms); this.pill(); },
  pill() {
    const p = $('#syncPill'); if (!p) return;
    let icon = 'cloud-off', text = 'Local only', cls = '';
    if (this.enabled()) {
      const unsynced = [...docs.values()].some(d => d.dirty || d.vDirty) || pendingSave;
      if (!navigator.onLine) { icon = 'cloud-off'; text = 'Offline'; }
      else if (Vault.locked()) { icon = 'lock'; text = 'Locked — enter passphrase'; cls = 'err'; }
      else if (this.running) { icon = 'refresh-cw'; text = 'Syncing…'; cls = 'busy'; }
      else if (this.error) { icon = 'cloud-off'; text = 'Sync error'; cls = 'err'; }
      else if (unsynced) { icon = 'cloud'; text = 'Waiting to sync'; }
      else { icon = 'cloud'; text = settings.lastSync ? 'Synced ' + timeAgo(settings.lastSync) : 'Synced'; cls = 'ok'; }
    }
    const key = icon + text + cls; if (p.dataset.k === key) return; p.dataset.k = key;
    p.className = 'pill ' + cls; p.title = this.error ? 'Sync error: ' + this.error : 'Sync status — click for sync settings';
    p.innerHTML = `<i data-lucide="${icon}"></i><span>${esc(text)}</span>`; icons();
  },
  async run(force = false) {
    if (!this.enabled() || !navigator.onLine || !DB.db) { this.pill(); return; }
    if (this.running) { this.again = true; return; }
    this.running = true; this.pill();
    try {
      if (navigator.locks) await navigator.locks.request('lekh-sync', () => this._run(force));
      else await this._run(force);
      this.error = null; settings.lastSync = Date.now(); saveSettings();
    } catch (e) { this.error = e.message || String(e); console.warn('[sync]', e); }
    finally {
      this.running = false; this.pill(); renderDocList();
      if (this.again) { this.again = false; this.schedule(800); }
    }
  },
  async _run(force) {
    if (pendingSave) await saveNow();
    await loadAll();
    const headers = {}; const et = this.etag; if (et && !force) headers['If-None-Match'] = et;
    const r = await this.api('/gists/' + settings.gistId, { headers });
    if (r.status === 401) throw new Error('GitHub rejected the token (expired or revoked). Update it in Sync settings.');
    if (r.status === 404) { if (await this.relocate()) return this._run(true); throw new Error('The sync gist was not found. Reconnect in Sync settings.'); }
    if (r.status !== 304) {
      if (!r.ok) throw new Error('GitHub error ' + r.status);
      const g = await r.json();
      const kf = g.files && g.files['lekh-key.json'];
      let remote = null;
      if (kf) { let t = kf.content; if (kf.truncated || t == null) t = await (await fetch(kf.raw_url, { cache: 'no-store' })).text(); remote = safeJSON(t); }
      Vault.setRemote(remote);
      if (!remote && Vault.key) await Vault.clear();
      if (Vault.locked()) { this.etag = ''; this.pill(); return; }
      await this.merge(g);
      this.etag = r.headers.get('ETag') || '';
    }
    if (Vault.locked()) return;
    await this.push();
  },
  async merge(g) {
    const files = g.files || {}; const seen = new Set(); const changed = new Set(); let conflicts = 0;
    const read = async f => {
      let t = f.content; if (f.truncated || t == null) { const rr = await fetch(f.raw_url, { cache: 'no-store' }); if (!rr.ok) throw new Error('Could not download ' + f.filename); t = await rr.text(); }
      let o = safeJSON(t);
      if (o && o.lekhEnc) { if (!Vault.key) throw new Error('Locked'); try { o = safeJSON(await Vault.open(Vault.key, o)); } catch { throw new Error('A synced file could not be decrypted with your passphrase.'); } }
      return o;
    };
    for (const [name, f] of Object.entries(files)) {
      if (!/^lekh-[^.]+\.json$/.test(name) || name === 'lekh-key.json') continue;
      const rd = await read(f); if (!rd || !rd.id) continue;
      seen.add(rd.id);
      const ld = (await DB.get(rd.id)) || null;
      const remote = normalizeDoc({ ...rd, versions: ld ? ld.versions : [] });
      if (!ld) { if (rd.purged) continue; Object.assign(remote, { dirty: false, base: rd.ver, vDirty: false }); await DB.put(remote); changed.add(rd.id); continue; }
      normalizeDoc(ld);
      if (ld.base === rd.ver) continue;
      if (ld.ver === rd.ver) { ld.base = rd.ver; ld.dirty = false; await DB.put(ld); continue; }
      if (!ld.dirty) {
        Object.assign(remote, { dirty: false, base: rd.ver, vDirty: ld.vDirty, vSynced: ld.vSynced });
        if (rd.purged) { await DB.del(rd.id); changed.add(rd.id); continue; }
        await DB.put(remote); changed.add(rd.id);
      } else {
        conflicts++;
        ld.versions.unshift({ id: uid('v'), time: Date.now(), name: 'From another device (edited at the same time)', html: rd.html, header: rd.header, footer: rd.footer, auto: false, author: 'sync' });
        ld.vDirty = true;
        const ids = new Set(ld.comments.map(c => c.id)); (rd.comments || []).forEach(c => { if (!ids.has(c.id)) ld.comments.push(c); });
        ld.base = rd.ver; ld.dirty = true; await DB.put(ld); changed.add(ld.id);
      }
    }
    for (const [name, f] of Object.entries(files)) {
      const m = /^lekh-([^.]+)\.v\.json$/.exec(name); if (!m) continue;
      const ld = await DB.get(m[1]); if (!ld) continue;
      const rv = (await read(f))?.versions || [];
      const map = new Map(rv.map(v => [v.id, v])); const localOnly = (ld.versions || []).some(v => !map.has(v.id));
      (ld.versions || []).forEach(v => map.set(v.id, v));
      const merged = [...map.values()].sort((a, b) => b.time - a.time);
      const before = JSON.stringify((ld.versions || []).map(v => v.id));
      ld.versions = merged; ld.vSynced = true; ld.vDirty = ld.vDirty || localOnly;
      if (JSON.stringify(merged.map(v => v.id)) !== before) changed.add(ld.id);
      await DB.put(ld);
    }
    for (const d of await DB.all()) {
      if (d.base && !seen.has(d.id) && !d.dirty) { await DB.del(d.id); changed.add(d.id); }
      else if (d.welcome && d.pristine && !d.base && seen.size) { await DB.del(d.id); changed.add(d.id); }   // fresh device: drop its untouched welcome doc
    }
    if (!changed.size) return;
    await loadAll();
    post({ type: 'reload' });
    if (cur && changed.has(cur.id)) {
      const fresh = docs.get(cur.id);
      if (!fresh) { const next = liveDocs()[0]; next ? openDoc(next.id) : createDoc(LEKH_TEMPLATES[0]); }
      else if (pendingSave) { cur = fresh; }
      else { cur = fresh; renderCurrent({ keepScroll: true }); }
    } else if (cur) cur = docs.get(cur.id) || cur;
    renderDocList();
    if (conflicts) toast(`${conflicts} document(s) were edited on two devices at once. Your version is kept; the other is in Version history.`, { ms: 8000 });
  },
  async push() {
    const all = await DB.all();
    const files = {}; const snap = [];
    const pack = async obj => { const t = JSON.stringify(obj); return Vault.on() ? Vault.seal(Vault.key, t) : t; };
    if (Vault.on() && !Vault.key) return;
    for (const d of all) {
      const name = `lekh-${d.id}.json`, vname = `lekh-${d.id}.v.json`;
      if (d.purged) { if (d.base) files[name] = null; if (d.vSynced) files[vname] = null; snap.push([d.id, 'purge']); continue; }
      if (d.dirty) { const out = { ...d }; ['dirty', 'base', 'vDirty', 'vSynced', 'versions'].forEach(k => delete out[k]); files[name] = { content: await pack(out) }; snap.push([d.id, d.ver, 'doc']); }
      if (d.vDirty && (d.versions || []).length) { files[vname] = { content: await pack({ id: d.id, versions: d.versions }) }; snap.push([d.id, d.versions.length, 'v']); }
      else if (d.vDirty) snap.push([d.id, 0, 'v']);
    }
    const names = Object.keys(files); if (!names.length && !snap.length) return;
    let batch = {}, size = 0;
    const send = async () => {
      if (!Object.keys(batch).length) return;
      const r = await this.api('/gists/' + settings.gistId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: batch }) });
      if (!r.ok) { let msg = ''; try { msg = (await r.json()).message || ''; } catch {} throw new Error(`Upload failed (${r.status}${msg ? ': ' + msg : ''})`); }
      batch = {}; size = 0;
    };
    for (const n of names) {
      const len = files[n] ? files[n].content.length : 10;
      if (size + len > 5e6) await send();
      batch[n] = files[n]; size += len;
    }
    await send();
    for (const [id, v, kind] of snap) {
      const fresh = await DB.get(id); if (!fresh) continue;
      if (v === 'purge') { await DB.del(id); docs.delete(id); continue; }
      if (kind === 'doc') { if (fresh.ver === v) fresh.dirty = false; fresh.base = v; }
      if (kind === 'v') { if ((fresh.versions || []).length === v) fresh.vDirty = false; if (v) fresh.vSynced = true; }
      await DB.put(fresh);
      if (docs.has(id)) { const m = docs.get(id); m.dirty = fresh.dirty; m.base = fresh.base; m.vDirty = fresh.vDirty; m.vSynced = fresh.vSynced; }
    }
    post({ type: 'synced' });
  },
  async connect(token) {
    try { localStorage.setItem('lekh.token', token.trim()); } catch {}
    const u = await this.api('/user');
    if (u.status === 401) throw new Error('GitHub rejected this token. Copy it again and make sure it hasn’t expired.');
    if (!u.ok) throw new Error('GitHub error ' + u.status);
    const user = await u.json();
    let found = await this.findGist();
    if (!found) {
      const r = await this.api('/gists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: GIST_DESC, public: false, files: { 'lekh-readme.md': { content: '# Lekh sync\n\nThis secret gist stores documents written in Lekh. Each document is one JSON file. Editing these files by hand can break sync.\n' } } }) });
      if (!r.ok) throw new Error('Could not create the sync gist (' + r.status + '). The token needs permission to write gists.');
      found = await r.json();
    }
    settings.gistId = found.id; settings.login = user.login; saveSettings();
    this.etag = ''; await Vault.load();
    for (const d of await DB.all()) { if (!d.base) { d.dirty = true; d.vDirty = true; await DB.put(d); } }
    await loadAll();
    return { login: user.login, created: !found.files || Object.keys(found.files).length <= 1 };
  },
  async findGist() {
    const hits = [];
    for (let p = 1; p <= 10; p++) {
      const r = await this.api(`/gists?per_page=100&page=${p}`);
      if (r.status === 403 || r.status === 404) throw new Error('This token can’t read your gists. Give it the “gist” scope (classic) or “Gists: Read and write” (fine-grained).');
      if (!r.ok) throw new Error('GitHub error ' + r.status);
      const list = await r.json(); hits.push(...list.filter(g => g.description === GIST_DESC));
      if (list.length < 100) break;
    }
    return hits.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0] || null;
  },
  async relocate() {                       // the gist was replaced (e.g. encryption turned on from another device)
    const g = await this.findGist(); if (!g || g.id === settings.gistId) return false;
    settings.gistId = g.id; saveSettings(); this.etag = ''; await Vault.load(); return true;
  },
  async migrate(pass) {                    // move everything into a fresh gist (no plain-text history left behind)
    await this.run(true);
    if (this.error) throw new Error(this.error);
    if (Vault.locked()) throw new Error('Unlock with your current passphrase first.');
    let key = null, salt = null, keyFile = null;
    if (pass) {
      salt = Vault.b64(crypto.getRandomValues(new Uint8Array(16))); key = await Vault.derive(pass, salt);
      keyFile = { v: 1, kdf: 'PBKDF2-SHA256', iterations: 310000, cipher: 'AES-256-GCM', salt, check: JSON.parse(await Vault.seal(key, 'lekh-ok')) };
    }
    const files = { 'lekh-readme.md': { content: '# Lekh sync\n\nThis secret gist stores documents written in Lekh.' + (pass ? ' They are encrypted with a passphrase only you know.' : '') + '\n' } };
    if (keyFile) files['lekh-key.json'] = { content: JSON.stringify(keyFile) };
    const r = await this.api('/gists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: GIST_DESC, public: false, files }) });
    if (!r.ok) throw new Error('Could not create a new gist (' + r.status + ')');
    const g = await r.json(); const oldId = settings.gistId;
    settings.gistId = g.id; saveSettings(); this.etag = '';
    Vault.setRemote(keyFile); if (key) await Vault.store(key, salt); else await Vault.clear();
    for (const d of await DB.all()) { if (d.purged) { await DB.del(d.id); continue; } d.dirty = true; d.vDirty = true; d.base = null; d.vSynced = false; await DB.put(d); }
    await loadAll();
    await this.run(true); if (this.error) throw new Error(this.error);
    const del = await this.api('/gists/' + oldId, { method: 'DELETE' });
    return del.ok || del.status === 404;
  },
  disconnect() { Vault.clear(); try { localStorage.removeItem('lekh.token'); } catch {} this.etag = ''; settings.gistId = ''; settings.login = ''; saveSettings(); this.error = null; this.pill(); }
};

async function syncDialog() {
  const connected = Sync.enabled();
  const tokenUrl = 'https://github.com/settings/tokens/new?scopes=gist&description=Lekh%20sync';
  const body = document.createElement('div');
  body.innerHTML = connected ? `
    <div class="notice">Connected to GitHub as <b>${esc(settings.login || '…')}</b>. Documents sync to a <a href="https://gist.github.com/${esc(settings.gistId)}" target="_blank" rel="noopener">secret gist</a> every few seconds after you stop typing, and whenever you come back to this tab.</div>
    <div class="field"><label>Last sync</label><div>${settings.lastSync ? fmtTime(settings.lastSync) : 'Not yet'}</div></div>
    ${Sync.error ? `<div class="notice warn"><b>Last error:</b> ${esc(Sync.error)}</div>` : ''}
    <div class="field"><label>Encryption</label><div>${Vault.on() ? (Vault.locked() ? '🔒 On — <b>locked on this device</b>' : '🔒 On — documents are encrypted before upload') : '<span style="color:var(--danger)">Off</span> — anyone with the gist link can read your documents'}</div>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">${Vault.on() ? (Vault.locked() ? '<button class="btn small primary" data-enc="unlock">Unlock…</button>' : '<button class="btn small outline" data-enc="change">Change passphrase…</button><button class="btn small outline danger" data-enc="off">Turn off</button>') : '<button class="btn small primary" data-enc="on">Turn on encryption…</button>'}</div></div>
    <div class="hint">To use another device: open this same site there, choose Sync, and paste the same token (or a new one). Lekh finds the existing gist automatically${Vault.on() ? ' and asks for your passphrase' : ''}.</div>`
    : `
    <div class="notice warn"><b>Before you connect:</b> a secret gist is unlisted, not encrypted. Anyone who gets its link can read it, and the token is stored in this browser. Don’t sync anything you couldn’t afford to leak, and only use Lekh on devices you trust.</div>
    <ol class="hint" style="padding-left:18px;margin:0 0 12px">
      <li><a href="${tokenUrl}" target="_blank" rel="noopener">Create a GitHub token</a> with only the <code>gist</code> scope. Pick an expiry you’re comfortable with.</li>
      <li>Copy the token and paste it below.</li>
      <li>Do the same on your other devices — they’ll find the same gist.</li></ol>
    <div class="field"><label for="tok">GitHub token</label><input id="tok" type="password" placeholder="ghp_… or github_pat_…" autocomplete="off"></div>
    <div class="hint" id="tokMsg"></div>`;
  const buttons = connected ? [
    { label: 'Disconnect', danger: true, onClick: async () => { if (await confirmDialog('Disconnect sync?', 'Your documents stay on this device and in the gist. This device just stops syncing.', 'Disconnect', true)) { Sync.disconnect(); toast('Sync disconnected'); } return true; }, value: null },
    { label: 'Sync now', primary: true, onClick: () => { Sync.run(true); toast('Syncing…'); }, value: null }
  ] : [
    { label: 'Cancel', value: null },
    { label: 'Connect', primary: true, onClick: async m => {
      const t = $('#tok', m).value.trim(); const msg = $('#tokMsg', m);
      if (!t) { msg.textContent = 'Paste a token first.'; return false; }
      msg.textContent = 'Connecting…';
      try { const r = await Sync.connect(t); toast(`Connected as ${r.login}. Syncing…`); Sync.run(true).then(() => { if (Vault.locked()) unlockDialog(); }); return true; }
      catch (e) { Sync.disconnect(); msg.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; return false; }
    }, value: null }
  ];
  body.addEventListener('click', async e => {
    const b = e.target.closest('[data-enc]'); if (!b) return;
    const a = b.dataset.enc; closeModal(null);
    if (a === 'unlock') { await unlockDialog(); return; }
    if (a === 'off') { if (await confirmDialog('Turn off encryption?', 'Your documents will be re-uploaded to a new gist without encryption, and the encrypted gist will be deleted. Other devices will pick up the change automatically.', 'Turn off', true)) migrateVault(null); return; }
    const pass = await passphraseDialog(a === 'change' ? 'New passphrase' : 'Turn on encryption'); if (!pass) return;
    if (a === 'on' && !await confirmDialog('Encrypt your synced documents?', 'Lekh will upload everything to a fresh gist, encrypted with your passphrase, and delete the old unencrypted gist (so no readable copy or history is left). Your other devices will ask for the passphrase once.', 'Encrypt')) return;
    migrateVault(pass);
  });
  modal({ title: 'Sync across devices', body, buttons });
}

/* ============================================================ cross-tab */
if (bc) bc.onmessage = async ({ data }) => {
  if (!data || data.tab === TAB_ID) return;
  if (data.type === 'saved' && data.id) {
    const d = await DB.get(data.id); if (!d) return;
    normalizeDoc(d); docs.set(d.id, d);
    if (cur && cur.id === d.id) {
      if (pendingSave) { cur.base = d.base; }
      else { cur = d; renderCurrent({ keepScroll: true }); }
    }
    renderDocList(); Sync.pill();
  } else if (data.type === 'reload' || data.type === 'synced') {
    const pend = pendingSave; await loadAll();
    if (cur && !pend && data.type === 'reload') renderCurrent({ keepScroll: true });
    renderDocList(); Sync.pill();
  }
};

/* ================================================================== boot */
async function boot() {
  icons(); buildSelects(); setTheme(settings.theme); applySpell();
  $('#btnPages').classList.toggle('on', settings.pageView !== 'continuous');
  try { document.execCommand('styleWithCSS', false, true); document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
  try { await DB.open(); } catch (e) {
    modal({ title: 'Storage unavailable', body: '<p>This browser blocked local storage (private mode?). Lekh needs it to save documents.</p>', buttons: [{ label: 'OK', primary: true }] });
    return;
  }
  navigator.storage?.persist?.().catch(() => {});
  await Vault.load();
  await loadAll();
  if (!liveDocs().length && ![...docs.values()].some(d => d.deleted)) {
    const w = makeDoc({ title: 'Welcome to Lekh', html: WELCOME, footer: 'Page {page} of {pages}' }); w.welcome = true; w.pristine = true;
    docs.set(w.id, w); await DB.put(w);
  }
  const fromHash = (location.hash.match(/doc=([\w-]+)/) || [])[1];
  let last = null; try { last = localStorage.getItem('lekh.lastDoc'); } catch {}
  const pick = [fromHash, last].find(id => id && docs.get(id) && !docs.get(id).deleted && !docs.get(id).purged) || liveDocs().sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
  if (pick) await openDoc(pick); else await createDoc(LEKH_TEMPLATES[0]);
  if (innerWidth < 860) { $('#sidebar').classList.add('closed'); zoomFit(); }
  Sync.pill(); Sync.run();
  setInterval(() => { if (document.visibilityState === 'visible') Sync.run(); else Sync.pill(); }, 45000);
  window.addEventListener('focus', () => Sync.run());
  window.addEventListener('online', () => Sync.run());
  window.addEventListener('offline', () => Sync.pill());
  window.addEventListener('hashchange', () => { const id = (location.hash.match(/doc=([\w-]+)/) || [])[1]; if (id && docs.get(id) && (!cur || id !== cur.id)) openDoc(id); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && pendingSave) saveNow(); });
  window.addEventListener('beforeunload', e => { if (pendingSave) { saveNow(); e.preventDefault(); } });
  $('#btnSidebar').addEventListener('click', () => $('#sidebar').classList.toggle('closed'));
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

const WELCOME = `
<p class="title">Welcome to Lekh</p>
<p class="subtitle">A word processor that lives in your browser and syncs through your own GitHub account.</p>
<div class="toc" contenteditable="false"></div>
<h1>Getting started</h1>
<p>Everything you type saves automatically on this device. Open the <b>Documents</b> panel (top-left) to switch between documents, or press <b>Alt+N</b> to start a new one from a template.</p>
<ul class="checklist">
<li data-checked="false">Click <b>Sync</b> in the top bar and connect a GitHub token to use your documents on other devices.</li>
<li data-checked="false">Set your name in <b>File → Settings</b> so comments and tracked changes show who made them.</li>
<li data-checked="false">Try <b>File → Download as → Word</b> to see the .docx export.</li>
</ul>
<h1>What you can do</h1>
<h2>Write and format</h2>
<p>Fonts, sizes, <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, <span style="color:#c62828">colour</span>, <span style="background-color:#ffeb3b">highlight</span>, styles, lists, checklists, line spacing, indents and alignment are all on the <b>Home</b> tab.</p>
<h2>Insert</h2>
<p>Tables (with row and column tools), images (paste, drop or upload), links, page breaks, symbols, dates, footnotes (<b>Ctrl+Alt+F</b>) and a table of contents that builds itself from your headings. <b>Layout → Columns</b> sets two or three columns.</p>
<h2>Mail merge</h2>
<p>On the <b>Mailings</b> tab, paste or import a list (CSV), insert merge fields like «Name», preview each letter, then merge to a new document, a single Word file, or one Word file per person.</p>
<h2>Review</h2>
<p>Turn on <b>Track changes</b> to mark every insertion and deletion, then accept or reject them one by one. Select text and press <b>Ctrl+Alt+M</b> to comment. <b>Version history</b> keeps automatic snapshots plus versions you save by name.</p>
<h2>Layout and printing</h2>
<p>Choose A4, Letter, Legal or A5, portrait or landscape, and margins. The header and footer sit in the page margins; type <code>{page}</code>, <code>{pages}</code>, <code>{title}</code> or <code>{date}</code> to insert fields. Use <b>Print</b> and choose <i>Save as PDF</i> for a PDF.</p>
<table><tbody><tr><th>Shortcut</th><th>Does</th></tr><tr><td>Ctrl+S</td><td>Save now and sync</td></tr><tr><td>Ctrl+Shift+S</td><td>Save a named version</td></tr><tr><td>Ctrl+F / Ctrl+H</td><td>Find / replace</td></tr><tr><td>Ctrl+Enter</td><td>Page break</td></tr></tbody></table>
<p>See <b>File → Keyboard shortcuts</b> for the full list. You can delete this document whenever you like.</p>`;

window.LekhDebug = { relayout: () => { const t = performance.now(); Pager.run(); return performance.now() - t; } };
boot();
})();
