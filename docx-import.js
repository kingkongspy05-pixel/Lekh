/* =====================================================================
   Lekh — Word (.docx) importer
   Reads the document XML directly so fonts, sizes, colours, highlights,
   alignment, lists, tables, images, links, tracked changes, comments,
   footnotes, headers/footers, page setup and columns come across.
   Exposes window.LekhDocx.convert(arrayBuffer) → { title, html, header,
   footer, page, comments }. Needs JSZip.
   ===================================================================== */
(() => {
'use strict';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kids = (el, name) => el ? [...el.childNodes].filter(n => n.nodeType === 1 && (!name || n.localName === name)) : [];
const kid = (el, name) => el ? [...el.childNodes].find(n => n.nodeType === 1 && n.localName === name) || null : null;
const desc = (el, name) => el ? [...el.getElementsByTagNameNS('*', name)] : [];
const at = (el, name) => {
  if (!el) return null;
  let v = el.getAttributeNS(W, name);
  if (v == null || v === '') v = el.getAttribute('w:' + name);
  return v == null || v === '' ? null : v;
};
const rid = (el, name = 'id') => el ? (el.getAttributeNS(R, name) || el.getAttribute('r:' + name) || null) : null;
const onOff = el => { if (!el) return undefined; const v = at(el, 'val'); return !(v === '0' || v === 'false' || v === 'off' || v === 'none'); };
const HL = { yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', magenta: 'FF00FF', blue: '0000FF', red: 'FF0000', darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000', darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0', black: '000000', white: 'FFFFFF' };
const SERIF = /times|georgia|cambria|garamond|palatino|book antiqua|baskerville|bodoni|century|constantia|didot|minion|serif|mangal|kokila|utsaah/i;
const MONO = /courier|consolas|mono|menlo|lucida console/i;
const BASE = {
  p: { font: 'Calibri', sz: 11, color: '000000' }, blockquote: { font: 'Calibri', sz: 11, color: '485160', i: true },
  h1: { font: 'Calibri', sz: 20, color: '1F3864', b: true }, h2: { font: 'Calibri', sz: 15, color: '2F5496', b: true },
  h3: { font: 'Calibri', sz: 12.5, color: '2F5496', b: true }, h4: { font: 'Calibri', sz: 11, color: '2F5496', b: true, i: true },
  title: { font: 'Calibri', sz: 28, color: '000000' }, subtitle: { font: 'Calibri', sz: 14, color: '5B6472' }
};
const SIZES = { A4: [8.27, 11.69], Letter: [8.5, 11], Legal: [8.5, 14], A5: [5.83, 8.27] };

function cssFont(f) {
  const clean = f.replace(/['";]/g, '');
  if (/^calibri$/i.test(clean)) return "Calibri, Carlito, sans-serif";
  if (/^aptos/i.test(clean)) return `'${clean}', Calibri, Carlito, sans-serif`;
  return `'${clean}', ${MONO.test(clean) ? 'monospace' : SERIF.test(clean) ? 'serif' : 'sans-serif'}`;
}

/* ---------------------------------------------------------------- parsing helpers */
function parseRPr(rPr, theme) {
  const o = {}; if (!rPr) return o;
  for (const c of kids(rPr)) {
    switch (c.localName) {
      case 'b': o.b = onOff(c); break;
      case 'i': o.i = onOff(c); break;
      case 'u': { const v = at(c, 'val'); o.u = !!v && v !== 'none'; break; }
      case 'strike': case 'dstrike': o.s = onOff(c); break;
      case 'vertAlign': { const v = at(c, 'val'); o.va = v === 'superscript' ? 'sup' : v === 'subscript' ? 'sub' : ''; break; }
      case 'sz': { const v = +at(c, 'val'); if (v) o.sz = v / 2; break; }
      case 'color': { const v = at(c, 'val'); if (v) o.color = v === 'auto' ? 'auto' : v.toUpperCase(); break; }
      case 'highlight': { const v = at(c, 'val'); o.hl = v && v !== 'none' ? (HL[v] || null) : null; break; }
      case 'shd': { const f = at(c, 'fill'); o.shd = f && f !== 'auto' && !/^F{6}$/i.test(f) ? f.toUpperCase() : null; break; }
      case 'rFonts': {
        const th = at(c, 'asciiTheme') || at(c, 'hAnsiTheme');
        const f = at(c, 'ascii') || at(c, 'hAnsi') || (th ? (/^major/.test(th) ? theme.major : theme.minor) : null) || at(c, 'cs');
        if (f) o.font = f; break;
      }
      case 'vanish': o.hidden = onOff(c); break;
      case 'caps': o.caps = onOff(c); break;
      case 'smallCaps': o.smallCaps = onOff(c); break;
      case 'rStyle': o.rStyle = at(c, 'val'); break;
    }
  }
  return o;
}
function parsePPr(pPr) {
  const o = {}; if (!pPr) return o;
  for (const c of kids(pPr)) {
    switch (c.localName) {
      case 'pStyle': o.style = at(c, 'val'); break;
      case 'jc': o.jc = at(c, 'val'); break;
      case 'ind': {
        const l = at(c, 'left') ?? at(c, 'start'); if (l != null) o.indL = +l;
        const f = at(c, 'firstLine'); if (f != null) o.indFirst = +f;
        const h = at(c, 'hanging'); if (h != null) o.indHang = +h; break;
      }
      case 'spacing': { const ln = at(c, 'line'); if (ln != null) { o.line = +ln; o.lineRule = at(c, 'lineRule') || 'auto'; } break; }
      case 'numPr': { const n = at(kid(c, 'numId'), 'val'); const l = at(kid(c, 'ilvl'), 'val'); if (n != null) o.numId = n; if (l != null) o.ilvl = +l; break; }
      case 'pageBreakBefore': o.pbb = onOff(c); break;
      case 'outlineLvl': o.outline = +at(c, 'val'); break;
      case 'sectPr': o.sectPr = c; break;
    }
  }
  return o;
}
function parseStyles(doc, theme) {
  const map = new Map(); let defR = {}, defP = {};
  if (doc) {
    const dd = desc(doc, 'docDefaults')[0];
    if (dd) { defR = parseRPr(desc(dd, 'rPr')[0], theme); defP = parsePPr(desc(dd, 'pPr')[0]); }
    for (const s of desc(doc, 'style')) {
      const id = at(s, 'styleId'); if (!id) continue;
      map.set(id, { id, type: at(s, 'type'), name: (at(kid(s, 'name'), 'val') || '').toLowerCase(), basedOn: at(kid(s, 'basedOn'), 'val'),
        rPr: parseRPr(kid(s, 'rPr'), theme), pPr: parsePPr(kid(s, 'pPr')), isDefault: at(s, 'default') === '1' || at(s, 'default') === 'true' });
    }
  }
  const chain = (id, key, seen = new Set()) => { const s = map.get(id); if (!s || seen.has(id)) return {}; seen.add(id); return { ...chain(s.basedOn, key, seen), ...s[key] }; };
  const defPara = [...map.values()].find(s => s.type === 'paragraph' && s.isDefault)?.id || 'Normal';
  return { map, defR, defP, chainR: id => chain(id, 'rPr'), chainP: id => chain(id, 'pPr'), defPara, name: id => map.get(id)?.name || '' };
}
function parseNumbering(doc) {
  const abs = new Map(), nums = new Map();
  if (doc) {
    for (const an of desc(doc, 'abstractNum')) {
      const lv = {};
      for (const l of kids(an, 'lvl')) lv[at(l, 'ilvl')] = { fmt: at(kid(l, 'numFmt'), 'val') || 'decimal', text: at(kid(l, 'lvlText'), 'val') || '', start: +(at(kid(l, 'start'), 'val') || 1) };
      abs.set(at(an, 'abstractNumId'), lv);
    }
    for (const n of kids(doc.documentElement, 'num')) nums.set(at(n, 'numId'), at(kid(n, 'abstractNumId'), 'val'));
  }
  return (numId, ilvl) => { const ab = abs.get(nums.get(String(numId))); return ab ? (ab[String(ilvl)] || ab['0'] || null) : null; };
}
function plainText(el) {
  let s = '';
  for (const n of desc(el, '*')) {
    if (n.localName === 't' || n.localName === 'delText') s += n.textContent;
    else if (n.localName === 'tab') s += ' ';
    else if (n.localName === 'br') s += '\n';
  }
  return s;
}
function paraTexts(el) { return kids(el, 'p').map(plainText).join('\n').trim(); }

/* ---------------------------------------------------------------- main */
async function convert(buf) {
  if (!window.JSZip) throw new Error('Zip library not loaded');
  const zip = await JSZip.loadAsync(buf);
  const xml = async p => { const f = zip.file(p); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null; };
  const relsOf = async part => {
    const m = new Map(); const dir = part.replace(/[^/]+$/, ''); const name = part.split('/').pop();
    const d = await xml(`${dir}_rels/${name}.rels`); if (!d) return m;
    for (const r of desc(d, 'Relationship')) {
      const target = r.getAttribute('Target') || ''; const ext = r.getAttribute('TargetMode') === 'External';
      m.set(r.getAttribute('Id'), { target, ext, path: ext ? null : resolvePath(dir, target), type: r.getAttribute('Type') || '' });
    }
    return m;
  };
  const resolvePath = (dir, target) => {
    if (target.startsWith('/')) return target.slice(1);
    const parts = (dir + target).split('/'); const out = [];
    for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
    return out.join('/');
  };

  // main part path from [Content_Types] / _rels/.rels
  let mainPath = 'word/document.xml';
  const root = await xml('_rels/.rels');
  if (root) { const r = desc(root, 'Relationship').find(x => /officeDocument$/.test(x.getAttribute('Type') || '')); if (r) mainPath = r.getAttribute('Target').replace(/^\//, ''); }
  const doc = await xml(mainPath); if (!doc) throw new Error('This file has no Word document inside.');
  const rels = await relsOf(mainPath);
  const findRel = re => [...rels.values()].find(r => re.test(r.type));
  const theme = { minor: 'Calibri', major: 'Calibri Light' };
  const themeRel = findRel(/\/theme$/);
  if (themeRel) {
    const t = await xml(themeRel.path);
    const latin = n => { const f = desc(t, n)[0]; const l = f && desc(f, 'latin')[0]; return l && l.getAttribute('typeface'); };
    if (t) { theme.minor = latin('minorFont') || theme.minor; theme.major = latin('majorFont') || theme.major; }
  }
  const stylesRel = findRel(/\/styles$/), numRel = findRel(/\/numbering$/), fnRel = findRel(/\/footnotes$/), enRel = findRel(/\/endnotes$/), cRel = findRel(/\/comments$/), cxRel = findRel(/commentsExtended$/);
  const styles = parseStyles(stylesRel ? await xml(stylesRel.path) : null, theme);
  const numbering = parseNumbering(numRel ? await xml(numRel.path) : null);

  // notes
  const notes = new Map();
  for (const [rel, tag, pre] of [[fnRel, 'footnote', 'f'], [enRel, 'endnote', 'e']]) {
    if (!rel) continue; const d = await xml(rel.path); if (!d) continue;
    for (const n of desc(d, tag)) { const ty = at(n, 'type'); if (ty && ty !== 'normal') continue; notes.set(pre + at(n, 'id'), paraTexts(n).replace(/\s+/g, ' ').trim()); }
  }
  // comments (+ replies / resolved from commentsExtended)
  const comments = new Map(); const byPara = new Map();
  if (cRel) {
    const d = await xml(cRel.path);
    for (const c of desc(d, 'comment')) {
      const id = at(c, 'id'); const ps = kids(c, 'p');
      const o = { srcId: id, id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), author: at(c, 'author') || 'Unknown', time: Date.parse(at(c, 'date') || '') || Date.now(), text: paraTexts(c), resolved: false, replies: [], parent: null };
      comments.set(id, o);
      const last = ps[ps.length - 1]; const pid = last && (last.getAttribute('w14:paraId') || last.getAttributeNS('http://schemas.microsoft.com/office/word/2010/wordml', 'paraId'));
      if (pid) byPara.set(pid, o);
    }
    if (cxRel) {
      const d2 = await xml(cxRel.path);
      for (const e of desc(d2, 'commentEx')) {
        const pid = e.getAttribute('w15:paraId'); const par = e.getAttribute('w15:paraIdParent'); const done = e.getAttribute('w15:done') === '1';
        const o = byPara.get(pid); if (!o) continue;
        if (done) o.resolved = true;
        if (par && byPara.get(par)) o.parent = byPara.get(par);
      }
    }
  }

  // media
  const media = new Map();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };
  const loadMedia = async relMap => {
    for (const [id, r] of relMap) {
      if (r.ext || !/\/image$/.test(r.type) || media.has(r.path)) continue;
      const ext = (r.path.split('.').pop() || '').toLowerCase(); const f = zip.file(r.path);
      if (!f || !mime[ext]) continue;
      media.set(r.path, `data:${mime[ext]};base64,${await f.async('base64')}`);
    }
  };
  await loadMedia(rels);

  // page setup from the final section
  const body = kid(doc.documentElement, 'body');
  const lastSect = kid(body, 'sectPr');
  const page = { size: 'A4', orient: 'portrait', margins: { t: 1, r: 1, b: 1, l: 1 } };
  let contentWidthPx = 6.27 * 96;
  if (lastSect) {
    const sz = kid(lastSect, 'pgSz'), mar = kid(lastSect, 'pgMar');
    if (sz) {
      let w = (+at(sz, 'w') || 11906) / 1440, h = (+at(sz, 'h') || 16838) / 1440;
      page.orient = at(sz, 'orient') === 'landscape' || w > h ? 'landscape' : 'portrait';
      const [pw, ph] = [Math.min(w, h), Math.max(w, h)];
      const hit = Object.entries(SIZES).find(([, [a, b]]) => Math.abs(a - pw) < 0.08 && Math.abs(b - ph) < 0.08);
      if (hit) page.size = hit[0]; else { page.size = 'Custom'; page.w = +pw.toFixed(2); page.h = +ph.toFixed(2); }
      contentWidthPx = w * 96;
    }
    if (mar) {
      const g = k => Math.max(0, Math.round(((+at(mar, k) || 0) / 1440) * 100) / 100);
      page.margins = { t: g('top') || 0.5, r: g('right'), b: g('bottom') || 0.5, l: g('left') };
      contentWidthPx -= (page.margins.l + page.margins.r) * 96;
    }
  }

  /* ---------- conversion context ---------- */
  const usedComments = new Set();
  const ctx = { fld: [], openC: [] };

  function fieldKind(instr) {
    const s = instr.trim(); const word = (s.split(/\s+/)[0] || '').toUpperCase();
    if (word === 'PAGE') return { emit: '{page}', skip: true };
    if (word === 'NUMPAGES' || word === 'SECTIONPAGES') return { emit: '{pages}', skip: true };
    if (word === 'MERGEFIELD') { const name = (s.match(/MERGEFIELD\s+"?([^"\\]+?)"?(\s|\\|$)/i) || [])[1]; if (name) return { emit: `<span class="mf" contenteditable="false" data-field="${esc(name.trim())}"></span>`, skip: true, html: true }; }
    if (word === 'HYPERLINK') { const m = s.match(/HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/i); if (m) { const local = /\\l/.test(s); const href = local ? '#' + m[1] : m[1]; if (/^(https?:|mailto:|tel:|#)/i.test(href)) return { open: `<a href="${esc(href)}">`, close: '</a>' }; } }
    return {};
  }
  const suppressed = () => ctx.fld.some(f => f.phase === 'instr' || (f.kind && f.kind.skip));

  function fmt(text, eff, base) {
    if (eff.hidden || !text) return '';
    if (eff.caps) text = text.toUpperCase();
    let s = esc(text).replace(/\t/g, '<span style="white-space:pre">\t</span>').replace(/ {2}/g, ' \u00a0');
    const st = [];
    if (eff.font && eff.font.toLowerCase() !== (base.font || 'Calibri').toLowerCase()) st.push(`font-family:${cssFont(eff.font)}`);
    if (eff.sz && Math.abs(eff.sz - base.sz) > 0.01) st.push(`font-size:${eff.sz}pt`);
    const col = !eff.color || eff.color === 'auto' ? '000000' : eff.color;
    if (col !== (base.color || '000000')) st.push(`color:#${col}`);
    const bg = eff.hl || eff.shd; if (bg) st.push(`background-color:#${bg}`);
    if (eff.smallCaps) st.push('font-variant:small-caps');
    if (st.length) s = `<span style="${st.join(';')}">${s}</span>`;
    if (!!eff.b !== !!base.b) s = eff.b ? `<b>${s}</b>` : `<span style="font-weight:normal">${s}</span>`;
    if (!!eff.i !== !!base.i) s = eff.i ? `<i>${s}</i>` : `<span style="font-style:normal">${s}</span>`;
    if (eff.u) s = `<u>${s}</u>`;
    if (eff.s) s = `<s>${s}</s>`;
    if (eff.va) s = `<${eff.va}>${s}</${eff.va}>`;
    return s;
  }
  function wrapComments(s) {
    if (!s) return s;
    for (const id of ctx.openC) {
      const c = comments.get(id); if (!c || c.parent) continue;
      usedComments.add(id); s = `<span class="cmt${c.resolved ? ' resolved' : ''}" data-c="${c.id}">${s}</span>`;
    }
    return s;
  }
  function image(el, relMap) {
    const blip = desc(el, 'blip')[0] || desc(el, 'imagedata')[0];
    const id = blip && (rid(blip, 'embed') || rid(blip, 'id'));
    const rel = id && relMap.get(id); const src = rel && media.get(rel.path);
    const dp = desc(el, 'docPr')[0]; const alt = dp ? (dp.getAttribute('descr') || dp.getAttribute('title') || '') : '';
    if (!src) return `<span style="color:#888">[image${alt ? ': ' + esc(alt) : ''}]</span>`;
    const ext = desc(el, 'extent')[0];
    let wpx = ext ? (+ext.getAttribute('cx') || 0) / 9525 : 0;
    if (!wpx) { const shape = desc(el, 'shape')[0]; const m = shape && /width:([\d.]+)pt/.exec(shape.getAttribute('style') || ''); if (m) wpx = +m[1] * 96 / 72; }
    const pct = wpx ? Math.max(5, Math.min(100, Math.round((wpx / contentWidthPx) * 100))) : 100;
    let style = `width:${pct}%`;
    const anchor = desc(el, 'anchor')[0];
    if (anchor) {
      const align = (desc(anchor, 'align')[0] || {}).textContent;
      if (align === 'right') style += ';float:right;margin:2px 0 6px 12px';
      else if (align === 'left') style += ';float:left;margin:2px 12px 6px 0';
      else if (align === 'center') style += ';display:block;margin:6px auto';
    }
    return `<img src="${src}" alt="${esc(alt)}" style="${style}">`;
  }
  function run(r, env) {
    const rp = parseRPr(kid(r, 'rPr'), theme);
    const eff = { ...env.paraR, ...(rp.rStyle ? styles.chainR(rp.rStyle) : {}), ...rp };
    let out = '', text = '';
    const flush = () => { if (text) { out += wrapComments(fmt(text, eff, env.base)); text = ''; } };
    for (const c of kids(r)) {
      const n = c.localName;
      if (n === 'fldChar') {
        flush();
        const t = at(c, 'fldCharType');
        if (t === 'begin') ctx.fld.push({ instr: '', phase: 'instr' });
        else if (t === 'separate') { const f = ctx.fld[ctx.fld.length - 1]; if (f) { f.phase = 'result'; f.kind = fieldKind(f.instr); if (f.kind.emit) out += f.kind.html ? f.kind.emit : esc(f.kind.emit); if (f.kind.open) out += f.kind.open; } }
        else if (t === 'end') {
          const f = ctx.fld.pop();
          if (f && f.phase === 'instr') { const k = fieldKind(f.instr); if (k.emit) out += k.html ? k.emit : esc(k.emit); }
          else if (f && f.kind && f.kind.close) out += f.kind.close;
        }
        continue;
      }
      if (n === 'instrText') { const f = ctx.fld[ctx.fld.length - 1]; if (f && f.phase === 'instr') f.instr += c.textContent; continue; }
      if (suppressed()) continue;
      switch (n) {
        case 't': case 'delText': text += c.textContent; break;
        case 'tab': case 'ptab': text += '\t'; break;
        case 'noBreakHyphen': text += '\u2011'; break;
        case 'sym': { const ch = parseInt(at(c, 'char') || '', 16); if (ch) text += ch >= 0xF000 ? '•' : String.fromCodePoint(ch); break; }
        case 'br': flush(); out += at(c, 'type') === 'page' ? '\f' : at(c, 'type') === 'column' ? '<br>' : '<br>'; break;
        case 'cr': flush(); out += '<br>'; break;
        case 'drawing': case 'pict': case 'object': flush(); out += image(c, env.rels); break;
        case 'footnoteReference': case 'endnoteReference': {
          flush(); const key = (n === 'footnoteReference' ? 'f' : 'e') + at(c, 'id');
          out += `<sup class="fn" contenteditable="false" data-fid="f${Math.random().toString(36).slice(2, 10)}" data-note="${esc(notes.get(key) || '')}"></sup>`; break;
        }
      }
    }
    flush();
    return out;
  }
  function inline(node, env) {
    let out = '';
    for (const c of kids(node)) {
      switch (c.localName) {
        case 'r': out += run(c, env); break;
        case 'hyperlink': {
          const id = rid(c); const anchor = at(c, 'anchor');
          const href = id ? env.rels.get(id)?.target : anchor ? '#' + anchor : null;
          const inner = inline(c, env);
          out += href && /^(https?:|mailto:|tel:|#)/i.test(href) ? `<a href="${esc(href)}">${inner}</a>` : inner; break;
        }
        case 'ins': case 'moveTo': case 'del': case 'moveFrom': {
          const tag = /ins|moveTo/.test(c.localName) ? 'ins' : 'del';
          const inner = inline(c, env);
          if (inner) out += `<${tag} class="tc" data-a="${esc(at(c, 'author') || 'Unknown')}" data-t="${Date.parse(at(c, 'date') || '') || Date.now()}">${inner}</${tag}>`;
          break;
        }
        case 'fldSimple': {
          const k = fieldKind(at(c, 'instr') || '');
          if (k.emit) out += k.html ? k.emit : esc(k.emit);
          else { const inner = inline(c, env); out += k.open ? k.open + inner + k.close : inner; }
          break;
        }
        case 'smartTag': case 'customXml': case 'sdtContent': out += inline(c, env); break;
        case 'sdt': out += inline(kid(c, 'sdtContent') || c, env); break;
        case 'commentRangeStart': ctx.openC.push(at(c, 'id')); break;
        case 'commentRangeEnd': { const id = at(c, 'id'); ctx.openC = ctx.openC.filter(x => x !== id); break; }
        case 'oMath': case 'oMathPara': out += `<i>${esc(desc(c, 't').map(t => t.textContent).join(''))}</i>`; break;
      }
    }
    return out;
  }

  /* ---------- blocks ---------- */
  function paragraph(p, env) {
    const own = parsePPr(kid(p, 'pPr'));
    const sid = own.style || styles.defPara;
    const pp = { ...styles.defP, ...styles.chainP(sid), ...own };
    const name = styles.name(sid);
    let tag = 'p', cls = '', baseKey = 'p';
    const hm = /^heading\s*(\d)$/.exec(name);
    if (hm) { tag = 'h' + Math.min(4, +hm[1]); baseKey = tag; }
    else if (name === 'title') { cls = 'title'; baseKey = 'title'; }
    else if (name === 'subtitle') { cls = 'subtitle'; baseKey = 'subtitle'; }
    else if (/quote/.test(name)) { tag = 'blockquote'; baseKey = 'blockquote'; }
    else if (pp.outline != null && pp.outline < 4 && !/^(normal|toc|list)/.test(name) && own.outline != null) { tag = 'h' + (pp.outline + 1); baseKey = tag; }
    const paraR = { ...styles.defR, ...styles.chainR(sid) };
    const inner = inline(p, { ...env, paraR, base: BASE[baseKey] });
    const st = [];
    if (pp.jc === 'center') st.push('text-align:center'); else if (pp.jc === 'right' || pp.jc === 'end') st.push('text-align:right'); else if (pp.jc === 'both' || pp.jc === 'distribute') st.push('text-align:justify');
    if (pp.lineRule === 'auto' && pp.line && pp.line !== 240 && pp.line !== 259 && pp.line !== 276) st.push(`line-height:${Math.round((pp.line / 240) * 1.2 * 100) / 100}`);
    const listed = pp.numId && pp.numId !== '0';
    if (!listed) {
      if (pp.indL) st.push(`margin-left:${Math.round(pp.indL / 1440 * 100) / 100}in`);
      if (pp.indFirst) st.push(`text-indent:${Math.round(pp.indFirst / 1440 * 100) / 100}in`);
      else if (pp.indHang && pp.indL) st.push(`text-indent:-${Math.round(pp.indHang / 1440 * 100) / 100}in`);
    }
    const style = st.length ? ` style="${st.join(';')}"` : '';
    const parts = inner.split('\f');
    const items = [];
    if (pp.pbb) items.push({ html: '<div class="page-break" contenteditable="false"></div>' });
    parts.forEach((part, i) => {
      if (i > 0) items.push({ html: '<div class="page-break" contenteditable="false"></div>' });
      if (i > 0 && !part.trim() && i === parts.length - 1) return;
      const content = part.trim() ? part : '<br>';
      if (listed && i === 0) {
        const lvl = numbering(pp.numId, pp.ilvl || 0) || { fmt: 'bullet' };
        const ordered = !/bullet|none/.test(lvl.fmt);
        const type = { lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' }[lvl.fmt] || '';
        items.push({ list: { ilvl: pp.ilvl || 0, tag: ordered ? 'ol' : 'ul', type, check: /[☐□❑]/.test(lvl.text) }, inner: content, liAttr: style });
      } else items.push({ html: `<${tag}${cls ? ` class="${cls}"` : ''}${style}>${content}</${tag}>` });
    });
    return { items, sectPr: own.sectPr || null };
  }
  function table(tbl, env) {
    const rows = kids(tbl, 'tr'); const grid = [];
    rows.forEach(tr => {
      let col = 0; const cells = [];
      const header = !!desc(kid(tr, 'trPr'), 'tblHeader').length;
      const tcs = kids(tr).flatMap(x => x.localName === 'tc' ? [x] : x.localName === 'sdt' ? kids(kid(x, 'sdtContent'), 'tc') : []);
      for (const tc of tcs) {
        const pr = kid(tc, 'tcPr'); const span = +(at(kid(pr, 'gridSpan'), 'val') || 1);
        const vm = kid(pr, 'vMerge'); const fill = at(kid(pr, 'shd'), 'fill');
        cells.push({ tc, col, span, vm: vm ? (at(vm, 'val') === 'restart' ? 'restart' : 'continue') : null, bg: fill && fill !== 'auto' && !/^F{6}$/i.test(fill) ? fill : null, th: header, rs: 1 });
        col += span;
      }
      grid.push(cells);
    });
    grid.forEach((cells, ri) => cells.forEach(c => {
      if (c.vm !== 'continue') return; c.skip = true;
      for (let up = ri - 1; up >= 0; up--) { const a = grid[up].find(x => x.col === c.col); if (!a) break; if (!a.skip) { a.rs++; break; } }
    }));
    let html = '<table><tbody>';
    for (const cells of grid) {
      html += '<tr>';
      for (const c of cells) {
        if (c.skip) continue; const t = c.th ? 'th' : 'td';
        const inner = blocksHTML(kids(c.tc), env).html;
        html += `<${t}${c.span > 1 ? ` colspan="${c.span}"` : ''}${c.rs > 1 ? ` rowspan="${c.rs}"` : ''}${c.bg ? ` style="background-color:#${c.bg}"` : ''}>${inner || '<br>'}</${t}>`;
      }
      html += '</tr>';
    }
    return html + '</tbody></table>';
  }
  function assemble(items) {
    let html = ''; const stack = [];
    const close = () => { html += `</li></${stack.pop().tag}>`; };
    for (const it of items) {
      if (!it.list) { while (stack.length) close(); html += it.html; continue; }
      const { ilvl, tag, type, check } = it.list;
      while (stack.length && stack[stack.length - 1].ilvl > ilvl) close();
      const top = stack[stack.length - 1];
      if (top && top.ilvl === ilvl) {
        if (top.tag === tag && top.check === check) { html += `</li><li${it.liAttr}${check ? ' data-checked="false"' : ''}>${it.inner}`; continue; }
        close();
      }
      html += `<${tag}${type ? ` type="${type}"` : ''}${check ? ' class="checklist"' : ''}><li${it.liAttr}${check ? ' data-checked="false"' : ''}>${it.inner}`;
      stack.push({ tag, ilvl, check });
    }
    while (stack.length) close();
    return html;
  }
  function blocksHTML(nodes, env) {
    const sections = []; let items = [];
    const walk = list => {
      for (const n of list) {
        switch (n.localName) {
          case 'p': { const r = paragraph(n, env); items.push(...r.items); if (r.sectPr) { sections.push({ items, sectPr: r.sectPr }); items = []; } break; }
          case 'tbl': items.push({ html: table(n, env) }); break;
          case 'sdt': walk(kids(kid(n, 'sdtContent'))); break;
          case 'customXml': walk(kids(n)); break;
          case 'sectPr': sections.push({ items, sectPr: n }); items = []; break;
        }
      }
    };
    walk(nodes);
    if (items.length) sections.push({ items, sectPr: null });
    let html = '';
    for (const s of sections) {
      const inner = assemble(s.items);
      const cols = s.sectPr && kid(s.sectPr, 'cols'); const num = cols ? +(at(cols, 'num') || 1) : 1;
      if (num > 1 && inner.trim()) {
        const gap = Math.round(((+at(cols, 'space') || 720) / 1440) * 100) / 100;
        html += `<div class="cols" data-cols="${num}" style="column-count:${num};column-gap:${gap}in">${inner}</div>`;
      } else html += inner;
    }
    return { html };
  }

  const out = blocksHTML(kids(body), { rels });

  // header / footer text
  async function hfText(type) {
    const refs = desc(body, 'sectPr').flatMap(sp => kids(sp, type + 'Reference'));
    const ref = refs.find(r => at(r, 'type') === 'default') || refs[0];
    const rel = ref && rels.get(rid(ref)); if (!rel) return '';
    const d = await xml(rel.path); if (!d) return '';
    const lines = [];
    for (const p of desc(d, 'p')) {
      let s = ''; const fld = [];
      const walk = el => {
        for (const c of kids(el)) {
          const n = c.localName;
          if (n === 'fldSimple') { const k = fieldKind(at(c, 'instr') || ''); s += k.emit && !k.html ? k.emit : plainText(c); continue; }
          if (n === 'fldChar') { const t = at(c, 'fldCharType'); if (t === 'begin') fld.push({ instr: '', phase: 'instr' }); else if (t === 'separate') { const f = fld[fld.length - 1]; if (f) { f.phase = 'result'; f.kind = fieldKind(f.instr); if (f.kind.emit && !f.kind.html) s += f.kind.emit; } } else if (t === 'end') { const f = fld.pop(); if (f && f.phase === 'instr') { const k = fieldKind(f.instr); if (k.emit && !k.html) s += k.emit; } } continue; }
          if (n === 'instrText') { const f = fld[fld.length - 1]; if (f && f.phase === 'instr') f.instr += c.textContent; continue; }
          if (fld.some(f => f.phase === 'instr' || (f.kind && f.kind.skip))) continue;
          if (n === 't') s += c.textContent; else if (n === 'tab' || n === 'ptab') s += '   '; else if (n === 'p' || n === 'tbl' || n === 'txbxContent') continue; else walk(c);
        }
      };
      walk(p);
      if (s.trim()) lines.push(s.replace(/\s{4,}/g, '   ').trim());
    }
    return lines.join('\n');
  }
  const header = await hfText('header');
  const footer = await hfText('footer');

  // title
  let title = '';
  const core = await xml('docProps/core.xml');
  if (core) title = (desc(core, 'title')[0] || {}).textContent || '';

  // comments that were anchored in the text (+ their replies)
  const outComments = [];
  for (const [id, c] of comments) {
    if (c.parent) continue;
    if (!usedComments.has(id)) continue;
    const replies = [...comments.values()].filter(x => x.parent === c).map(x => ({ author: x.author, time: x.time, text: x.text }));
    outComments.push({ id: c.id, author: c.author, time: c.time, text: c.text, resolved: c.resolved, replies });
  }

  return { title: title.trim(), html: out.html || '<p><br></p>', header, footer, page, comments: outComments };
}

window.LekhDocx = { convert };
})();
