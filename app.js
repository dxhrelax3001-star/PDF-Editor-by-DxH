'use strict';
/* PDF Editor — xem bằng pdf.js, chỉnh sửa trên lớp fabric.js, xuất bằng pdf-lib.
   Toạ độ đối tượng = point PDF theo chiều hiển thị của trang (gốc trên-trái, y đi xuống). */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const L = PDFLib;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const PROPS = ['kind', 'region', 'under', 'ocrBlur', 'tag', 'selectable', 'evented', 'ocrSrc', 'lockMovementX', 'lockMovementY', 'hasControls'];
const THUMB_W = 118;
// ảnh thu nhỏ to / nhỏ theo độ rộng cột ảnh thu nhỏ (kéo giãn cột → ảnh to theo)
const thumbW = () => { const c = document.getElementById('thumbcol'); const w = c && c.clientWidth ? c.clientWidth - 40 : THUMB_W; return Math.max(70, Math.min(320, w)); };
let uid = 0;
const nid = p => p + (++uid).toString(36) + Math.random().toString(36).slice(2, 6);

const S = {
  sources: {},          // id -> { bytes, js (pdf.js doc), lib (pdf-lib doc), name }
  pages: [],            // { id, src, index, baseRot, rot, w, h, objs }
  zoom: 1, tool: 'select', fileName: 'tai-lieu.pdf', handle: null,
  undo: [], redo: [], snap: '[]', dirty: false,
  cur: 0, sel: new Set(), views: new Map(), thumbs: new Map(), activeView: null, clip: null,
  style: { color: '#d32f2f', hl: '#ffeb3b', fill: '', stroke: 2, font: 'Arial', size: 16, bold: false, italic: false, align: 'left', opacity: 1 },
};

fabric.Object.NUM_FRACTION_DIGITS = 5; // giữ đủ số lẻ khi lưu đối tượng (mặc định làm tròn 2 số → scaleX 1,05298 thành 1,05: chữ lệch 0,5pt)
// chân chữ (đường baseline) nằm dưới mép trên ô chữ fabric 1 đoạn = cỡ chữ × BASE_K (fabric: 1,13 × (1 − 0,222) ≈ 0,879)
const BASE_K = fabric.Text.prototype._fontSizeMult * (1 - fabric.Text.prototype._fontSizeFraction);
fabric.IText.prototype.objectCaching = false; // vẽ chữ trực tiếp, không qua ảnh đệm → nét chữ sắc, không nhoè khi phóng to
fabric.IText.prototype.selectionColor = 'rgba(26,115,232,0.18)';
fabric.IText.prototype.editingBorderColor = 'rgba(26,115,232,0.5)';
fabric.Object.prototype.set({ transparentCorners: false, cornerColor: '#fff', cornerStrokeColor: '#1a73e8', borderColor: '#1a73e8', cornerSize: 9, cornerStyle: 'circle', padding: 2 });

const effRot = pg => (((pg.baseRot + pg.rot) % 360) + 360) % 360;
const dispSize = pg => (effRot(pg) % 180 ? [pg.h, pg.w] : [pg.w, pg.h]);
const isText = o => o && (o.type === 'i-text' || o.type === 'textbox' || o.type === 'text');
const baseName = () => S.fileName.replace(/\.pdf$/i, '');

/* ---------------- tiện ích UI ---------------- */
let toastT;
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
function busy(on, msg) { $('#busy').hidden = !on; if (msg) $('#busyMsg').textContent = msg; }
function downloadBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const readAsDataURL = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
const loadImg = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
const enliven = objs => new Promise(ok => fabric.util.enlivenObjects(objs || [], r => ok(r)));

/* ---------------- lịch sử (hoàn tác) ---------------- */
const snapshot = () => JSON.stringify(S.pages);
function commit() {
  const s = snapshot(); if (s === S.snap) return;
  S.undo.push(S.snap); if (S.undo.length > 80) S.undo.shift();
  S.snap = s; S.redo = []; S.dirty = true; updateUI();
  if (window.PdfFind && PdfFind.isOpen()) { clearTimeout(S.findT); S.findT = setTimeout(() => PdfFind.refresh(), 500); } // nội dung đổi → tìm lại
}
function resetHistory() { S.undo = []; S.redo = []; S.snap = snapshot(); S.dirty = false; }
function undo() { if (!S.undo.length) return; S.redo.push(S.snap); S.snap = S.undo.pop(); S.pages = JSON.parse(S.snap); S.dirty = true; rebuild(); }
function redo() { if (!S.redo.length) return; S.undo.push(S.snap); S.snap = S.redo.pop(); S.pages = JSON.parse(S.snap); S.dirty = true; rebuild(); }
function syncView(v) {
  if (!v.fc || v.loading) return;
  v.fc.renderAll();
  v.page.objs = v.fc.toObject(PROPS).objects;
  commit(); drawThumbOverlay(v.page.id);
  // vừa có đối tượng 'dưới nội dung PDF' mà trang chưa tách lớp nền -> vẽ lại trang theo 2 lớp
  if (v.painted && !v.split && !v.splitTried && v.page.src && v.page.objs.some(o => o.under)) { v.splitTried = true; refreshPdfLayer(v); }
}

/* ---------------- sửa phông nhúng bị hỏng ----------------
   Vài phần mềm (vd Kingsoft PDF khi dịch song ngữ) nhúng phông Type 1 (PFB) vào chỗ dành cho phông TrueType (FontFile2)
   → mọi trình đọc vẽ ra ký tự rác. Chữ trong file vẫn đúng nhờ bảng ToUnicode, nên thay phông hỏng bằng Arial thật:
   nhúng Arial (rút gọn chỉ các chữ cần) + bảng CIDToGIDMap ánh xạ mã chữ → hình chữ Arial theo ToUnicode.
   Giữ nguyên bề rộng ký tự (/W) nên dòng chữ không xê dịch. Trả về bytes mới (hoặc bytes cũ nếu không có gì phải sửa). */
function parseToUnicode(txt) {
  const map = new Map(), hex = s => parseInt(s, 16);
  const uni = h => { const cs = []; for (let i = 0; i + 4 <= h.length; i += 4) cs.push(hex(h.slice(i, i + 4))); return String.fromCharCode(...cs); };
  for (const blk of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(hex(m[1]), uni(m[2]));
  for (const blk of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const a = hex(m[1]), b = hex(m[2]);
      if (m[3][0] === '[') { const arr = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map(x => x[1]); for (let c = a; c <= b && c - a < arr.length; c++) map.set(c, uni(arr[c - a])); }
      else { const base = m[3].slice(1, -1), last = hex(base.slice(-4)); for (let c = a; c <= b; c++) map.set(c, uni(base.slice(0, -4)) + String.fromCharCode(last + c - a)); }
    }
  }
  return map;
}
async function repairFonts(bytes) {
  if (!window.fontkit) return bytes;
  let doc; try { doc = await PDFLib.PDFDocument.load(bytes.slice(), { ignoreEncryption: false, updateMetadata: false }); } catch (e) { return bytes; }
  const ctx = doc.context, N = n => PDFLib.PDFName.of(n), fixed = [];
  const okFont = d => { const h = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0; return h === 0x00010000 || h === 0x74727565 || h === 0x4F54544F || h === 0x74746366; };
  const ttf = {}; const getTtf = async file => ttf[file] || (ttf[file] = fetch('fonts/f/' + file).then(r => r.ok ? r.arrayBuffer() : null).then(b => b && fontkit.create(new Uint8Array(b))).catch(() => null));
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFLib.PDFDict) || String(obj.get(N('Subtype'))) !== '/Type0') continue;
    const desc = ctx.lookup(obj.get(N('DescendantFonts'))); const cid = desc && ctx.lookup(desc.get ? desc.get(0) : null);
    if (!cid || String(cid.get(N('Subtype'))) !== '/CIDFontType2') continue;
    const fd = ctx.lookup(cid.get(N('FontDescriptor'))); if (!fd) continue;
    const ffRef = fd.get(N('FontFile2')); if (!ffRef) continue;
    let data; try { data = PDFLib.decodePDFRawStream(ctx.lookup(ffRef)).decode(); } catch (e) { continue; }
    if (okFont(data)) continue;
    const tuRef = obj.get(N('ToUnicode')); if (!tuRef) continue;
    let tu; try { tu = parseToUnicode(new TextDecoder('latin1').decode(PDFLib.decodePDFRawStream(ctx.lookup(tuRef)).decode())); } catch (e) { continue; }
    if (!tu.size) continue;
    const fname = String(fd.get(N('FontName')) || ''), bold = /bold|black|heavy/i.test(fname), italic = /italic|oblique/i.test(fname);
    const font = await getTtf(bold ? (italic ? 'arialbi.ttf' : 'arialbd.ttf') : (italic ? 'ariali.ttf' : 'arial.ttf')) || await getTtf('arial.ttf');
    if (!font) continue;
    // CID → hình chữ Arial (rút gọn phông chỉ giữ các chữ dùng tới)
    const subset = font.createSubset(), maxCid = Math.max(...tu.keys());
    const map = new Uint8Array((maxCid + 1) * 2);
    for (const [c, s] of tu) {
      const cp = s.codePointAt(0); if (cp == null) continue;
      const g = font.glyphForCodePoint(cp); if (!g || !g.id) continue;
      const ng = subset.includeGlyph(g); map[c * 2] = ng >> 8; map[c * 2 + 1] = ng & 255;
    }
    const sub = await new Promise((ok, no) => { const parts = []; const s = subset.encodeStream(); s.on('data', d => parts.push(d)); s.on('end', () => { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } ok(out); }); s.on('error', no); }).catch(() => null);
    if (!sub) continue;
    fd.set(N('FontFile2'), ctx.register(ctx.flateStream(sub, { Length1: sub.length })));
    cid.set(N('CIDToGIDMap'), ctx.register(ctx.flateStream(map)));
    fixed.push(fname);
  }
  if (!fixed.length) return bytes;
  console.info('Đã thay phông nhúng bị hỏng:', fixed);
  S.fontFixed = fixed;
  return await doc.save({ useObjectStreams: false });
}

/* ---------------- mở file ---------------- */
async function addPdfSource(bytes, name) {
  try { const b2 = await repairFonts(bytes); if (b2 !== bytes) { bytes = b2; toast(`"${name}" có phông nhúng bị hỏng (${S.fontFixed.join(', ').replace(/\//g, '')}) — đã tự thay bằng Arial để chữ hiện đúng`, 6000); } } catch (e) { console.warn('repairFonts', e); }
  const id = nid('s');
  const js = await pdfjsLib.getDocument({
    data: bytes.slice(),
    password: undefined,
  }).promise.catch(async e => {
    if (e && e.name === 'PasswordException') {
      const pw = prompt(`"${name}" có mật khẩu. Nhập mật khẩu để mở:`);
      if (pw == null) throw new Error('Đã huỷ');
      return pdfjsLib.getDocument({ data: bytes.slice(), password: pw }).promise;
    }
    throw e;
  });
  S.sources[id] = { bytes, js, lib: null, name };
  const out = [];
  for (let i = 0; i < js.numPages; i++) {
    const p = await js.getPage(i + 1);
    const [x0, y0, x1, y1] = p.view;
    out.push({ id: nid('p'), src: id, index: i, baseRot: p.rotate || 0, rot: 0, w: x1 - x0, h: y1 - y0, objs: [] });
  }
  const hidden = await hiddenLayersOf(id);
  if (hidden.length) {
    try {
      const lib = await getLib(id);
      for (const pg of out) { const used = [...TextOps.scan(lib, lib.getPage(pg.index)).layers.keys()].filter(n => hidden.includes(n)); if (used.length) pg.rm = { layers: used }; }
    } catch (e) { console.warn(e); }
  }
  return out;
}
async function imagePage(file) {
  const url = await readAsDataURL(file);
  const img = await loadImg(url);
  let s = 0.75; // px -> pt (96 dpi)
  const maxSide = 1190; if (Math.max(img.width, img.height) * s > maxSide) s = maxSide / Math.max(img.width, img.height);
  const w = img.width * s, h = img.height * s;
  return { id: nid('p'), src: null, index: 0, baseRot: 0, rot: 0, w, h,
    objs: [{ type: 'image', version: '5.3.0', originX: 'left', originY: 'top', left: 0, top: 0, width: img.width, height: img.height, scaleX: s, scaleY: s, src: url, kind: 'image' }] };
}
const blankPage = (w = 595.28, h = 841.89) => ({ id: nid('p'), src: null, index: 0, baseRot: 0, rot: 0, w, h, objs: [] });

/* Trang nguồn trong pdf-lib, và trang pdf.js để hiển thị (đã xoá chữ cũ nếu trang có vùng sửa chữ pg.del) */
async function getLib(srcId) {
  const src = S.sources[srcId];
  if (!src.lib) src.lib = await L.PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
  return src.lib;
}
const derived = new Map();
let altDown = false;
window.addEventListener('keydown', e => { if (e.key === 'Alt') altDown = true; });
window.addEventListener('keyup', e => { if (e.key === 'Alt') altDown = false; });
window.addEventListener('blur', () => { altDown = false; });
const pageEdited = pg => !!pg.src && ((pg.del && pg.del.length > 0) || (pg.imgEdits && pg.imgEdits.length > 0) || TextOps.rmActive(pg.rm));
/* ảnh sửa tại chỗ (tẩy vùng): dữ liệu ảnh để riêng trong S.imgStore, trang chỉ giữ id -> lịch sử hoàn tác nhẹ */
S.imgStore = new Map();
async function prepRegions(doc, del, imgEdits, cache) {
  const regs = [...(del || [])];
  for (const e of imgEdits || []) {
    const url = S.imgStore.get(e.id); if (!url) continue;
    let ref = cache && cache.get(e.id);
    if (!ref) { ref = (await doc.embedPng(url)).ref; if (cache) cache.set(e.id, ref); }
    regs.push({ img: true, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, ref });
  }
  return regs;
}
function getJsPage(pg) {
  if (!pageEdited(pg)) return S.sources[pg.src].js.getPage(pg.index + 1);
  const key = pg.src + '|' + pg.index + '|' + JSON.stringify(pg.del || []) + '|' + JSON.stringify(pg.rm || {}) + '|' + JSON.stringify(pg.imgEdits || []);
  if (!derived.has(key)) {
    derived.set(key, (async () => {
      const d = await L.PDFDocument.create();
      const [cp] = await d.copyPages(await getLib(pg.src), [pg.index]); d.addPage(cp);
      TextOps.strip(d, cp, await prepRegions(d, pg.del, pg.imgEdits), pg.rm);
      const js = await pdfjsLib.getDocument({ data: await d.save() }).promise;
      return js.getPage(1);
    })());
    if (derived.size > 40) { const k = derived.keys().next().value; derived.get(k).then(p => p.cleanup && p.cleanup()).catch(() => {}); derived.delete(k); }
  }
  return derived.get(key);
}

async function filesToPages(files) {
  const pages = [];
  for (const f of files) {
    try {
      if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) pages.push(...await addPdfSource(new Uint8Array(await f.arrayBuffer()), f.name));
      else if (/^image\//.test(f.type)) pages.push(await imagePage(f));
      else toast(`Bỏ qua "${f.name}" (không phải PDF/ảnh)`);
    } catch (e) { console.error(e); alert(`Không mở được "${f.name}": ${e.message || e}`); }
  }
  return pages;
}
/* ---------------- nhiều tài liệu trong cùng cửa sổ (thanh tab) ---------------- */
const DOC_KEYS = ['pages', 'undo', 'redo', 'snap', 'dirty', 'fileName', 'handle', 'zoom', 'fit', 'cur', 'sel', 'outline'];
S.docs = []; S.docIdx = -1;
function emptyDoc() { return { id: nid('d'), pages: [], undo: [], redo: [], snap: '[]', dirty: false, fileName: 'tai-lieu.pdf', handle: null, zoom: 1, cur: 0, sel: new Set(), scrollTop: 0, outline: null }; }
function saveDoc() {
  const d = S.docs[S.docIdx]; if (!d) return;
  finishEditing();
  for (const k of DOC_KEYS) d[k] = S[k];
  d.scrollTop = $('#viewer').scrollTop;
}
function loadDoc(i) {
  const d = S.docs[i]; if (!d) return;
  S.docIdx = i;
  for (const k of DOC_KEYS) S[k] = d[k];
  rebuild(); $('#viewer').scrollTop = d.scrollTop || 0; onScroll();
  renderDocTabs(); updateUI(); refreshProps();
}
function switchDoc(i) { if (i === S.docIdx) return; saveDoc(); loadDoc(i); }
function addDocTab() { saveDoc(); S.docs.push(emptyDoc()); loadDoc(S.docs.length - 1); }
function closeDoc(i) {
  saveDoc();
  const d = S.docs[i]; if (!d) return;
  if (d.dirty && d.pages.length && !confirm(`"${d.fileName}" chưa lưu. Đóng và bỏ thay đổi?`)) return;
  S.docs.splice(i, 1);
  let next = i < S.docIdx ? S.docIdx - 1 : i === S.docIdx ? Math.min(i, S.docs.length - 1) : S.docIdx;
  if (!S.docs.length) { S.docs.push(emptyDoc()); next = 0; }
  loadDoc(next);
}
function renderDocTabs() {
  const box = $('#doctabs'); if (!box) return;
  box.innerHTML = '';
  S.docs.forEach((d, i) => {
    const cur = i === S.docIdx, name = cur ? S.fileName : d.fileName, dirty = cur ? S.dirty : d.dirty, has = cur ? S.pages.length : d.pages.length;
    const t = document.createElement('div'); t.className = 'dtab' + (cur ? ' on' : ''); t.title = name;
    t.innerHTML = `<span class="nm"></span><span class="dot">${dirty && has ? '•' : ''}</span><button class="x" title="Đóng">×</button>`;
    t.querySelector('.nm').textContent = has ? name : 'Tab mới';
    t.onclick = e => { if (e.target.classList.contains('x')) closeDoc(i); else switchDoc(i); };
    t.onauxclick = e => { if (e.button === 1) closeDoc(i); };
    box.appendChild(t);
  });
  const add = document.createElement('button'); add.className = 'dadd'; add.title = 'Mở thêm file trong tab mới'; add.textContent = '＋';
  add.onclick = () => openPicker();
  box.appendChild(add);
}
async function openFiles(files, replace) {
  files = [...files]; if (!files.length) return;
  busy(true, 'Đang mở…');
  try {
    const pages = await filesToPages(files);
    if (!pages.length) return;
    if (replace) {
      if (S.pages.length) addDocTab(); // mở trong tab mới, giữ tài liệu đang mở
      S.pages = pages; S.handle = null; S.sel = new Set(); S.cur = 0;
      S.fileName = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') + '.pdf' : 'tai-lieu-ghep.pdf';
      S.zoom = fitZoom(); S.fit = true; rebuild(); resetHistory(); updateUI();
      $('#viewer').scrollTop = 0;
      S.outline = null; if (window.PdfTools) PdfTools.importOutline(); // giữ mục lục (bookmark) có sẵn trong file
    } else {
      const at = S.pages.length;
      S.pages.push(...pages); rebuild(); commit();
      toast(`Đã ghép thêm ${pages.length} trang`);
      scrollToPage(at);
    }
  } finally { busy(false); }
}
// mở file: qua recent.js (nhớ vào "File gần đây") nếu có, không thì ô chọn file thường
function openPicker() { if (window.PdfRecent) PdfRecent.open(); else $('#fileOpen').click(); }
function newDoc() {
  if (S.pages.length) addDocTab();
  S.pages = [blankPage()]; S.handle = null; S.fileName = 'tai-lieu-moi.pdf'; S.sel = new Set(); S.cur = 0;
  S.zoom = fitZoom(); S.fit = true; rebuild(); resetHistory(); updateUI();
}

/* ---------------- hiển thị trang ---------------- */
let io, tio;
function fitZoom() {
  const vw = $('#viewer').clientWidth - 60;
  const maxW = Math.max(...S.pages.map(p => dispSize(p)[0]), 1);
  if (S.twoUp && S.pages.length > 1) return Math.max(0.25, Math.min(1.6, (vw - 16) / (maxW * 2))); // xem 2 trang cạnh nhau
  return Math.max(0.25, Math.min(1.6, vw / maxW));
}
function rebuild() {
  const viewer = $('#viewer');
  const ratio = viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
  clearSelBox();
  for (const v of S.views.values()) { try { v.fc && v.fc.dispose(); } catch (e) {} }
  S.views.clear(); S.activeView = null;
  io && io.disconnect();
  io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) ready(S.views.get(e.target.dataset.id)); }), { root: viewer, rootMargin: '800px 0px' });
  const box = $('#pages'); box.innerHTML = '';
  $('#empty').hidden = S.pages.length > 0;
  let row = null;
  S.pages.forEach((pg, i) => {
    const [W, H] = dispSize(pg), z = S.zoom;
    const el = document.createElement('div'); el.className = 'page'; el.dataset.id = pg.id;
    el.style.width = W * z + 'px'; el.style.height = H * z + 'px';
    const cv = document.createElement('canvas'); cv.className = 'pdfc'; el.appendChild(cv);
    const n = document.createElement('div'); n.className = 'pnum'; n.textContent = `${i + 1}`; el.appendChild(n);
    // xem 2 trang cạnh nhau: mỗi hàng 2 trang (1–2, 3–4…)
    if (S.twoUp) { if (i % 2 === 0) { row = document.createElement('div'); row.className = 'prow'; box.appendChild(row); } row.appendChild(el); }
    else box.appendChild(el);
    const v = { page: pg, el, cv, fc: null, renderP: null, loading: false };
    S.views.set(pg.id, v); io.observe(el);
  });
  for (const id of [...S.sel]) if (!S.pages.some(p => p.id === id)) S.sel.delete(id);
  S.cur = Math.min(S.cur, Math.max(0, S.pages.length - 1));
  buildThumbs();
  viewer.scrollTop = ratio * viewer.scrollHeight;
  updateUI();
  if (window.PdfFind) PdfFind.redraw(); // vẽ lại ô tô sáng của thanh tìm chữ
}
function ready(v) {
  if (!v) return Promise.resolve();
  return v.renderP || (v.renderP = renderView(v));
}
async function renderView(v) {
  const pg = v.page, z = S.zoom, [W, H] = dispSize(pg);
  v.cv.width = Math.round(W * z * DPR); v.cv.height = Math.round(H * z * DPR);
  v.cv.style.width = W * z + 'px'; v.cv.style.height = H * z + 'px';
  // nền trắng nằm ở thẻ .page; trang PDF vẽ trong suốt để thấy được đối tượng 'dưới nội dung PDF' (canvas v.uc bên dưới)
  if (!v.uc) { v.uc = document.createElement('canvas'); v.uc.className = 'pdfc under'; v.el.insertBefore(v.uc, v.cv); }
  v.uc.width = v.cv.width; v.uc.height = v.cv.height; v.uc.style.width = v.cv.style.width; v.uc.style.height = v.cv.style.height;
  await paintPdf(v);
  if (S.views.get(pg.id) !== v) return;
  await makeFabric(v);
  hookTextSelect(v);
  renderTextLayer(v);
}
/* Trang có đối tượng "dưới nội dung PDF": tách trang thành 2 lớp — NỀN (ảnh / mảng tô cả trang) và PHẦN CÒN LẠI.
   Thứ tự hiển thị: v.ub (nền) -> v.uc (đối tượng lớp dưới) -> v.cv (chữ, bảng…) -> lớp chữ -> fabric */
const layerCache = new Map();
async function getJsLayers(pg) {
  if (!pg.src || !(pg.objs || []).some(o => o.under)) return { bg: null, fg: pg.src ? await getJsPage(pg) : null };
  const key = pg.src + '|' + pg.index + '|' + JSON.stringify(pg.del || []) + JSON.stringify(pg.rm || {}) + JSON.stringify(pg.imgEdits || []);
  if (!layerCache.has(key)) layerCache.set(key, (async () => {
    try {
      const d = await L.PDFDocument.create();
      const [cp] = await d.copyPages(await getLib(pg.src), [pg.index]); d.addPage(cp);
      if (pageEdited(pg)) TextOps.strip(d, cp, await prepRegions(d, pg.del, pg.imgEdits), pg.rm);
      const sp = TextOps.bgSplit(d, cp);
      if (!sp.offset) return null;
      const d2 = await L.PDFDocument.create();
      const [a, b] = await d2.copyPages(d, [0, 0]); d2.addPage(a); d2.addPage(b);
      const C = L.PDFName.of('Contents');
      a.node.set(C, d2.context.register(d2.context.flateStream(sp.bytes.subarray(0, sp.offset))));
      const pre = new TextEncoder().encode(TextOps.reopenPrefix(sp)), rest = sp.bytes.subarray(sp.offset);
      const all = new Uint8Array(pre.length + rest.length); all.set(pre); all.set(rest, pre.length);
      b.node.set(C, d2.context.register(d2.context.flateStream(all)));
      const js = await pdfjsLib.getDocument({ data: await d2.save() }).promise;
      return { bg: await js.getPage(1), fg: await js.getPage(2) };
    } catch (e) { console.warn('layers', e); return null; }
  })());
  return (await layerCache.get(key)) || { bg: null, fg: await getJsPage(pg) };
}
async function paintPdf(v) {
  const pg = v.page, z = S.zoom;
  let Ls = { bg: null, fg: null };
  try { Ls = await getJsLayers(pg); } catch (e) { console.error(e); }
  if (S.views.get(pg.id) !== v) return;
  const draw = async (page, canvas, extra) => {
    const tmp = document.createElement('canvas'); tmp.width = v.cv.width; tmp.height = v.cv.height;
    if (page) { try { await page.render({ canvasContext: tmp.getContext('2d'), viewport: page.getViewport({ scale: z * DPR, rotation: effRot(pg) }), background: 'rgba(0,0,0,0)', ...(extra || {}) }).promise; } catch (e) { console.error(e); } }
    const c = canvas.getContext('2d'); c.clearRect(0, 0, canvas.width, canvas.height); c.drawImage(tmp, 0, 0);
  };
  if (Ls.bg) {
    if (!v.ub) { v.ub = document.createElement('canvas'); v.ub.className = 'pdfc under'; v.el.insertBefore(v.ub, v.uc || v.cv); }
    v.ub.width = v.cv.width; v.ub.height = v.cv.height; v.ub.style.width = v.cv.style.width; v.ub.style.height = v.cv.style.height;
    await draw(Ls.bg, v.ub, { annotationMode: pdfjsLib.AnnotationMode.DISABLE });
  } else if (v.ub) v.ub.getContext('2d').clearRect(0, 0, v.ub.width, v.ub.height);
  await draw(Ls.fg, v.cv);
  v.split = !!Ls.bg; v.painted = true;
}
async function makeFabric(v) {
  const [W, H] = dispSize(v.page), z = S.zoom;
  const c = document.createElement('canvas'); v.el.appendChild(c);
  const fc = new fabric.Canvas(c, { width: W * z, height: H * z, preserveObjectStacking: true, stopContextMenu: true, uniScaleKey: 'shiftKey', targetFindTolerance: 6 });
  fc.setZoom(z); v.fc = fc; v.loading = true;
  hookCanvas(v);
  fc._mainView = true;
  fc.on('after:render', () => drawUnder(v));
  // nét vẽ (khung viền, đường kẻ…): chỉ chọn khi bấm trúng nét — bấm vào khoảng trống bên trong khung lớn
  // thì chọn được hình / chữ nằm trong đó, không bị khung viền ngoài cùng "chiếm" mất
  fc.on('object:added', e => { const o = e.target; if (o && (o.kind === 'vector' || (o.type === 'group' && o.getObjects().every(x => x.kind === 'vector' || x.type === 'path')))) o.perPixelTargetFind = true; });
  const objs = await enliven(v.page.objs);
  objs.forEach(o => { if (o.styles) clearOcrMarks(o); fc.add(o); });
  v.loading = false; fc.renderAll();
  applyToolTo(v); drawThumbOverlay(v.page.id); drawOcrFlags(v);
}
function curView() { const pg = S.pages[S.cur]; return pg && S.views.get(pg.id); }
function scrollToPage(i) {
  const pg = S.pages[i]; if (!pg) return;
  const v = S.views.get(pg.id); if (!v) return;
  $('#viewer').scrollTop = v.el.offsetTop - 14; setCurrent(i);
}
function setCurrent(i) {
  if (i === S.cur) return; S.cur = i;
  $$('.thumb').forEach((t, k) => t.classList.toggle('cur', k === i));
  $('#pgNum').value = i + 1;
  const t = $$('.thumb')[i]; if (t) { const box = $('#thumbs'); if (t.offsetTop < box.scrollTop || t.offsetTop > box.scrollTop + box.clientHeight - 60) box.scrollTop = t.offsetTop - 40; }
}
function onScroll() {
  const viewer = $('#viewer'); const mid = viewer.scrollTop + viewer.clientHeight * 0.35;
  let best = 0, bestTop = -1;
  // xem 2 trang cạnh nhau: 2 trang cùng hàng có cùng độ cao → lấy trang đầu hàng
  S.pages.forEach((pg, i) => { const v = S.views.get(pg.id); if (v && v.el.offsetTop <= mid && v.el.offsetTop > bestTop) { best = i; bestTop = v.el.offsetTop; } });
  setCurrent(best);
}
// anchor {x, y} (toạ độ màn hình): giữ đúng điểm đó của trang nằm yên dưới con trỏ sau khi phóng to / thu nhỏ;
// không có anchor thì giữ giữa vùng xem. fit = true: mức "vừa khung" (tự vừa lại khi đổi cỡ cột / cửa sổ)
function setZoom(z, anchor, fit) {
  if (!S.pages.length) return;
  const viewer = $('#viewer'), vr = viewer.getBoundingClientRect();
  const ax = anchor ? anchor.x : vr.left + vr.width / 2, ay = anchor ? anchor.y : vr.top + Math.min(vr.height / 2, 200);
  let keep = null;
  for (const v of S.views.values()) { const r = v.el.getBoundingClientRect(); if (ay >= r.top && ay <= r.bottom + 18) { keep = { id: v.page.id, fx: (ax - r.left) / r.width, fy: (ay - r.top) / r.height }; break; } }
  S.zoom = Math.max(0.25, Math.min(4, z)); S.fit = !!fit; rebuild(); updateUI();
  if (keep && S.views.get(keep.id)) {
    const r = S.views.get(keep.id).el.getBoundingClientRect();
    viewer.scrollTop += r.top + keep.fy * r.height - ay;
    viewer.scrollLeft += r.left + keep.fx * r.width - ax;
  }
}
const fitNow = () => setZoom(fitZoom(), null, true);

/* ---------------- thumbnail ---------------- */
function buildThumbs() {
  const box = $('#thumbs'); box.innerHTML = '';
  tio && tio.disconnect();
  tio = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) renderThumb(e.target.dataset.id); }), { root: box, rootMargin: '300px 0px' });
  S.thumbs.clear();
  S.pages.forEach((pg, i) => {
    const tw = thumbW(), [W, H] = dispSize(pg), s = tw / Math.max(W, H * 0.8);
    const d = document.createElement('div'); d.className = 'thumb'; d.dataset.id = pg.id; d.draggable = true; d.style.width = tw + 14 + 'px';
    d.classList.toggle('cur', i === S.cur); d.classList.toggle('sel', S.sel.has(pg.id));
    const cv = document.createElement('canvas'); cv.style.width = W * s + 'px'; cv.style.height = H * s + 'px';
    cv.width = Math.round(W * s * DPR); cv.height = Math.round(H * s * DPR);
    const n = document.createElement('div'); n.className = 'n'; n.textContent = i + 1;
    const tb = document.createElement('div'); tb.className = 'tb';
    tb.innerHTML = '<button data-a="l" title="Xoay trái">↺</button><button data-a="r" title="Xoay phải">↻</button><button data-a="d" title="Xoá trang">🗑</button>';
    d.append(cv, n, tb); box.appendChild(d);
    S.thumbs.set(pg.id, { el: d, cv, s, base: null, busy: false });
    tio.observe(d);
  });
}
async function renderThumb(id) {
  const t = S.thumbs.get(id); const pg = S.pages.find(p => p.id === id);
  if (!t || !pg || t.base || t.busy) return; t.busy = true;
  const base = document.createElement('canvas'); base.width = t.cv.width; base.height = t.cv.height;
  const ctx = base.getContext('2d');
  if (pg.src) {
    try { const p = await getJsPage(pg); await p.render({ canvasContext: ctx, viewport: p.getViewport({ scale: t.s * DPR, rotation: effRot(pg) }), background: 'rgba(0,0,0,0)' }).promise; }
    catch (e) { console.error(e); }
  }
  if (S.thumbs.get(id) !== t) return;
  t.base = base; t.busy = false; drawThumbOverlay(id);
}
function drawThumbOverlay(id) {
  const t = S.thumbs.get(id); if (!t || !t.base) return;
  const ctx = t.cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, t.cv.width, t.cv.height);
  const v = S.views.get(id);
  if (v && v.painted && v.split) { // trang đang tách lớp: ghép từ các lớp của trang
    ctx.drawImage(v.ub, 0, 0, t.cv.width, t.cv.height); ctx.drawImage(v.uc, 0, 0, t.cv.width, t.cv.height); ctx.drawImage(v.cv, 0, 0, t.cv.width, t.cv.height);
  } else {
    if (v && v.uc) ctx.drawImage(v.uc, 0, 0, t.cv.width, t.cv.height);
    ctx.drawImage(t.base, 0, 0);
  }
  if (v && v.fc) ctx.drawImage(v.fc.lowerCanvasEl, 0, 0, t.cv.width, t.cv.height);
}
function thumbsSelect(id, e) {
  const i = S.pages.findIndex(p => p.id === id);
  if (e.shiftKey && S.sel.size) {
    const idx = S.pages.map((p, k) => (S.sel.has(p.id) ? k : -1)).filter(k => k >= 0);
    const a = Math.min(i, ...idx), b = Math.max(i, ...idx);
    S.sel = new Set(S.pages.slice(a, b + 1).map(p => p.id));
  } else if (e.ctrlKey || e.metaKey) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); }
  else S.sel = new Set([id]);
  $$('.thumb').forEach(t => t.classList.toggle('sel', S.sel.has(t.dataset.id)));
  scrollToPage(i);
}
function targetPages() {
  if (S.sel.size) return S.pages.filter(p => S.sel.has(p.id));
  return S.pages[S.cur] ? [S.pages[S.cur]] : [];
}

/* ---------------- thao tác trang ---------------- */
function rotateObjs(pg, delta) {
  const [W, H] = dispSize(pg);
  for (const o of pg.objs) {
    const l = o.left || 0, t = o.top || 0;
    if (delta === 90) { o.left = H - t; o.top = l; } else { o.left = t; o.top = W - l; }
    o.angle = (((o.angle || 0) + delta) % 360 + 360) % 360;
  }
  pg.rot = ((pg.rot + delta) % 360 + 360) % 360;
}
function rotatePages(list, delta) { if (!list.length) return; list.forEach(pg => rotateObjs(pg, delta)); rebuild(); commit(); }
function deletePages(list) {
  if (!list.length) return;
  if (list.length >= S.pages.length) return toast('Không thể xoá hết tất cả trang');
  if (list.length > 1 && !confirm(`Xoá ${list.length} trang?`)) return;
  const ids = new Set(list.map(p => p.id));
  S.pages = S.pages.filter(p => !ids.has(p.id)); S.sel.clear(); rebuild(); commit();
}
function insertBlank() {
  const ref = S.pages[S.cur]; const pg = ref ? blankPage(...dispSize(ref)) : blankPage();
  const at = ref ? S.cur + 1 : 0;
  S.pages.splice(at, 0, pg); rebuild(); commit(); scrollToPage(at);
}
function duplicatePages(list) {
  if (!list.length) return;
  const last = S.pages.indexOf(list[list.length - 1]);
  const copies = list.map(p => ({ ...JSON.parse(JSON.stringify(p)), id: nid('p') }));
  S.pages.splice(last + 1, 0, ...copies); rebuild(); commit(); scrollToPage(last + 1);
}
function movePages(ids, beforeId) {
  const moving = S.pages.filter(p => ids.has(p.id)); if (!moving.length) return;
  const rest = S.pages.filter(p => !ids.has(p.id));
  let at = beforeId ? rest.findIndex(p => p.id === beforeId) : rest.length; if (at < 0) at = rest.length;
  rest.splice(at, 0, ...moving); S.pages = rest; rebuild(); commit();
}
function parseRanges(str, n) {
  const out = [];
  for (const part of str.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/); if (!m) return null;
    let a = +m[1], b = m[2] ? +m[2] : a; if (a > b) [a, b] = [b, a];
    for (let i = a; i <= b; i++) if (i >= 1 && i <= n && !out.includes(i - 1)) out.push(i - 1);
  }
  return out;
}
function rangeText(idx) {
  const r = []; let i = 0; idx = [...idx].sort((a, b) => a - b);
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++; r.push(i === j ? `${idx[i] + 1}` : `${idx[i] + 1}-${idx[j] + 1}`); i = j + 1; }
  return r.join(', ');
}
async function extractPages() {
  if (!S.pages.length) return;
  const def = S.sel.size ? rangeText(S.pages.map((p, k) => (S.sel.has(p.id) ? k : -1)).filter(k => k >= 0)) : `${S.cur + 1}`;
  const s = prompt(`Nhập các trang cần trích (vd: 1-3, 5, 8). Tổng ${S.pages.length} trang:`, def);
  if (s == null) return;
  const idx = parseRanges(s, S.pages.length);
  if (!idx || !idx.length) return toast('Khoảng trang không hợp lệ');
  busy(true, 'Đang tạo PDF…');
  try { const bytes = await buildPdf(idx.map(i => S.pages[i]), { final: true }); downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${baseName()}-trang-${s.replace(/[^\d,-]+/g, '_')}.pdf`); }
  catch (e) { console.error(e); alert('Lỗi khi tạo PDF: ' + e.message); }
  finally { busy(false); }
}
async function exportPng() {
  const v = curView(); if (!v) return;
  busy(true, 'Đang xuất ảnh…');
  try {
    const pg = v.page, [W, H] = dispSize(pg), sc = 2.5; // ~180 dpi
    const c = document.createElement('canvas'); c.width = Math.round(W * sc); c.height = Math.round(H * sc);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    // thứ tự: nền trắng -> đối tượng "dưới nội dung PDF" -> trang PDF -> các đối tượng còn lại
    const objs = await enliven(pg.objs);
    const layer = list => { const sfc = new fabric.StaticCanvas(null, { width: c.width, height: c.height, enableRetinaScaling: false }); sfc.setZoom(sc); list.forEach(o => sfc.add(o)); sfc.renderAll(); ctx.drawImage(sfc.lowerCanvasEl, 0, 0); sfc.dispose(); };
    const Ls = pg.src ? await getJsLayers(pg) : { bg: null, fg: null };
    const pdfLayer = async (p, extra) => { if (!p) return; const pc = document.createElement('canvas'); pc.width = c.width; pc.height = c.height; await p.render({ canvasContext: pc.getContext('2d'), viewport: p.getViewport({ scale: sc, rotation: effRot(pg) }), background: 'rgba(0,0,0,0)', ...(extra || {}) }).promise; ctx.drawImage(pc, 0, 0); };
    await pdfLayer(Ls.bg, { annotationMode: pdfjsLib.AnnotationMode.DISABLE });
    layer(objs.filter(o => o.under));
    await pdfLayer(Ls.fg);
    layer(objs.filter(o => !o.under).map(o => { o.under = false; return o; }));
    c.toBlob(b => downloadBlob(b, `${baseName()}-trang-${S.cur + 1}.png`), 'image/png');
  } finally { busy(false); }
}

/* ---------------- công cụ & canvas ---------------- */
const SHAPES = ['rect', 'ellipse', 'line', 'arrow', 'highlight', 'whiteout', 'region', 'erase', 'redact'];
const HINTS = {
  select: 'Chọn đối tượng: bấm vào ảnh, hình, chữ đã thêm… để di chuyển, đổi kích thước, xoay. Kéo khung để chọn nhiều. Bấm đúp vào nội dung gốc của PDF để tách ra sửa. Delete để xoá, Ctrl+C / Ctrl+V để chép. (Muốn bôi đen chữ: dùng "Chọn chữ".)',
  textsel: 'Chọn chữ: kéo chuột để bôi đen chữ trong PDF, Ctrl+C để copy (dán sang file khác vẫn giữ phông, cỡ, màu). Bấm đúp vào chữ để sửa. Không chọn nhầm ảnh / hình.',
  edittext: 'Rê chuột lên chữ, ảnh, đường kẻ, khung bảng, hình vẽ có sẵn trong PDF — phần sửa được hiện khung xanh. Bấm để tách ra sửa (di chuyển, đổi màu, độ dày, xoá, Ctrl+C copy). Kéo một khung để tách cả bảng / cụm hình. Giữ Alt khi bấm để bỏ qua chữ và chọn hình / ảnh nằm bên dưới. Hình mờ & lớp ẩn: nút "💧 Hình mờ & lớp ẩn" bên trái.',
  text: 'Bấm vào vị trí trên trang rồi gõ chữ (hỗ trợ tiếng Việt). Enter để xuống dòng, bấm ra ngoài để xong.',
  draw: 'Giữ chuột và vẽ tự do. Chọn màu và độ dày nét ở bên phải.',
  highlight: 'Kéo chuột qua vùng cần tô sáng.',
  rect: 'Kéo chuột để vẽ khung. Giữ Shift để thành hình vuông.',
  ellipse: 'Kéo chuột để vẽ elip. Giữ Shift để thành hình tròn.',
  line: 'Kéo chuột để vẽ đường thẳng. Giữ Shift để thẳng góc 45°.',
  arrow: 'Kéo chuột để vẽ mũi tên. Giữ Shift để thẳng góc 45°.',
  whiteout: 'Kéo chuột che vùng muốn xoá bằng ô trắng (có thể đổi màu nền ở bên phải).',
  erase: 'Tẩy trên ảnh: kéo khung trên ảnh đã tách để xoá vùng đó (thành trong suốt) — vd xoá hình mờ ở giữa ảnh nền mà vẫn giữ viền. Kéo nhiều lần được. Esc để xong.',
  measure: 'Đo: kéo chuột từ điểm đầu tới điểm cuối — hiện chiều dài (mm), phần ngang và đứng. Giữ Shift để đo thẳng ngang / đứng / 45°. Bản vẽ thu nhỏ: bấm "Đặt kích thước thật…" sau khi đo 1 kích thước đã biết (hoặc nhập tỉ lệ 1:N). "Ghi lên bản vẽ" để lưu số đo vào file. Phóng to để đo chính xác hơn.',
  region: 'Kéo khung quanh vùng cần copy (cả hình vẽ, chữ, logo…). Sau đó chuyển sang tab file khác và bấm Ctrl+V — vùng được dán đúng vị trí, giữ nét vector khi lưu.',
};
function setTool(t) {
  if (t !== 'measure' && window.PdfExtra) PdfExtra.clearMeasure();
  S.tool = t;
  $$('#tools [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  for (const v of S.views.values()) applyToolTo(v);
  refreshProps();
}
function applyToolTo(v) {
  const fc = v && v.fc; if (!fc) return;
  const t = S.tool;
  fc.wrapperEl.style.pointerEvents = t === 'textsel' ? 'none' : '';
  if (v.tl) v.tl.classList.toggle('active', t === 'textsel');
  if (t !== 'textsel') { const sel = window.getSelection(); if (sel && !sel.isCollapsed && v.tl && sel.rangeCount && sel.getRangeAt(0).intersectsNode(v.tl)) sel.removeAllRanges(); }
  fc.isDrawingMode = t === 'draw';
  if (fc.isDrawingMode) {
    fc.freeDrawingBrush = new fabric.PencilBrush(fc);
    fc.freeDrawingBrush.color = S.style.color; fc.freeDrawingBrush.width = S.style.stroke;
    fc.freeDrawingBrush.decimate = 0.6;
  }
  const interactive = t === 'select' || t === 'text';
  fc.selection = t === 'select';
  fc.skipTargetFind = !interactive;
  fc.defaultCursor = t === 'select' ? 'default' : (t === 'text' || t === 'edittext') ? 'text' : 'crosshair';
  if (!interactive && fc.getActiveObject()) { fc.discardActiveObject(); fc.requestRenderAll(); }
}
function deselectOthers(v) {
  for (const o of S.views.values()) if (o !== v && o.fc && o.fc.getActiveObject()) { o.fc.discardActiveObject(); o.fc.requestRenderAll(); }
}
function hookCanvas(v) {
  const fc = v.fc;
  fc.on('object:modified', () => syncView(v));
  fc.on('path:created', e => { e.path.set({ kind: 'ink', fill: null, strokeLineCap: 'round', strokeLineJoin: 'round', opacity: S.style.opacity }); syncView(v); });
  fc.on('text:editing:exited', e => { const t = e.target; if (window.PdfExtra) PdfExtra.closePanel(); if (t) clearOcrMarks(t); if (t && !t.text.trim()) fc.remove(t); fc.requestRenderAll(); syncView(v); if (t && t.ocrSrc && t.text.trim()) ocrRestyle(v, t); });
  const sel = () => { S.activeView = v; deselectOthers(v); refreshProps(); };
  fc.on('selection:created', sel); fc.on('selection:updated', sel);
  fc.on('selection:cleared', () => { if (S.activeView === v) S.activeView = null; refreshProps(); });
  fc.on('mouse:down', e => onDown(v, e));
  fc.on('mouse:move', e => { const p = fc.getPointer(e.e); S.mouse = { id: v.page.id, x: p.x, y: p.y }; onMove(v, e); });
  fc.on('object:moving', () => clearSelBox()); // đang kéo đối tượng đi chỗ khác → bỏ khung vùng
  fc.on('mouse:out', () => { if (S.mouse && S.mouse.id === v.page.id) S.mouse = null; });
  fc.on('mouse:up', e => onUp(v, e));
  fc.on('mouse:out', () => showHover(v, null));
  // chế độ Chọn: bấm đúp vào chữ gốc của PDF để sửa luôn
  fc.on('mouse:dblclick', e => { if (S.tool === 'select' && !e.target && v.page.src) editAt(v, fc.getPointer(e.e)); });
}
/* ---------- lớp chữ trong suốt của pdf.js: công cụ Chọn quét được chữ để bôi đen / sao chép (Ctrl+C) ---------- */
async function renderTextLayer(v) {
  const pg = v.page; if (!pg.src) return;
  const token = (v.tlToken = (v.tlToken || 0) + 1);
  try {
    const p = await getJsPage(pg);
    const tc = await p.getTextContent();
    if (S.views.get(pg.id) !== v || token !== v.tlToken) return;
    const div = document.createElement('div'); div.className = 'textLayer';
    div.style.setProperty('--scale-factor', S.zoom);
    const textDivs = [];
    await pdfjsLib.renderTextLayer({ textContentSource: tc, container: div, viewport: p.getViewport({ scale: S.zoom, rotation: effRot(pg) }), textDivs }).promise;
    if (token !== v.tlToken) return;
    // ghép từng <span> với mảnh chữ của pdf.js (để copy giữ định dạng)
    const vp1 = p.getViewport({ scale: 1, rotation: effRot(pg) }); const map = []; let k = 0;
    for (const it of tc.items) {
      if (it.str === undefined) continue;
      const dv = textDivs[k]; if (!dv) break;
      if (dv.textContent !== it.str) continue;
      k++;
      const tx = pdfjsLib.Util.transform(vp1.transform, it.transform);
      const fh = Math.hypot(tx[2], tx[3]), sc = Math.hypot(tx[0], tx[1]); if (fh < 1 || !sc) continue;
      map.push({ div: dv, a: { it, ox: tx[4], oy: tx[5], ux: tx[0] / sc, uy: tx[1] / sc, ang: Math.atan2(tx[1], tx[0]), fh, w: it.width } });
    }
    v.tlMap = map; v.tlP = p;
    if (v.tl) v.tl.remove();
    v.el.insertBefore(div, v.cv.nextSibling); v.tl = div; v.spanRects = null;
    div.classList.toggle('active', S.tool === 'textsel');
    div.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      S.textSelecting = v; S.focus = 'canvas'; deselectOthers(null);
      const i = S.pages.indexOf(v.page); if (i >= 0) setCurrent(i);
      if (e.detail > 1) return; // bấm đúp / bấm ba: để trình duyệt chọn từ / dòng
      // tự xử lý kéo bôi đen: bắt đầu ở khoảng trống cạnh chữ vẫn bôi được (giống Acrobat)
      e.preventDefault();
      const spans = [...div.querySelectorAll('span')].filter(s => s.firstChild && s.textContent.length).map(s => ({ s, r: s.getBoundingClientRect() }));
      if (!spans.length) return;
      const caret = (x, y) => {
        let best = null, bd = Infinity;
        for (const o of spans) {
          const { r } = o, dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0, dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
          const d = dy * 4 + dx; if (d < bd) { bd = d; best = o; }
        }
        const { s, r } = best, node = s.firstChild, len = node.length;
        if (y < r.top - r.height * 1.5 && x < r.left) return [node, 0];
        if (x <= r.left) return [node, 0];
        if (x >= r.right) return [node, len];
        const cr = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, r.top + r.height / 2) : null;
        if (cr && cr.startContainer === node) return [node, cr.startOffset];
        return [node, Math.round(len * (x - r.left) / (r.width || 1))];
      };
      const sel = window.getSelection(), a = caret(e.clientX, e.clientY);
      sel.removeAllRanges(); const rg = document.createRange(); rg.setStart(a[0], a[1]); rg.collapse(true); sel.addRange(rg);
      const move = ev => { const b = caret(ev.clientX, ev.clientY); try { sel.setBaseAndExtent(a[0], a[1], b[0], b[1]); } catch (err) {} };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    div.addEventListener('dblclick', e => {
      if (S.tool !== 'textsel') return;
      const r = v.el.getBoundingClientRect();
      window.getSelection().removeAllRanges(); S.textSelecting = null;
      v.fc.wrapperEl.style.pointerEvents = '';
      editAt(v, { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom });
    });
  } catch (e) { console.warn('textLayer', e); }
}
function overText(v, x, y) {
  if (!v.tl) return false;
  if (!v.spanRects) { const er = v.el.getBoundingClientRect(); v.spanRects = [...v.tl.querySelectorAll('span')].filter(s => s.textContent.trim()).map(s => { const r = s.getBoundingClientRect(); return [r.left - er.left, r.top - er.top, r.right - er.left, r.bottom - er.top]; }); }
  return v.spanRects.some(r => x >= r[0] - 1 && x <= r[2] + 1 && y >= r[1] - 1 && y <= r[3] + 1);
}
/* Công cụ "Chọn chữ": chuột đi thẳng xuống lớp chữ (bôi đen / Ctrl+C), các đối tượng không bị chọn nhầm.
   Công cụ "Chọn đối tượng": chỉ chọn đối tượng (ảnh, hình, chữ đã thêm…), không bôi đen chữ. */
function hookTextSelect(v) {
  if (v.fc) v.fc.wrapperEl.style.pointerEvents = S.tool === 'textsel' ? 'none' : '';
}
document.addEventListener('mouseup', () => { if (S.textSelecting) setTimeout(() => { S.textSelecting = null; }, 0); });

function onDown(v, e) {
  clearSelBox();
  if (!S.textSelecting) { const sel = window.getSelection(); if (sel && !sel.isCollapsed) sel.removeAllRanges(); }
  const i = S.pages.indexOf(v.page); if (i >= 0) setCurrent(i);
  deselectOthers(v);
  const t = S.tool, p = v.fc.getPointer(e.e), st = S.style;
  v.selStart = t === 'select' && !e.target && v.page.src ? p : null;
  if (t === 'text') { if (e.target) return; addText(v, p); return; }
  if (t === 'edittext') {
    // bấm = sửa chữ / ảnh / nét vẽ tại điểm đó; kéo khung = tách mọi nét vẽ + ảnh trong khung (vd cả bảng)
    const o = new fabric.Rect({ left: p.x, top: p.y, originX: 'left', originY: 'top', width: 1, height: 1, fill: 'rgba(26,115,232,0.06)', stroke: '#1a73e8', strokeWidth: 1, strokeDashArray: [4, 3], strokeUniform: true, kind: 'temp' });
    v.drag = { o, x: p.x, y: p.y, t: 'editbox', alt: e.e.altKey };
    v.loading = true; v.fc.add(o); v.loading = false;
    showHover(v, null);
    return;
  }
  if (t === 'measure') { if (window.PdfExtra) PdfExtra.measureDown(v, p, e); return; }
  if (!SHAPES.includes(t)) return;
  const base = { left: p.x, top: p.y, originX: 'left', originY: 'top', kind: t, opacity: st.opacity };
  let o;
  if (t === 'erase') o = new fabric.Rect({ ...base, width: 1, height: 1, fill: 'rgba(255,255,255,0.55)', stroke: '#d93025', strokeWidth: 1, strokeDashArray: [5, 4], strokeUniform: true, opacity: 1 });
  else if (t === 'redact') o = new fabric.Rect({ ...base, width: 1, height: 1, fill: 'rgba(0,0,0,0.35)', stroke: '#d93025', strokeWidth: 1, strokeDashArray: [5, 4], strokeUniform: true, opacity: 1 });
  else if (t === 'region') o = new fabric.Rect({ ...base, width: 1, height: 1, fill: 'rgba(26,115,232,0.08)', stroke: '#1a73e8', strokeWidth: 1, strokeDashArray: [5, 4], strokeUniform: true, opacity: 1 });
  else if (t === 'rect') o = new fabric.Rect({ ...base, width: 1, height: 1, fill: st.fill || 'transparent', stroke: st.color, strokeWidth: st.stroke, strokeUniform: true });
  else if (t === 'highlight') o = new fabric.Rect({ ...base, width: 1, height: 1, fill: st.hl, strokeWidth: 0, opacity: 0.45, globalCompositeOperation: 'multiply' });
  else if (t === 'whiteout') o = new fabric.Rect({ ...base, width: 1, height: 1, fill: st.fill || '#ffffff', strokeWidth: 0, opacity: 1 });
  else if (t === 'ellipse') o = new fabric.Ellipse({ ...base, rx: 0.5, ry: 0.5, fill: st.fill || 'transparent', stroke: st.color, strokeWidth: st.stroke, strokeUniform: true });
  else o = new fabric.Line([p.x, p.y, p.x, p.y], { kind: t, stroke: st.color, strokeWidth: st.stroke, strokeLineCap: 'round', opacity: st.opacity });
  v.drag = { o, x: p.x, y: p.y, t };
  v.loading = true; v.fc.add(o); v.loading = false;
}
function onMove(v, e) {
  const d = v.drag;
  if (!d) {
    if (S.tool === 'measure') { if (window.PdfExtra) PdfExtra.measureMove(v, v.fc.getPointer(e.e), e); return; }
    if (S.tool === 'edittext' && v.page.src) hoverText(v, v.fc.getPointer(e.e));
    else if (v.hov && v.hov.style.display !== 'none') showHover(v, null);
    return;
  }
  const p = v.fc.getPointer(e.e); let dx = p.x - d.x, dy = p.y - d.y;
  if (d.t === 'line' || d.t === 'arrow') {
    if (e.e.shiftKey) { const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), r = Math.hypot(dx, dy); dx = r * Math.cos(a); dy = r * Math.sin(a); }
    d.o.set({ x2: d.x + dx, y2: d.y + dy });
  } else {
    if (e.e.shiftKey && (d.t === 'rect' || d.t === 'ellipse')) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
    const left = Math.min(d.x, d.x + dx), top = Math.min(d.y, d.y + dy), w = Math.abs(dx), h = Math.abs(dy);
    if (d.t === 'ellipse') d.o.set({ left, top, rx: Math.max(0.5, w / 2), ry: Math.max(0.5, h / 2) });
    else d.o.set({ left, top, width: Math.max(1, w), height: Math.max(1, h) });
  }
  d.o.setCoords(); v.fc.requestRenderAll();
}
function onUp(v, e) {
  if (S.tool === 'measure') { if (window.PdfExtra) PdfExtra.measureUp(v, e && e.e ? v.fc.getPointer(e.e) : null, e); return; }
  if (v.selStart && S.tool === 'select') { // Chọn đối tượng: bấm / kéo khung trên nội dung gốc của PDF
    const s = v.selStart; v.selStart = null;
    const p = e && e.e ? v.fc.getPointer(e.e) : s;
    const box = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
    if (box.w * S.zoom < 5 && box.h * S.zoom < 5) pickAt(v, s); else selectBox(v, box);
    return;
  }
  const d = v.drag; if (!d) return; v.drag = null;
  const o = d.o, fc = v.fc;
  if (d.t === 'editbox') {
    v.loading = true; fc.remove(o); v.loading = false; fc.requestRenderAll();
    if (o.width < 4 && o.height < 4) editAt(v, { x: d.x, y: d.y }, d.alt);
    else extractBox(v, { x: o.left, y: o.top, w: o.width, h: o.height });
    return;
  }
  if (d.t === 'erase') {
    v.loading = true; fc.remove(o); v.loading = false; fc.requestRenderAll();
    if (o.width >= 2 && o.height >= 2) eraseAt(v, o.left, o.top, o.width, o.height);
    return;
  }
  const tiny = (d.t === 'line' || d.t === 'arrow') ? Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 4 : (o.getScaledWidth() < 4 && o.getScaledHeight() < 4);
  if (tiny) { v.loading = true; fc.remove(o); v.loading = false; fc.requestRenderAll(); return; }
  if (d.t === 'redact') { // Che thông tin: xoá hẳn nội dung trong khung + phủ đen (tools.js)
    v.loading = true; fc.remove(o); v.loading = false; fc.requestRenderAll();
    PdfTools.redact(v, { x: Math.max(0, o.left), y: Math.max(0, o.top), w: o.width, h: o.height });
    return;
  }
  if (d.t === 'region') {
    const box = { x: Math.max(0, o.left), y: Math.max(0, o.top), w: o.width, h: o.height };
    v.loading = true; fc.remove(o); v.loading = false; fc.requestRenderAll();
    const [W, H] = dispSize(v.page); box.w = Math.min(box.w, W - box.x); box.h = Math.min(box.h, H - box.y);
    copyRegion(v, box);
    return;
  }
  if (d.t === 'arrow') {
    const { x1, y1, x2, y2 } = o, a = Math.atan2(y2 - y1, x2 - x1), hl = Math.max(9, o.strokeWidth * 4), sp = 0.45;
    const h1 = [x2 - hl * Math.cos(a - sp), y2 - hl * Math.sin(a - sp)], h2 = [x2 - hl * Math.cos(a + sp), y2 - hl * Math.sin(a + sp)];
    const path = new fabric.Path(`M ${x1} ${y1} L ${x2} ${y2} M ${h1[0]} ${h1[1]} L ${x2} ${y2} L ${h2[0]} ${h2[1]}`,
      { stroke: o.stroke, strokeWidth: o.strokeWidth, fill: null, strokeLineCap: 'round', strokeLineJoin: 'round', opacity: o.opacity, kind: 'arrow', objectCaching: false });
    v.loading = true; fc.remove(o); fc.add(path); v.loading = false;
  }
  fc.requestRenderAll(); syncView(v);
}
function addText(v, p, text = '') {
  const st = S.style;
  const t = new fabric.IText(text, { left: p.x, top: p.y - st.size * 0.6, fontFamily: st.font, fontSize: st.size, fill: st.color,
    fontWeight: st.bold ? 'bold' : 'normal', fontStyle: st.italic ? 'italic' : 'normal', textAlign: st.align, opacity: st.opacity, kind: 'text' });
  v.loading = true; v.fc.add(t); v.loading = false;
  setTool('select'); v.fc.setActiveObject(t); t.enterEditing(); v.fc.requestRenderAll();
  return t;
}
/* Chữ gốc trong trang: mỗi mảnh có hệ trục riêng (gốc = điểm đầu đường chân chữ, u = hướng viết, n = hướng xuống)
   → sửa được cả chữ nằm ngang, xoay dọc hay xoay nghiêng (vd kích thước trong bản vẽ). */
function pageTextItems(v) {
  if (v.titems) return v.titems;
  v.titems = (async () => {
    const pg = v.page, p = await getJsPage(pg);
    const vp = p.getViewport({ scale: 1, rotation: effRot(pg) });
    const tc = await p.getTextContent(); v.tc = tc;
    const items = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      const fh = Math.hypot(tx[2], tx[3]), sc = Math.hypot(tx[0], tx[1]); if (fh < 1 || !sc) continue;
      const ux = tx[0] / sc, uy = tx[1] / sc;
      // sx: độ giãn ngang của chữ (ma trận chữ Tm / Tz kéo dài ngang so với chiều cao) — vd khung tên AutoCAD xuất PDF
      items.push({ it, ox: tx[4], oy: tx[5], ux, uy, ang: Math.atan2(uy, ux), fh, w: it.width, sx: sc / fh });
    }
    const res = { p, vp, items }; v.titemsVal = res; return res;
  })();
  return v.titems;
}
const toLocal = (a, x, y) => [(x - a.ox) * a.ux + (y - a.oy) * a.uy, -(x - a.ox) * a.uy + (y - a.oy) * a.ux];
const toDisp = (a, lx, ly) => [a.ox + a.ux * lx - a.uy * ly, a.oy + a.uy * lx + a.ux * ly];
const sameDir = (a, b) => Math.abs(Math.atan2(Math.sin(a.ang - b.ang), Math.cos(a.ang - b.ang))) < 0.03;
function findRun(T, pt) {
  let hit = null, best = Infinity;
  for (const a of T.items) {
    if (!a.it.str.trim()) continue;
    const [lx, ly] = toLocal(a, pt.x, pt.y);
    const dx = lx < 0 ? -lx : lx > a.w ? lx - a.w : 0;
    const top = -a.fh * 0.95, bot = a.fh * 0.3;
    const dy = ly < top ? top - ly : ly > bot ? ly - bot : 0;
    const d = Math.hypot(dx, dy), tol = Math.max(a.fh * 0.6, 6 / S.zoom);
    if (d <= tol && d < best) { best = d; hit = a; }
  }
  if (!hit) return null;
  // các mảnh cùng hướng, cùng đường chân chữ, liền nhau -> một dòng
  // (bỏ các mảnh chỉ có khoảng trắng — pdf.js chèn chúng vào khe giữa các ô bảng, sẽ nối nhầm nhiều ô thành một dòng)
  const line = T.items.filter(a => a.it.str.trim() && sameDir(a, hit) && Math.abs(a.fh - hit.fh) < hit.fh * 0.3)
    .map(a => { const [x, y] = toLocal(hit, a.ox, a.oy); return { a, x, y, w: a.w }; })
    .filter(o => Math.abs(o.y) < hit.fh * 0.25).sort((p, q) => p.x - q.x);
  const k = line.findIndex(o => o.a === hit); let lo = k, hi = k;
  while (lo > 0 && line[lo].x - (line[lo - 1].x + line[lo - 1].w) < hit.fh * 0.8) lo--;
  while (hi < line.length - 1 && line[hi + 1].x - (line[hi].x + line[hi].w) < hit.fh * 0.8) hi++;
  let str = '';
  for (let i = lo; i <= hi; i++) {
    if (i > lo) { const gap = line[i].x - (line[i - 1].x + line[i - 1].w); if (gap > hit.fh * 0.15 && !/\s$/.test(str) && !/^\s/.test(line[i].a.it.str)) str += ' '; }
    str += line[i].a.it.str;
  }
  return { hit, str: str.replace(/\s+$/, ''), x0: line[lo].x, x1: line[hi].x + line[hi].w };
}
function showHover(v, run) {
  if (!v.hov) { v.hov = document.createElement('div'); v.hov.className = 'txt-hover'; v.el.appendChild(v.hov); }
  if (!run) { v.hov.style.display = 'none'; return; }
  const z = S.zoom, { hit, x0, x1 } = run, fh = hit.fh;
  const [X, Y] = toDisp(hit, x0 - 1.5, -fh * 0.98);
  Object.assign(v.hov.style, { display: 'block', left: X * z + 'px', top: Y * z + 'px', width: (x1 - x0 + 3) * z + 'px', height: fh * 1.3 * z + 'px', transform: `rotate(${hit.ang}rad)` });
}
function hoverText(v, pt, noText) {
  const T = v.titemsVal; if (!T) { pageTextItems(v); return; }
  const run = altDown || noText ? null : findRun(T, pt);
  if (run) return showHover(v, run);
  const ol = altDown || noText ? null : findOcr(v.page, pt);
  if (ol) return showOcrHover(v, ol);
  const I = v.imgsVal, V = v.vecsVal;
  if (!I) pageImageItems(v); if (!V) pageVectorItems(v);
  if (!I || !V) return showHover(v, null);
  const r = findVector(V, pt), im0 = findImage(I, pt);
  if (r && r.big && noText) return showHover(v, null); // khung viền lớn của trang (Chọn đối tượng): không tô khung xanh
  if (r && (!r.big || !im0)) { // khung quanh nét vẽ
    const z = S.zoom, b = r.dbb, pad = Math.max(1.5, r.lw / 2 + 1);
    if (!v.hov) { v.hov = document.createElement('div'); v.hov.className = 'txt-hover'; v.el.appendChild(v.hov); }
    return Object.assign(v.hov.style, { display: 'block', left: (b.x0 - pad) * z + 'px', top: (b.y0 - pad) * z + 'px', width: (b.x1 - b.x0 + 2 * pad) * z + 'px', height: (b.y1 - b.y0 + 2 * pad) * z + 'px', transform: 'none' });
  }
  const im = im0;
  if (!im) return showHover(v, null);
  // khung quanh ảnh (hình bình hành P0-P1-P3)
  const z = S.zoom, { P0, P1, P3 } = im, wl = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]), hl = Math.hypot(P3[0] - P0[0], P3[1] - P0[1]);
  const ang = Math.atan2(P1[1] - P0[1], P1[0] - P0[0]), cross = (P1[0] - P0[0]) * (P3[1] - P0[1]) - (P1[1] - P0[1]) * (P3[0] - P0[0]);
  const A = cross >= 0 ? P0 : P3;
  if (!v.hov) { v.hov = document.createElement('div'); v.hov.className = 'txt-hover'; v.el.appendChild(v.hov); }
  Object.assign(v.hov.style, { display: 'block', left: A[0] * z + 'px', top: A[1] * z + 'px', width: wl * z + 'px', height: hl * z + 'px', transform: `rotate(${ang}rad)` });
}

/* ---------------- ảnh có sẵn trong PDF: tìm, tách ra để sửa / copy ---------------- */
function pageImageItems(v) {
  if (v.imgs) return v.imgs;
  v.imgs = (async () => {
    const pg = v.page, p = await getJsPage(pg), vp = p.getViewport({ scale: 1, rotation: effRot(pg) });
    const ol = await p.getOperatorList(), O = pdfjsLib.OPS, U = pdfjsLib.Util;
    const list = []; let ctm = [1, 0, 0, 1, 0, 0]; const st = [];
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], a = ol.argsArray[i];
      if (fn === O.save) st.push(ctm);
      else if (fn === O.restore) ctm = st.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === O.transform) ctm = U.transform(ctm, a);
      else if (fn === O.paintFormXObjectBegin) { st.push(ctm); if (a && a[0]) ctm = U.transform(ctm, a[0]); }
      else if (fn === O.paintFormXObjectEnd) ctm = st.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject) {
        const toD = (x, y) => vp.convertToViewportPoint(...U.applyTransform([x, y], ctm));
        const us = [[0, 0], [1, 0], [0, 1], [1, 1]].map(q => U.applyTransform(q, ctm));
        const bb = { img: true, x0: Math.min(...us.map(q => q[0])), y0: Math.min(...us.map(q => q[1])), x1: Math.max(...us.map(q => q[0])), y1: Math.max(...us.map(q => q[1])) };
        if (bb.x1 - bb.x0 < 2 || bb.y1 - bb.y0 < 2) continue;
        list.push({ objId: fn === O.paintImageXObject ? a[0] : null, inline: fn === O.paintInlineImageXObject ? a[0] : null, P0: toD(0, 1), P1: toD(1, 1), P3: toD(0, 0), bb });
      }
    }
    const res = { p, list }; v.imgsVal = res; return res;
  })();
  return v.imgs;
}
function isBigImage(v, im) {
  const [W, H] = dispSize(v.page), { P0, P1, P3 } = im;
  return Math.abs((P1[0] - P0[0]) * (P3[1] - P0[1]) - (P1[1] - P0[1]) * (P3[0] - P0[0])) > W * H * 0.5;
}
function findImage(I, pt) {
  for (let i = I.list.length - 1; i >= 0; i--) { // ảnh vẽ sau nằm trên
    const im = I.list[i], { P0, P1, P3 } = im;
    const ax = P1[0] - P0[0], ay = P1[1] - P0[1], bx = P3[0] - P0[0], by = P3[1] - P0[1], det = ax * by - ay * bx;
    if (!det) continue;
    const dx = pt.x - P0[0], dy = pt.y - P0[1], u = (dx * by - dy * bx) / det, w = (ax * dy - ay * dx) / det;
    if (u >= 0 && u <= 1 && w >= 0 && w <= 1) return im;
  }
  return null;
}
async function imageCanvas(p, im) {
  let d = im.inline;
  if (!d) { const store = String(im.objId).startsWith('g_') ? p.commonObjs : p.objs; d = await new Promise(res => store.get(im.objId, res)); }
  const c = document.createElement('canvas'); c.width = d.width; c.height = d.height; const x = c.getContext('2d');
  if (d.bitmap) { x.drawImage(d.bitmap, 0, 0); return c; }
  const id = x.createImageData(d.width, d.height), o = id.data, s = d.data, K = pdfjsLib.ImageKind;
  if (d.kind === K.RGBA_32BPP) o.set(s.subarray(0, o.length));
  else if (d.kind === K.RGB_24BPP) { for (let i = 0, j = 0; i < o.length; i += 4, j += 3) { o[i] = s[j]; o[i + 1] = s[j + 1]; o[i + 2] = s[j + 2]; o[i + 3] = 255; } }
  else if (d.kind === K.GRAYSCALE_1BPP) {
    const rowBytes = (d.width + 7) >> 3;
    for (let y = 0; y < d.height; y++) for (let xx = 0; xx < d.width; xx++) { const bit = (s[y * rowBytes + (xx >> 3)] >> (7 - (xx & 7))) & 1, i = (y * d.width + xx) * 4, val = bit ? 255 : 0; o[i] = o[i + 1] = o[i + 2] = val; o[i + 3] = 255; }
  }
  x.putImageData(id, 0, 0); return c;
}
function canvasToUrl(c) {
  // ảnh không trong suốt -> JPEG cho nhẹ; có trong suốt -> PNG
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let alpha = false;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) { alpha = true; break; }
  return alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92);
}
async function editImageAt(v, pt) {
  const pg = v.page; if (!pg.src) return false;
  const I = await pageImageItems(v); const im = findImage(I, pt);
  if (!im) return false;
  showHover(v, null);
  busy(true, 'Đang tách ảnh…');
  try {
    const c = await imageCanvas(I.p, im);
    const url = canvasToUrl(c);
    const { P0, P1, P3 } = im;
    const wv = [P1[0] - P0[0], P1[1] - P0[1]], hv = [P3[0] - P0[0], P3[1] - P0[1]];
    const cross = wv[0] * hv[1] - wv[1] * hv[0], A = cross >= 0 ? P0 : P3;
    // gỡ ảnh gốc khỏi trang (kiểm tra trước là gỡ được)
    let ok = false;
    try { const lib = await getLib(pg.src); ok = TextOps.analyze(lib, lib.getPage(pg.index), [im.bb]).some(h => h.img); } catch (e) { console.warn(e); }
    if (ok) pg.del = (pg.del || []).concat([im.bb]);
    const img = await new Promise(res => fabric.Image.fromURL(url, res));
    img.set({ left: A[0], top: A[1], originX: 'left', originY: 'top', angle: Math.atan2(wv[1], wv[0]) * 180 / Math.PI,
      scaleX: Math.hypot(...wv) / c.width, scaleY: Math.hypot(...hv) / c.height, flipY: cross < 0, kind: 'image' });
    setTool('select');
    v.loading = true; v.fc.add(img); v.loading = false;
    v.fc.setActiveObject(img); v.fc.requestRenderAll(); syncView(v);
    S.activeView = v; refreshProps();
    if (ok) { v.tc = null; v.titems = null; v.titemsVal = null; v.imgs = null; v.imgsVal = null; v.vecs = null; v.vecsVal = null; await refreshPdfLayer(v); }
    toast(ok ? 'Đã tách ảnh: kéo để di chuyển, kéo góc để đổi cỡ, Delete để xoá, Ctrl+C để copy sang file khác' : 'Ảnh gốc không gỡ được khỏi trang — đã đặt bản sao lên trên', 4000);
  } catch (e) { console.error(e); toast('Không lấy được ảnh này'); }
  finally { busy(false); }
  return true;
}
/* ---------------- nét vẽ có sẵn (đường kẻ, bảng, khung, hình, logo vector) ---------------- */
function pageVectorItems(v) {
  if (v.vecs) return v.vecs;
  v.vecs = (async () => {
    const pg = v.page, p = await getJsPage(pg), vp = p.getViewport({ scale: 1, rotation: effRot(pg) });
    const lib = await getLib(pg.src);
    const done = (pg.del || []).filter(r => r.vec);
    const same = (r, b) => r.n === b.n && Math.abs(r.x0 - b.bb.x0) < 0.6 && Math.abs(r.y0 - b.bb.y0) < 0.6 && Math.abs(r.x1 - b.bb.x1) < 0.6 && Math.abs(r.y1 - b.bb.y1) < 0.6;
    const recs = TextOps.vectors(lib, lib.getPage(pg.index), pg.rm).filter(r => !done.some(d => same(d, r)));
    const [W, H] = dispSize(pg);
    for (const r of recs) {
      const D = (x, y) => vp.convertToViewportPoint(x, y);
      // đường gấp khúc (đường cong chia 8 đoạn) trong toạ độ hiển thị, để bấm trúng
      r.polys = r.subs.map(s => {
        const pts = []; let cx = 0, cy = 0;
        for (const g of s.segs) {
          if (g[0] === 'C') { for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; pts.push(D(u * u * u * cx + 3 * u * u * t * g[1] + 3 * u * t * t * g[3] + t * t * t * g[5], u * u * u * cy + 3 * u * u * t * g[2] + 3 * u * t * t * g[4] + t * t * t * g[6])); } cx = g[5]; cy = g[6]; }
          else { pts.push(D(g[1], g[2])); cx = g[1]; cy = g[2]; }
        }
        if (s.closed && pts.length) pts.push(pts[0]);
        return pts;
      });
      const all = r.polys.flat();
      r.dbb = { x0: Math.min(...all.map(q => q[0])), y0: Math.min(...all.map(q => q[1])), x1: Math.max(...all.map(q => q[0])), y1: Math.max(...all.map(q => q[1])) };
      r.big = r.fill && !r.stroke && (r.dbb.x1 - r.dbb.x0) * (r.dbb.y1 - r.dbb.y0) > W * H * 0.6; // nền cả trang
      r.D = D;
    }
    const res = { recs }; v.vecsVal = res; return res;
  })();
  return v.vecs;
}
const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
function vecHit(r, pt, tol) {
  const P = [pt.x, pt.y];
  if (P[0] < r.dbb.x0 - tol - r.lw || P[0] > r.dbb.x1 + tol + r.lw || P[1] < r.dbb.y0 - tol - r.lw || P[1] > r.dbb.y1 + tol + r.lw) return false;
  if (r.stroke) for (const pl of r.polys) for (let i = 1; i < pl.length; i++) if (segDist(P, pl[i - 1], pl[i]) <= r.lw / 2 + tol) return true;
  if (r.fill) { let inside = false; for (const pl of r.polys) for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const [xi, yi] = pl[i], [xj, yj] = pl[j]; if ((yi > P[1]) !== (yj > P[1]) && P[0] < (xj - xi) * (P[1] - yi) / (yj - yi) + xi) inside = !inside; } if (inside) return true; }
  return false;
}
function findVector(V, pt) {
  const tol = Math.max(1.5, 7 / S.zoom); // ~7 điểm ảnh màn hình: đường kẻ mảnh vẫn bấm trúng
  for (const pass of [false, true]) for (let i = V.recs.length - 1; i >= 0; i--) { const r = V.recs[i]; if (r.big === pass && vecHit(r, pt, tol)) return r; }
  return null;
}
const rgbCss = (c, ) => `rgb(${c.map(x => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(',')})`;
function vecToObjs(r) {
  // nét vẽ chỉ có viền gồm nhiều đoạn rời (vd đường kẻ bảng) -> tách thành từng đoạn để sửa riêng
  const groups = r.stroke && !r.fill && r.subs.length > 1 ? r.subs.map(s => [s]) : [r.subs];
  return groups.map(subs => {
    const d = subs.map(s => s.segs.map(g => g[0] + ' ' + g.slice(1).reduce((acc, v, i) => (i % 2 ? acc : acc.concat([r.D(v, g[i + 2])])), []).map(q => q[0].toFixed(2) + ' ' + q[1].toFixed(2)).join(' ')).join(' ') + (s.closed ? ' Z' : '')).join(' ');
    return new fabric.Path(d, {
      fill: r.fill ? rgbCss(r.fc) : '', stroke: r.stroke ? rgbCss(r.sc) : null, strokeWidth: r.stroke ? Math.max(r.lw, 0.3) : 0,
      strokeLineCap: ['butt', 'round', 'square'][r.cap] || 'butt', strokeLineJoin: ['miter', 'round', 'bevel'][r.join] || 'miter',
      strokeDashArray: r.dash && r.dash.length ? r.dash : null, fillRule: r.evenOdd ? 'evenodd' : 'nonzero',
      opacity: r.fill ? r.fa : r.sa, objectCaching: false, kind: 'vector',
    });
  });
}
async function extractContent(v, recs, imgs, pickRec, quiet) {
  const pg = v.page; if (!recs.length && !imgs.length) return false;
  busy(true, 'Đang tách…');
  try {
    const objs = [];
    // giữ đúng lớp như trong file gốc: hình / ảnh mà phía trên còn chữ hoặc nét vẽ khác đè lên (vd nền màu của bảng)
    // → đặt DƯỚI nội dung PDF (under) để chữ không bị che
    let T = null, V = null; try { [T, V] = await Promise.all([pageTextItems(v), pageVectorItems(v)]); } catch (e) {}
    const taken = new Set(recs.map(r => r.n));
    const ov = (a, b) => a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5;
    const coveredByText = bb => !!T && T.items.some(a => a.it.str.trim() && ov(bb, { x0: Math.min(a.ox, a.ox + a.w), x1: Math.max(a.ox, a.ox + a.w), y0: a.oy - a.fh, y1: a.oy + a.fh * 0.2 }));
    const coveredBelow = r => coveredByText(r.dbb) || (!!V && V.recs.some(r2 => r2.n > r.n && !taken.has(r2.n) && ov(r.dbb, r2.dbb)));
    for (const r of recs) {
      const os = vecToObjs(r);
      if (r.fill && coveredBelow(r)) os.forEach(o => o.set('under', true));
      objs.push(...os);
      pg.del = (pg.del || []).concat([{ vec: true, n: r.n, ...r.bb }]);
    }
    for (const im of imgs) {
      const o = await imageObject(v, im); if (!o) continue;
      const b = o.getBoundingRect(true, true);
      if (coveredByText({ x0: b.left, y0: b.top, x1: b.left + b.width, y1: b.top + b.height })) o.set('under', true);
      objs.push(o);
    }
    const nUnder = objs.filter(o => o.under).length;
    setTool('select');
    v.loading = true; objs.forEach(o => { v.fc.add(o); o.setCoords(); }); v.loading = false;
    v.fc.discardActiveObject();
    let sel = null;
    if (pickRec && v.lastPt) { // bấm 1 điểm: chọn đoạn / hình gần điểm bấm nhất
      const p = v.lastPt, dist = o => { const b = o.getBoundingRect(true, true); const dx = Math.max(b.left - p.x, 0, p.x - b.left - b.width), dy = Math.max(b.top - p.y, 0, p.y - b.top - b.height); return Math.hypot(dx, dy); };
      sel = objs.reduce((a, o) => (dist(o) < dist(a) ? o : a), objs[0]);
    }
    if (sel) v.fc.setActiveObject(sel);
    else if (objs.length) v.fc.setActiveObject(objs.length === 1 ? objs[0] : new fabric.ActiveSelection(objs, { canvas: v.fc }));
    v.fc.requestRenderAll(); syncView(v); S.activeView = v; refreshProps();
    v.tc = null; v.titems = null; v.titemsVal = null; v.imgs = null; v.imgsVal = null; v.vecs = null; v.vecsVal = null;
    await refreshPdfLayer(v);
    if (!quiet) toast(nUnder ? `Đã tách ${objs.length} đối tượng (nền nằm dưới chữ như bản gốc) — kéo để di chuyển, đổi màu ở bên phải, Delete để xoá` : `Đã tách ${objs.length} đối tượng — kéo để di chuyển, đổi màu / độ dày ở bên phải, Delete để xoá`, 3500);
  } finally { busy(false); }
  return true;
}
async function imageObject(v, im) {
  // tách 1 ảnh có sẵn thành đối tượng (dùng chung cho bấm ảnh và quét khung)
  const pg = v.page, I = await pageImageItems(v);
  const c = await imageCanvas(I.p, im), url = canvasToUrl(c);
  const { P0, P1, P3 } = im, wv = [P1[0] - P0[0], P1[1] - P0[1]], hv = [P3[0] - P0[0], P3[1] - P0[1]];
  const cross = wv[0] * hv[1] - wv[1] * hv[0], A = cross >= 0 ? P0 : P3;
  let ok = false;
  try { const lib = await getLib(pg.src); ok = TextOps.analyze(lib, lib.getPage(pg.index), [im.bb], pg.rm).some(h => h.img); } catch (e) { console.warn(e); }
  if (ok) pg.del = (pg.del || []).concat([im.bb]);
  const img = await new Promise(res => fabric.Image.fromURL(url, res));
  img.set({ left: A[0], top: A[1], originX: 'left', originY: 'top', angle: Math.atan2(wv[1], wv[0]) * 180 / Math.PI,
    scaleX: Math.hypot(...wv) / c.width, scaleY: Math.hypot(...hv) / c.height, flipY: cross < 0, kind: 'image' });
  return img;
}
/* quét khung trong chế độ Sửa nội dung: tách mọi nét vẽ + ảnh nằm gọn trong khung (vd cả cái bảng) */
/* Chọn đối tượng — bấm 1 lần vào đường kẻ / hình / ảnh gốc của PDF: tách ra và chọn luôn (chữ thì bấm đúp) */
async function pickAt(v, pt) {
  if (!v.page.src) return;
  v.lastPt = pt;
  // trang đã OCR: bấm 1 lần vào dòng chữ scan là sửa luôn (không cần chuyển sang "Sửa nội dung")
  const ol = findOcr(v.page, pt); if (ol) return editOcrLine(v, ol, pt);
  const [V, I] = await Promise.all([pageVectorItems(v), pageImageItems(v)]);
  const r = findVector(V, pt), im = findImage(I, pt);
  if (r && !r.big) return extractContent(v, [r], [], r, true);
  if (im && !isBigImage(v, im)) return editImageAt(v, pt);
}
/* Chọn đối tượng — kéo khung: tách mọi đường kẻ / hình / ảnh gốc nằm gọn trong khung rồi chọn tất cả (vd cả bảng) */
async function selectBox(v, box) {
  S.selBusy = true; S.pendingDelete = false;
  try { await selectBox0(v, box); } finally { S.selBusy = false; }
  // bấm Delete khi còn đang quét → xoá ngay khi quét xong
  if (S.pendingDelete) { S.pendingDelete = false; if (S.selBox) deleteSelBox(); else if (activeObjs().length) deleteSelected(); }
}
async function selectBox0(v, box) {
  clearSelBox();
  if (v.page.src) await extractBox(v, box, true);
  const inside = v.fc.getObjects().filter(o => { const b = o.getBoundingRect(true, true); return o.selectable !== false && b.left >= box.x - 1 && b.top >= box.y - 1 && b.left + b.width <= box.x + box.w + 1 && b.top + b.height <= box.y + box.h + 1; });
  // trong khung còn nội dung gốc không tách thành đối tượng được (chữ PDF, ảnh scan…) → giữ khung vùng chọn:
  // Ctrl+C sao chép cả vùng (nội dung gốc + đối tượng trong khung), Ctrl+V dán tại chỗ con trỏ chuột
  if (v.page.src && await pdfInkIn(v, box)) {
    showSelBox(v, box);
    toast('Đã chọn vùng — kéo các nút trắng để chỉnh khung; Ctrl+C sao chép (Ctrl+V dán tại chuột), Delete xoá', 4500);
    // khung vùng đã gồm cả các đối tượng trong khung → không hiện thêm khung chọn của từng đối tượng cho đỡ rối
    v.fc.discardActiveObject(); v.fc.requestRenderAll(); S.activeView = v; return;
  }
  if (!inside.length) { S.activeView = v; return; }
  setTool('select'); v.fc.discardActiveObject();
  v.fc.setActiveObject(inside.length === 1 ? inside[0] : new fabric.ActiveSelection(inside, { canvas: v.fc }));
  v.fc.requestRenderAll(); S.activeView = v; refreshProps();
}
// có nội dung gốc của PDF (chữ, ảnh…) trong khung không — vẽ thử vùng đó, đếm điểm có màu
async function pdfInkIn(v, box) {
  try {
    const sc = Math.min(2, 400 / Math.max(box.w, box.h, 1)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(box.w * sc)); c.height = Math.max(1, Math.ceil(box.h * sc));
    const p = await getJsPage(v.page);
    await p.render({ canvasContext: c.getContext('2d'), viewport: p.getViewport({ scale: sc, rotation: effRot(v.page), offsetX: -box.x * sc, offsetY: -box.y * sc }), background: 'rgba(0,0,0,0)' }).promise;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40 && d[i] + d[i + 1] + d[i + 2] < 720) { if (++n > 4) return true; }
    return false;
  } catch (e) { return false; }
}
// khung vùng chọn (nét đứt) — nhớ ở S.selBox cho Ctrl+C
function showSelBox(v, box) {
  clearSelBox();
  const el = document.createElement('div'); el.className = 'sel-box';
  el.innerHTML = '<div class="sb-move" title="Kéo để dời cả vùng sang chỗ khác"></div><div class="sb-bar"><button type="button" data-a="copy" title="Sao chép vùng (Ctrl+C) — rồi trỏ chuột vào chỗ muốn dán, bấm Ctrl+V"><span class="ti ti-copy"></span>Sao chép</button>'
    + '<button type="button" data-a="del" class="sb-del" title="Xoá mọi thứ trong khung (Delete) — rê chuột vào đây để xem trước"><span class="ti ti-trash"></span>Xoá</button></div>'
    + ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => `<i class="sb-h" data-h="${h}"></i>`).join('');
  v.el.appendChild(el);
  S.selBox = { v, box: { ...box }, el }; placeSelBox();
  // 1. xem trước: rê chuột vào nút Xoá → vùng sắp xoá hiện trắng mờ, viền đỏ
  const del = el.querySelector('.sb-del');
  del.onmouseenter = () => el.classList.add('preview'); del.onmouseleave = () => el.classList.remove('preview');
  el.querySelector('.sb-bar').addEventListener('mousedown', e => e.stopPropagation());
  el.querySelector('[data-a=copy]').onclick = () => { S.doCopy(); toast('Đã sao chép vùng — trỏ chuột vào chỗ muốn dán rồi bấm Ctrl+V', 3000); };
  del.onclick = () => deleteSelBox();
  // 2. kéo các nút ở góc / cạnh để chỉnh khung
  el.querySelectorAll('.sb-h').forEach(hd => hd.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    const s = S.selBox; if (!s) return; const h = hd.dataset.h, b0 = { ...s.box }, z = S.zoom, sx = e.clientX, sy = e.clientY;
    const [PW, PH] = dispSize(v.page);
    hd.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z; let { x, y, w, h: hh } = b0;
      if (h.includes('w')) { const nx = Math.max(0, Math.min(x + w - 4, x + dx)); w += x - nx; x = nx; }
      if (h.includes('e')) w = Math.max(4, Math.min(PW - x, w + dx));
      if (h.includes('n')) { const ny = Math.max(0, Math.min(y + hh - 4, y + dy)); hh += y - ny; y = ny; }
      if (h.includes('s')) hh = Math.max(4, Math.min(PH - y, hh + dy));
      s.box = { x, y, w, h: hh }; placeSelBox();
    };
    const up = () => { hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up); hd.removeEventListener('pointercancel', up); };
    hd.addEventListener('pointermove', move); hd.addEventListener('pointerup', up); hd.addEventListener('pointercancel', up);
  }));
  // 4. kéo bên trong khung để dời cả vùng: chỗ cũ hiện trắng mờ (sẽ trống), khung mang theo hình của vùng
  const mv = el.querySelector('.sb-move');
  mv.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
    const s = S.selBox; if (!s) return; const b0 = { ...s.box }, z = S.zoom, sx = e.clientX, sy = e.clientY, [PW, PH] = dispSize(v.page);
    mv.setPointerCapture(e.pointerId);
    let started = false, dx = 0, dy = 0, gh = null;
    const move = ev => {
      dx = (ev.clientX - sx) / z; dy = (ev.clientY - sy) / z;
      if (!started) {
        if (Math.hypot(dx * z, dy * z) < 4) return;
        started = true; el.classList.add('moving');
        gh = document.createElement('div'); gh.className = 'sel-ghost'; Object.assign(gh.style, { left: b0.x * z + 'px', top: b0.y * z + 'px', width: b0.w * z + 'px', height: b0.h * z + 'px' }); v.el.appendChild(gh);
        regionSnap(v, b0).then(u => { if (u && el.isConnected && el.classList.contains('moving')) el.style.backgroundImage = `url(${u})`; });
      }
      dx = Math.max(-b0.x, Math.min(PW - b0.x - b0.w, dx)); dy = Math.max(-b0.y, Math.min(PH - b0.y - b0.h, dy));
      Object.assign(el.style, { left: (b0.x + dx) * z + 'px', top: (b0.y + dy) * z + 'px' });
    };
    const up = () => {
      mv.removeEventListener('pointermove', move); mv.removeEventListener('pointerup', up); mv.removeEventListener('pointercancel', up);
      if (gh) gh.remove(); el.classList.remove('moving'); el.style.backgroundImage = '';
      if (!started || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)) { placeSelBox(); return; }
      moveSelBox(v, b0, dx, dy);
    };
    mv.addEventListener('pointermove', move); mv.addEventListener('pointerup', up); mv.addEventListener('pointercancel', up);
  });
}
// ảnh nhanh của vùng (để khung mang theo khi kéo)
async function regionSnap(v, box) {
  try {
    const sc = Math.min(3, Math.max(1, S.zoom * (window.devicePixelRatio || 1))), c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(box.w * sc)); c.height = Math.max(1, Math.ceil(box.h * sc));
    const p = await getJsPage(v.page);
    await p.render({ canvasContext: c.getContext('2d'), viewport: p.getViewport({ scale: sc, rotation: effRot(v.page), offsetX: -box.x * sc, offsetY: -box.y * sc }), background: 'rgba(0,0,0,0)' }).promise;
    return c.toDataURL('image/png');
  } catch (e) { return null; }
}
// dời vùng: chép cả vùng (nội dung gốc giữ nét vector khi lưu + đối tượng trong khung) → xoá chỗ cũ → đặt ở chỗ mới; 1 bước hoàn tác
async function moveSelBox(v, b0, dx, dy) {
  const n0 = S.undo.length;
  busy(true, 'Đang dời vùng…');
  try {
    // nội dung gốc của vùng (ảnh + thông tin để lưu bằng nét vector) — đối tượng trong khung lấy đúng bộ mà bước xoá gỡ ra
    const region = (await copyRegion(v, b0, true, false)).filter(o => o.kind === 'region');
    if (S.selBox) S.selBox.box = { ...b0 };
    deleteSelBox.removed = [];
    await deleteSelBox();
    const objs = region.concat(deleteSelBox.removed || []);
    const v2 = S.views.get(v.page.id) || v; await ready(v2);
    const os = await enliven(objs);
    os.forEach(o => o.set({ left: o.left + dx, top: o.top + dy }));
    v2.loading = true; os.forEach(o => { v2.fc.add(o); o.setCoords(); }); v2.loading = false;
    v2.fc.discardActiveObject(); v2.fc.requestRenderAll(); syncView(v2);
    if (S.undo.length > n0 + 1) S.undo.splice(n0 + 1); updateUI();
    showSelBox(v2, { x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h }); S.activeView = v2;
    toast('Đã dời vùng — kéo tiếp để chỉnh, Ctrl+Z để hoàn tác', 3000);
  } catch (e) { console.error(e); toast('Không dời được vùng này'); }
  finally { busy(false); }
}
function placeSelBox() {
  const s = S.selBox; if (!s) return; const z = S.zoom;
  Object.assign(s.el.style, { left: s.box.x * z + 'px', top: s.box.y * z + 'px', width: s.box.w * z + 'px', height: s.box.h * z + 'px' });
}
function clearSelBox() { if (S.selBox) { S.selBox.el.remove(); S.selBox = null; } }
// Delete trên khung vùng chọn: XOÁ THẬT mọi thứ trong khung — đối tượng, nét vẽ đã tách, chữ gốc, phần ảnh gốc (không phủ ô trắng)
async function deleteSelBox() {
  const s = S.selBox; if (!s) return; const { v, box } = s; clearSelBox();
  const pg = v.page, n0 = S.undo.length;
  // đối tượng nằm phần lớn (≥ 60%) trong khung → gỡ bỏ (kể cả nét vừa tách ra lúc quét, hơi lố ra ngoài khung)
  v.fc.discardActiveObject(); // bỏ nhóm chọn trước, không thì toạ độ đối tượng tính theo nhóm
  const inside = v.fc.getObjects().filter(o => { const b = o.getBoundingRect(true, true);
    const ix = Math.max(0, Math.min(b.left + b.width, box.x + box.w) - Math.max(b.left, box.x)), iy = Math.max(0, Math.min(b.top + b.height, box.y + box.h) - Math.max(b.top, box.y));
    const inside2 = b.left >= box.x - 2 && b.top >= box.y - 2 && b.left + b.width <= box.x + box.w + 2 && b.top + b.height <= box.y + box.h + 2;
    return inside2 || (ix >= Math.max(b.width, 0.5) * 0.6 && iy >= Math.max(b.height, 0.5) * 0.6); });
  const all = v.fc.toObject(PROPS).objects, removed = all.filter((o, i) => inside.includes(v.fc.item(i))); // trả về cho "dời vùng"
  v.loading = true; inside.forEach(o => v.fc.remove(o)); v.loading = false; v.fc.requestRenderAll(); syncView(v);
  deleteSelBox.removed = removed;
  if (pg.src) {
    busy(true, 'Đang xoá…');
    try {
      // chữ gốc trong khung: thêm vùng xoá chữ (toạ độ PDF)
      const p = await getJsPage(pg), vp = p.getViewport({ scale: 1, rotation: effRot(pg) });
      const cs = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => vp.convertToPdfPoint(x, y));
      const rb = { x0: Math.min(...cs.map(c => c[0])), y0: Math.min(...cs.map(c => c[1])), x1: Math.max(...cs.map(c => c[0])), y1: Math.max(...cs.map(c => c[1])) };
      // xoá chữ trong khung + cắt bỏ phần nét vẽ / ảnh vắt qua khung (để vùng quét sạch hẳn)
      pg.del = (pg.del || []).concat([rb, { clip: true, ...rb }]);
      if (pg.ocr) pg.ocr = pg.ocr.filter(l => !(l.x0 < box.x + box.w && l.x1 > box.x && l.y0 < box.y + box.h && l.y1 > box.y));
      commit();
      const vv = S.views.get(pg.id) || v; vv.tc = null; vv.titems = null; vv.titemsVal = null; vv.imgs = null; vv.imgsVal = null; vv.vecs = null; vv.vecsVal = null;
      // ảnh gốc chồng lên khung (vd bản scan): tẩy trong suốt đúng phần giao nhau
      const I = await pageImageItems(vv);
      for (const im of (I.list || []).slice()) {
        const P2 = [im.P1[0] + im.P3[0] - im.P0[0], im.P1[1] + im.P3[1] - im.P0[1]], ps = [im.P0, im.P1, im.P3, P2];
        const x0 = Math.max(box.x, Math.min(...ps.map(q => q[0]))), y0 = Math.max(box.y, Math.min(...ps.map(q => q[1])));
        const x1 = Math.min(box.x + box.w, Math.max(...ps.map(q => q[0]))), y1 = Math.min(box.y + box.h, Math.max(...ps.map(q => q[1])));
        if (x1 - x0 > 1 && y1 - y0 > 1) await eraseAt(S.views.get(pg.id) || vv, x0, y0, x1 - x0, y1 - y0);
      }
      busy(true, 'Đang xoá…');
      const v3 = S.views.get(pg.id) || vv; v3.tc = null; v3.titems = null; v3.titemsVal = null; v3.imgs = null; v3.imgsVal = null; v3.vecs = null; v3.vecsVal = null;
      await refreshPdfLayer(v3);
    } catch (e) { console.error(e); toast('Không xoá hết được nội dung trong khung'); }
    finally { busy(false); }
  }
  if (S.undo.length > n0 + 1) S.undo.splice(n0 + 1); // gộp thành 1 bước hoàn tác
  S.activeView = S.views.get(pg.id) || v;
  toast('Đã xoá vùng chọn (Ctrl+Z để hoàn tác)');
}
// đường kẻ mảnh (0.5pt) gần như không bấm trúng được bằng khung bao của fabric -> nới vùng bấm ra ~7 điểm ảnh
const _containsPoint = fabric.Object.prototype.containsPoint;
fabric.Object.prototype.containsPoint = function (point, lines, absolute, calculate) {
  if (this.kind === 'vector' || this.type === 'line') {
    const b = this.getBoundingRect(absolute, calculate), pad = 7;
    return point.x >= b.left - pad && point.x <= b.left + b.width + pad && point.y >= b.top - pad && point.y <= b.top + b.height + pad;
  }
  return _containsPoint.call(this, point, lines, absolute, calculate);
};
async function extractBox(v, box, quiet) {
  if (!v.page.src) return;
  const [V, I] = await Promise.all([pageVectorItems(v), pageImageItems(v)]);
  const inBox = b => b.x0 >= box.x - 0.5 && b.y0 >= box.y - 0.5 && b.x1 <= box.x + box.w + 0.5 && b.y1 <= box.y + box.h + 0.5;
  const recs = V.recs.filter(r => inBox(r.dbb));
  const imgs = I.list.filter(im => !isBigImage(v, im)).filter(im => { const xs = [im.P0[0], im.P1[0], im.P3[0], im.P1[0] + im.P3[0] - im.P0[0]], ys = [im.P0[1], im.P1[1], im.P3[1], im.P1[1] + im.P3[1] - im.P0[1]]; return inBox({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }); });
  if (!recs.length && !imgs.length) { if (!quiet) toast('Không có đường kẻ / hình / ảnh nào nằm gọn trong khung'); return false; }
  return extractContent(v, recs, imgs, null, quiet);
}
/* ---------------- hình mờ (watermark) & lớp (layer / OCG — nơi hay giấu logo ẩn) ---------------- */
async function openWatermarkPanel() {
  if (!S.pages.length) return;
  busy(true, 'Đang quét hình mờ và các lớp…');
  let wmPages = 0; const layers = new Map();
  try {
    for (const pg of S.pages) {
      if (!pg.src) continue;
      const lib = await getLib(pg.src), r = TextOps.scan(lib, lib.getPage(pg.index));
      if (r.wm || r.wmAnnots) wmPages++;
      for (const [n] of r.layers) layers.set(n, (layers.get(n) || 0) + 1);
    }
  } catch (e) { console.error(e); } finally { busy(false); }
  const body = $('#wmBody'); body.innerHTML = '';
  const wmOn = S.pages.some(p => p.rm && p.rm.watermark);
  const sec1 = document.createElement('div'); sec1.className = 'wm-sec';
  sec1.innerHTML = '<h4>Hình mờ (watermark)</h4>' + (wmPages
    ? `<label class="chk"><input type="checkbox" id="wmRemove" ${wmOn ? 'checked' : ''}> Xoá hình mờ trên ${wmPages} trang</label>`
    : '<p class="muted">Không thấy hình mờ dạng chuẩn. Nếu hình mờ là ảnh, chữ hay nét vẽ thường: dùng công cụ <b>Sửa nội dung</b>, bấm vào (hoặc quét khung) rồi Delete.</p>');
  body.appendChild(sec1);
  const sec2 = document.createElement('div'); sec2.className = 'wm-sec';
  sec2.innerHTML = '<h4>Lớp nội dung (layer)</h4>' + (layers.size ? '<p class="muted">Logo / nội dung ẩn thường nằm trong lớp đang <b>Ẩn</b> — chọn <b>Hiện</b> để thấy và sửa được.</p>' : '<p class="muted">File không có lớp nội dung.</p>');
  for (const [name, cnt] of layers) {
    const hidden = S.pages.some(p => p.rm && (p.rm.layers || []).includes(name));
    const row = document.createElement('div'); row.className = 'wm-row'; row.dataset.layer = name;
    row.innerHTML = `<span class="nm"></span><span class="muted">${cnt} trang</span><label><input type="radio" name="ly_${name.replace(/\W/g, '_')}" value="show" ${hidden ? '' : 'checked'}> Hiện</label><label><input type="radio" name="ly_${name.replace(/\W/g, '_')}" value="hide" ${hidden ? 'checked' : ''}> Ẩn (bỏ khi lưu)</label>`;
    row.querySelector('.nm').textContent = name;
    sec2.appendChild(row);
  }
  body.appendChild(sec2);
  $('#wmModal').hidden = false;
}
function applyWatermarkPanel() {
  const wm = !!($('#wmRemove') && $('#wmRemove').checked);
  const hide = $$('#wmBody .wm-row').filter(r => r.querySelector('input[value=hide]').checked).map(r => r.dataset.layer);
  for (const pg of S.pages) {
    if (!pg.src) continue;
    const rm = {}; if (wm) rm.watermark = true; if (hide.length) rm.layers = hide;
    if (Object.keys(rm).length) pg.rm = rm; else delete pg.rm;
  }
  $('#wmModal').hidden = true;
  rebuild(); commit();
  toast('Đã áp dụng — bấm Hoàn tác (Ctrl+Z) nếu muốn trở lại');
}
async function hiddenLayersOf(srcId) {
  // lớp đang tắt sẵn trong file: ẩn khi xem thì cũng bỏ khi lưu (giữ đúng như nhìn thấy)
  try {
    const cfg = await S.sources[srcId].js.getOptionalContentConfig();
    const groups = cfg && cfg.getGroups ? cfg.getGroups() : null; if (!groups) return [];
    return Object.values(groups).filter(g => g && g.visible === false && g.name).map(g => g.name);
  } catch (e) { return []; }
}

/* ---------------- OCR: nhận dạng chữ trên trang scan (Tesseract.js, tiếng Việt + Anh) ---------------- */
let tessP = null, ocrWorker = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return tessP || (tessP = new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'; s.onload = ok; s.onerror = () => { tessP = null; no(new Error('Không tải được thư viện nhận dạng chữ (cần Internet)')); }; document.head.appendChild(s); }));
}
async function getOcrWorker() {
  await loadTesseract();
  if (!ocrWorker) ocrWorker = await Tesseract.createWorker(['vie', 'eng'], 1, { logger: m => { if (m.status && typeof m.progress === 'number') $('#busyMsg').textContent = `Nhận dạng chữ: ${m.status === 'recognizing text' ? 'đang đọc' : 'chuẩn bị'} ${Math.round(m.progress * 100)}%`; } });
  return ocrWorker;
}
async function ocrPage(pg) {
  if (!pg.src) return 0;
  busy(true, 'Nhận dạng chữ: đang chuẩn bị (lần đầu tải dữ liệu tiếng Việt ~ 10MB)…');
  try {
    // trang scan (ảnh phủ cả trang): đọc thẳng ảnh gốc — không lẫn chữ / hình vẽ thêm đè lên;
    // trang thường: vẽ trang ở 300 dpi rồi đọc
    let c, toDisp = (x, y) => [x / sc, y / sc];
    const sc = 300 / 72, v = S.views.get(pg.id);
    let big = null;
    if (v) { const I = await pageImageItems(v); big = I.list.filter(im => isBigImage(v, im)).pop(); if (big) { c = await imageCanvas(I.p, big); } }
    if (big) {
      const { P0, P1, P3 } = big, W = c.width, H = c.height;
      toDisp = (x, y) => [P0[0] + x / W * (P1[0] - P0[0]) + y / H * (P3[0] - P0[0]), P0[1] + x / W * (P1[1] - P0[1]) + y / H * (P3[1] - P0[1])];
      if (Math.max(W, H) < 1600) { const k = 2, c2 = document.createElement('canvas'); c2.width = W * k; c2.height = H * k; const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(c, 0, 0, c2.width, c2.height); c = c2; const t0 = toDisp; toDisp = (x, y) => t0(x / k, y / k); }
      // nền trong suốt -> trắng
      const c3 = document.createElement('canvas'); c3.width = c.width; c3.height = c.height; const x3 = c3.getContext('2d'); x3.fillStyle = '#fff'; x3.fillRect(0, 0, c3.width, c3.height); x3.drawImage(c, 0, 0); c = c3;
    } else {
      const p = await getJsPage(pg), vp = p.getViewport({ scale: sc, rotation: effRot(pg) });
      c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    }
    const bbDisp = (x0, y0, x1, y1) => { const cs = [toDisp(x0, y0), toDisp(x1, y0), toDisp(x0, y1), toDisp(x1, y1)]; return { x0: Math.min(...cs.map(q => q[0])), y0: Math.min(...cs.map(q => q[1])), x1: Math.max(...cs.map(q => q[0])), y1: Math.max(...cs.map(q => q[1])) }; };
    const w = await getOcrWorker();
    const { data } = await w.recognize(c);
    // dùng từng TỪ (chính xác hơn dòng của Tesseract, vốn hay nối nhiều ô bảng thành 1 dòng), tự gom lại:
    // cùng hàng + gần nhau = 1 cụm; vạch kẻ bảng đọc thành "|" và khoảng trống lớn = ranh giới ô
    const all = data.words && data.words.length ? data.words : (data.blocks || []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
    const words = all.filter(wd => wd.text.trim() && wd.confidence >= 40).map(wd => ({ t: wd.text.trim(), c: wd.confidence, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1 }))
      .filter(wd => /[\p{L}\p{N}]/u.test(wd.t) || wd.t === '|');
    words.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const rows = [];
    for (const wd of words) {
      const h = wd.y1 - wd.y0;
      const r = rows.find(r => Math.min(r.y1, wd.y1) - Math.max(r.y0, wd.y0) > Math.min(h, r.y1 - r.y0) * 0.5);
      if (r) { r.w.push(wd); r.y0 = Math.min(r.y0, wd.y0); r.y1 = Math.max(r.y1, wd.y1); } else rows.push({ y0: wd.y0, y1: wd.y1, w: [wd] });
    }
    const lines = [];
    for (const r of rows) {
      r.w.sort((a, b) => a.x0 - b.x0);
      const hs = r.w.map(w => w.y1 - w.y0).sort((a, b) => a - b), h = hs[hs.length >> 1];
      let run = [];
      const flush = () => {
        const ws = run.filter(w => w.t !== '|'); run = [];
        if (!ws.length) return;
        const text = ws.map(w => w.t).join(' ').replace(/^\|+|\|+$/g, '').trim();
        const conf = ws.reduce((s, w) => s + w.c, 0) / ws.length;
        if (!text || (text.replace(/[^\p{L}\p{N}]/gu, '').length < 2 && conf < 85)) return; // vụn nhiễu (con dấu, chữ ký…)
        lines.push({ text, ...bbDisp(Math.min(...ws.map(w => w.x0)), Math.min(...ws.map(w => w.y0)), Math.max(...ws.map(w => w.x1)), Math.max(...ws.map(w => w.y1))), conf: Math.round(conf),
          words: ws.map(w => ({ t: w.t, c: Math.round(w.c), ...bbDisp(w.x0, w.y0, w.x1, w.y1) })) }); // vị trí từng từ: để nhận kiểu chữ + giữ khoảng cách giữa các từ
      };
      for (const wd of r.w) {
        const prev = run[run.length - 1];
        if (wd.t === '|' || (prev && wd.x0 - prev.x1 > h * 1.1)) flush();
        if (wd.t !== '|') run.push(wd);
      }
      flush();
    }
    pg.ocr = lines; commit();
    const v2 = S.views.get(pg.id); if (v2) drawOcrFlags(v2);
    return lines.length;
  } finally { busy(false); }
}
// nút "Nhận dạng chữ (OCR)": quét MỌI trang scan của file 1 lần (trang có chữ thật hoặc đã nhận dạng thì bỏ qua)
async function runOcrCurrent() {
  if (!S.pages.some(p => p.src)) return toast('Hãy mở file PDF trước');
  const todo = [];
  busy(true, 'Đang kiểm tra các trang…');
  try {
    for (const pg of S.pages) {
      if (!pg.src || (pg.ocr && pg.ocr.length)) continue;
      const v = S.views.get(pg.id); if (!v) continue;
      let n = 0; try { const T = await pageTextItems(v); n = T.items.reduce((a, x) => a + (x.it.str || '').trim().length, 0); } catch (e) {}
      if (n < 30) todo.push(pg); // gần như không có chữ thật → trang scan
    }
  } finally { busy(false); }
  if (!todo.length) return toast(S.pages.some(p => p.ocr && p.ocr.length) ? 'Các trang scan đã được nhận dạng rồi' : 'File này đã có chữ thật — dùng "Sửa nội dung" để sửa trực tiếp, không cần OCR', 4000);
  let lines = 0, done = 0;
  try {
    for (const pg of todo) {
      busy(true, `Nhận dạng chữ: trang ${S.pages.indexOf(pg) + 1} (${done + 1}/${todo.length})…`);
      lines += await ocrPage(pg); done++;
    }
  } catch (e) { console.error(e); alert('Lỗi nhận dạng chữ: ' + (e.message || e)); }
  finally { busy(false); }
  setTool('select');
  toast(`Đã nhận dạng ${done} trang (${lines} dòng chữ) — bấm vào dòng chữ để sửa`, 5000);
}
/* Từ OCR có thể đọc sai: độ tin cậy thấp, hoặc không phải âm tiết tiếng Việt hợp lệ (vd "PILU") mà độ tin cậy chưa cao.
   Số, ký hiệu, từ có cả số lẫn chữ: bỏ qua. */
const VN_SYL = /^(ngh|ng|nh|ch|gh|gi|kh|ph|qu|th|tr|[bcdđghklmnprstvx])?([aăâeêioôơuưy]{1,3})(ch|ng|nh|[cmnpt])?$/;
function vnSyllable(w) {
  const s = w.toLowerCase().normalize('NFD').replace(/[̣̀́̃̉]/g, '').normalize('NFC'); // bỏ dấu thanh, giữ ă â ê ô ơ ư
  return VN_SYL.test(s);
}
function ocrSuspicious(word) {
  const t = (word.t || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''); if (!t) return false;
  const c = word.c == null ? 80 : word.c;
  if (/\p{N}/u.test(t)) return c < 60;
  if (c < 70) return true;
  return !/^\p{L}+$/u.test(t) ? c < 85 : !vnSyllable(t) && c < 93;
}
// gạch đỏ dưới các từ OCR nghi đọc sai (chỉ hiển thị, không lưu vào file)
const OCR_FLAGS = false; // tô đỏ từ OCR nghi đọc sai — đã tắt theo yêu cầu (bật lại: true)
function drawOcrFlags(v) {
  if (v.flagsEl) { v.flagsEl.remove(); v.flagsEl = null; }
  if (!OCR_FLAGS) return;
  const ls = (v.page.ocr || []).filter(l => !l.done); if (!ls.length) return;
  const z = S.zoom, el = document.createElement('div'); el.className = 'ocr-flags';
  for (const l of ls) for (const w of l.words || []) if (ocrSuspicious(w)) {
    const s = document.createElement('span'); s.title = `Có thể đọc sai: "${w.t}" — bấm vào dòng để sửa`;
    Object.assign(s.style, { left: (w.x0 - 1) * z + 'px', top: (w.y0 - 1) * z + 'px', width: Math.max(4, (w.x1 - w.x0 + 2) * z) + 'px', height: (w.y1 - w.y0 + 2) * z + 'px' });
    el.appendChild(s);
  }
  if (!el.children.length) return;
  v.el.appendChild(el); v.flagsEl = el;
}
const OCR_MARK = 'rgba(229,57,53,0.22)';
function findOcr(pg, pt) {
  const tol = Math.max(1, 3 / S.zoom);
  return (pg.ocr || []).find(l => !l.done && pt.x >= l.x0 - tol && pt.x <= l.x1 + tol && pt.y >= l.y0 - tol && pt.y <= l.y1 + tol) || null;
}
function showOcrHover(v, l) {
  if (!v.hov) { v.hov = document.createElement('div'); v.hov.className = 'txt-hover'; v.el.appendChild(v.hov); }
  if (!l) { v.hov.style.display = 'none'; return; }
  const z = S.zoom; Object.assign(v.hov.style, { display: 'block', left: (l.x0 - 1.5) * z + 'px', top: (l.y0 - 1.5) * z + 'px', width: (l.x1 - l.x0 + 3) * z + 'px', height: (l.y1 - l.y0 + 3) * z + 'px', transform: 'none' });
}
/* Nhận ra kiểu chữ của 1 dòng scan: vẽ thử chính dòng chữ đó bằng từng phông ứng viên (thường / đậm / nghiêng),
   co giãn cho vừa khung rồi so với bản scan — chọn cái giống nhất.
   - phông + nghiêng: so hình dạng (ảnh trắng đen, lưới 2x2 điểm ảnh cho phép lệch nhẹ)
   - đậm: so độ phủ mực HOẶC so ảnh xám (sau khi làm mờ chữ mẫu bằng độ mờ của bản scan)
   data: điểm ảnh RGBA vùng chữ (w x h), thr: ngưỡng tổng RGB coi là mực */
const OCR_FONTS = ['Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Tahoma', 'Verdana', 'Segoe UI', 'Courier New'];
function ocrStyle(text, data, w, h, thr, words, prefer, preferVar, base) {
  w = Math.max(1, w); h = Math.max(1, h);
  const N = w * h, G = 2, gw = Math.ceil(w / G), gh = Math.ceil(h / G);
  const grid = on => { const g = new Uint8Array(gw * gh); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on[y * w + x]) g[((y / G) | 0) * gw + ((x / G) | 0)] = 1; return g; };
  // bản scan: trắng đen (theo ngưỡng) + ảnh xám chuẩn hoá (0 = giấy, 1 = mực)
  const lum = new Float32Array(N), scanOn = new Uint8Array(N); let scanInk = 0;
  for (let j = 0, i = 0; j < N; j++, i += 4) { lum[j] = data[i] + data[i + 1] + data[i + 2]; if (lum[j] < thr) { scanOn[j] = 1; scanInk++; } }
  const scanG = grid(scanOn), dS = scanInk / N;
  const srt = Float32Array.from(lum).sort(), paperL = srt[Math.floor(N * 0.9)], inkL = srt[Math.floor(N * 0.02)], rng = Math.max(30, paperL - inkL);
  const scan = new Float32Array(N); for (let j = 0; j < N; j++) scan[j] = Math.max(0, Math.min(1, (paperL - lum[j]) / rng));
  const ncc = (a, b) => { let ma = 0, mb = 0; for (let j = 0; j < N; j++) { ma += a[j]; mb += b[j]; } ma /= N; mb /= N; let s = 0, va = 0, vb = 0; for (let j = 0; j < N; j++) { const x = a[j] - ma, y = b[j] - mb; s += x * y; va += x * x; vb += y * y; } return s / Math.sqrt(va * vb || 1); };

  const rc = document.createElement('canvas'); rc.width = w; rc.height = h;
  const r = rc.getContext('2d', { willReadFrequently: true });
  // vẽ chữ bằng 1 kiểu phông, mỗi từ vừa khít khung của chính từ đó trên bản scan (cao theo chữ thật, ngang co giãn cho bằng)
  // — không có vị trí từng từ thì coi cả dòng là 1 khung
  const boxes = (words && words.length ? words : [{ t: text, x0: 0, y0: 0, x1: w, y1: h }]).filter(q => q.t && q.x1 - q.x0 >= 2 && q.y1 - q.y0 >= 2);
  const render = (fam, b, it, blur) => {
    const f = s => `${it ? 'italic ' : ''}${b ? 'bold ' : ''}${s}px "${fam}"`;
    r.setTransform(1, 0, 0, 1, 0, 0); r.filter = 'none'; r.fillStyle = '#fff'; r.fillRect(0, 0, w, h);
    r.filter = blur > 0.2 ? `blur(${blur.toFixed(2)}px)` : 'none'; r.fillStyle = '#000';
    const ks = [];
    for (const q of boxes) {
      const bw = q.x1 - q.x0, bh = q.y1 - q.y0;
      r.setTransform(1, 0, 0, 1, 0, 0); r.font = f(100); const m = r.measureText(q.t);
      const sz = 100 * bh / ((m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || 90);
      const inkW = ((m.actualBoundingBoxLeft + m.actualBoundingBoxRight) || m.width) * sz / 100, kx = bw / Math.max(1, inkW);
      r.font = f(sz); r.setTransform(kx, 0, 0, 1, q.x0, q.y0);
      r.fillText(q.t, m.actualBoundingBoxLeft * sz / 100, m.actualBoundingBoxAscent * sz / 100);
      ks.push(kx);
    }
    r.filter = 'none'; r.setTransform(1, 0, 0, 1, 0, 0);
    return { d: r.getImageData(0, 0, w, h).data, ks };
  };
  const shape = (fam, b, it) => {
    const { d, ks } = render(fam, b, it, 0), on = new Uint8Array(N); let ink = 0;
    for (let j = 0, i = 0; j < N; j++, i += 4) if (d[i] < 128) { on[j] = 1; ink++; }
    const g = grid(on);
    // chấm từng từ trong khung của nó (phạt nhẹ khi phải kéo dãn / bóp nhiều), lấy trung vị → 1 từ đọc sai không làm lệch cả dòng
    const sc = boxes.map((q, bi) => {
      const gx0 = Math.max(0, Math.floor(q.x0 / G)), gx1 = Math.min(gw, Math.ceil(q.x1 / G)), gy0 = Math.max(0, Math.floor(q.y0 / G)), gy1 = Math.min(gh, Math.ceil(q.y1 / G));
      let inter = 0, a = 0, bb = 0;
      for (let y = gy0; y < gy1; y++) for (let x = gx0; x < gx1; x++) { const i = y * gw + x; a += scanG[i]; bb += g[i]; if (g[i] && scanG[i]) inter++; }
      return 2 * inter / Math.max(1, a + bb) - Math.min(0.12, Math.abs(Math.log(ks[bi])) * 0.15);
    }).sort((x, y) => x - y);
    return { dice: sc.length ? sc[sc.length >> 1] : 0, dens: ink / N };
  };
  const gray = (fam, b, it) => { // tương quan ảnh xám, thử vài mức mờ lấy mức khớp nhất (gray.bl = độ mờ khớp nhất, điểm ảnh)
    let best = -2, bb = 0;
    for (const bl of [0, h / 40, h / 24, h / 15, h / 9, h / 6]) {
      const { d } = render(fam, b, it, bl), g = new Float32Array(N);
      for (let j = 0, i = 0; j < N; j++, i += 4) g[j] = 1 - d[i] / 255;
      const c = ncc(scan, g); if (c > best) { best = c; bb = bl; }
    }
    gray.bl = bb;
    return best;
  };

  // các độ đậm riêng (Segoe UI Light / Semibold…) cũng so hình dạng, sau đó quy về họ phông gốc để chọn độ đậm
  const variantBase = {}; for (const [b0, arr] of Object.entries(OCR_WEIGHTS)) for (const f of arr) if (f !== b0) variantBase[f] = b0;
  const families = S.style.ocrFont ? [S.style.ocrFont] : OCR_FONTS.concat(Object.keys(variantBase)).filter(f => { try { return document.fonts.check(`12px "${f}"`); } catch (e) { return true; } });
  const bestOf = { false: null, true: null }, all = {};
  for (const fam of families) for (const it of [false, true]) {
    const n = shape(fam, false, it), bo = shape(fam, true, it), sc = Math.max(n.dice, bo.dice);
    all[fam + '|' + it] = { sc, n, bo, fam, it };
    if (!bestOf[it] || sc > bestOf[it].sc) bestOf[it] = all[fam + '|' + it];
  }
  // nghiêng chỉ khi giống rõ ràng hơn chữ đứng (tránh nhận nhầm)
  let best = bestOf.true && (!bestOf.false || bestOf.true.sc > bestOf.false.sc + 0.04) ? bestOf.true : bestOf.false;
  if (!best) return { family: 'Times New Roman', bold: false, italic: false };
  // dòng ngắn khó đoán: phông các dòng khác trên trang đang dùng mà điểm gần bằng thì lấy phông đó (văn bản thường chỉ 1–2 phông)
  const nch = [...text.replace(/\s/g, '')].length, short = nch < 12;
  const pfMargin = short ? 0.08 : nch < 30 ? 0.06 : 0.03; // dòng càng ngắn càng khó đoán → càng nghiêng về phông chung của trang
  const pf = prefer && all[prefer + '|' + best.it];
  if (pf && pf !== best && pf.sc >= best.sc - pfMargin) best = pf;
  let baseFam = variantBase[best.fam] || best.fam, grp = OCR_WEIGHTS[baseFam];
  // độ phủ mực của bản scan so với chính dòng đó vẽ bằng phông thường (cùng họ) — để so với các dòng khác trên trang
  // base: chuẩn chữ thường của trang — số, hoặc { r, fam } (fam = phông thường của trang, so độ phủ mực theo đúng phông đó
  // để không phụ thuộc phông vừa đoán cho dòng này: đoán nhầm sang phông dày như Verdana thì chữ đậm lại thành "thường")
  const baseR = base && typeof base === 'object' ? base.r : base, baseRef = base && typeof base === 'object' ? base.fam : null;
  const regDens = {}; for (const e of Object.values(all)) if (e.it === best.it) regDens[e.fam] = e.n.dens;
  let reg = (all[baseFam + '|' + best.it] || best).n, ratio = dS / Math.max(1e-6, reg.dens);
  if (baseRef && regDens[baseRef]) ratio = dS / Math.max(1e-6, regDens[baseRef]);
  // có "chuẩn chữ thường" của trang: đậm = dày hẳn hơn các dòng khác (bản photocopy nét nở dày không bị coi là đậm)
  const relBold = baseR > 0 ? ratio > baseR * 1.18 : null;
  ocrStyle.last = { dS, regDens };
  // chữ đậm (tiêu đề): thường cùng họ phông với chữ thường của trang — bản đậm của phông đó khớp gần bằng thì lấy
  // (nét photocopy dày dễ "khớp" nhầm với Verdana / Arial Black)
  if (relBold === true && baseRef && !S.style.ocrFont) {
    const e = all[baseRef + '|' + best.it];
    if (e && e !== best && e.bo.dice >= best.sc - 0.1) { best = e; baseFam = variantBase[best.fam] || best.fam; grp = OCR_WEIGHTS[baseFam]; }
  }
  if (relBold === false && !S.style.ocrFont) {
    // chữ thường: chọn lại họ phông chỉ theo hình dạng bản chữ thường (bản đậm hay "khớp" nhầm với nét photocopy dày)
    let b2 = null;
    for (const e of Object.values(all)) { if (e.it !== best.it || /Semibold|Black/.test(e.fam)) continue; if (!b2 || e.n.dice > b2.n.dice) b2 = e; }
    const pf2 = prefer && all[prefer + '|' + best.it];
    if (pf2 && b2 && pf2 !== b2 && pf2.n.dice >= b2.n.dice - pfMargin) b2 = pf2;
    if (b2) { best = b2; baseFam = variantBase[best.fam] || best.fam; grp = OCR_WEIGHTS[baseFam]; }
  }
  // họ phông có nhiều độ đậm (Light / Semibold / Black…): chọn độ đậm có ảnh xám (đã làm mờ như bản scan) giống nhất
  if (grp && !best.it && !S.style.ocrFont) {
    let cands = grp.map(f => ({ f, b: false })).concat([{ f: baseFam, b: true }]);
    // theo chuẩn của trang: chữ thường → chỉ xét Light / thường; chữ đậm → Semibold / đậm / Black
    if (relBold === false) cands = cands.filter(c => !c.b && !/Semibold|Black/.test(c.f));
    else if (relBold === true) cands = cands.filter(c => c.b || /Semibold|Black/.test(c.f));
    let top = null;
    const scored = cands.map(c => ({ ...c, s: gray(c.f, c.b, false), bl: gray.bl }));
    for (const c of scored) if (!top || c.s > top.s) top = c;
    // chữ ngắn (vd số trong ô bảng): độ đậm các ô đã sửa trên trang mà điểm gần bằng thì lấy theo cho đồng đều
    const pv = preferVar && scored.find(c => (c.f + (c.b ? '|b' : '')) === preferVar);
    if (pv && pv !== top && short && pv.s >= top.s - 0.04) top = pv;
    return { family: top.f, bold: top.b, italic: false, base: baseFam, blur: top.bl, ratio };
  }
  if (relBold !== null) { const f = relBold ? best.fam : baseFam; gray(f, relBold, best.it); return { family: f, bold: relBold, italic: best.it, base: baseFam, blur: gray.bl, ratio }; }
  // chưa có chuẩn của trang: đậm khi bản scan phủ mực nhiều hẳn so với phông thường (scan luôn hơi "nở" mực nên ngưỡng lệch về phía đậm) …
  const bratio = best.bo.dens / Math.max(1e-6, best.n.dens);
  const boldByInk = dS > best.n.dens * Math.max(1.2, Math.pow(bratio, 0.75));
  // … hoặc ảnh xám giống bản đậm hơn bản thường
  const bold = boldByInk || gray(best.fam, true, best.it) > gray(best.fam, false, best.it);
  gray(best.fam, bold, best.it);
  return { family: best.fam, bold, italic: best.it, base: baseFam, blur: gray.bl, ratio };
}
// các độ đậm có sẵn trên Windows của 1 họ phông (tên phông riêng), xếp từ mảnh đến đậm
const OCR_WEIGHTS = {
  'Segoe UI': ['Segoe UI Light', 'Segoe UI', 'Segoe UI Semibold', 'Segoe UI Black'], // (Chrome không nhận tên 'Segoe UI Semilight')
  'Calibri': ['Calibri Light', 'Calibri'],
  'Arial': ['Arial', 'Arial Black'],
};
/* sửa 1 dòng chữ đã nhận dạng: che dòng cũ bằng đúng màu giấy xung quanh, đặt ô chữ mới cùng phông / cỡ / màu / đậm / nghiêng */
/* "Chuẩn chữ thường" của 1 trang scan: lấy mẫu vài dòng dài khác trên trang, đo độ phủ mực so với phông thường.
   Bản photocopy / scan đậm làm nét nở dày → so tuyệt đối thì dòng nào cũng thành "đậm"; so với các dòng khác thì đúng. */
async function ocrPageBase(v, except) {
  const pg = v.page;
  if (pg.ocrBase && pg.ocrBase.v === 3) return pg.ocrBase;
  const cand = (pg.ocr || []).filter(l => l !== except && l.conf >= 85 && [...l.text.replace(/\s/g, '')].length >= 20 && (l.words || []).length >= 4)
    .sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0));
  const pick = []; const step = Math.max(1, Math.floor(cand.length / 6)); for (let i = 0; i < cand.length && pick.length < 6; i += step) pick.push(cand[i]);
  const ms = [];
  for (const l of pick) {
    try { const C = await ocrLineCrop(v, l); const st = ocrStyle(l.text, C.inner2.data, C.X1 - C.X0, C.Y1 - C.Y0, C.thr, C.wordsPx); if (st.ratio > 0 && ocrStyle.last) ms.push({ fam: st.base || st.family, ...ocrStyle.last }); } catch (e) { console.warn('ocrPageBase', e); }
  }
  if (ms.length < 2) return null;
  // phông thường của trang = phông hay gặp nhất trong các dòng mẫu; độ phủ mực so theo đúng phông đó
  const cnt = {}; for (const m of ms) cnt[m.fam] = (cnt[m.fam] || 0) + 1;
  const fam = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
  const rs = ms.filter(m => m.regDens[fam]).map(m => m.dS / m.regDens[fam]).sort((a, b) => a - b);
  if (rs.length < 2) return null;
  const r = rs[rs.length >> 1];
  pg.ocrBase = { v: 3, r, fam };
  return pg.ocrBase;
}
/* đo 1 dòng chữ scan: vẽ riêng vùng dòng ở 4 px / point, màu giấy / mực, làm sạch (bỏ chữ màu khác, đường kẻ), khung từng từ */
async function ocrLineCrop(v, l) {
  const k = 4, padPt = 3, p = await getJsPage(v.page);
  const cw = Math.ceil((l.x1 - l.x0 + 2 * padPt) * k), ch = Math.ceil((l.y1 - l.y0 + 2 * padPt) * k);
  const crop = document.createElement('canvas'); crop.width = cw; crop.height = ch;
  const ctx = crop.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
  await p.render({ canvasContext: ctx, viewport: p.getViewport({ scale: k, rotation: effRot(v.page), offsetX: -(l.x0 - padPt) * k, offsetY: -(l.y0 - padPt) * k }) }).promise;
  const X0 = padPt * k, Y0 = padPt * k, X1 = cw - padPt * k, Y1 = ch - padPt * k;
  // màu giấy: trung vị các điểm ảnh trên viền ngoài khung chữ; màu chữ: trung bình 15% điểm tối nhất bên trong
  const ring = [], pad = Math.round(1.5 * k);
  const take = (x, y, w, h) => { if (w <= 0 || h <= 0) return; const d = ctx.getImageData(x, y, w, h).data; for (let i = 0; i < d.length; i += 4) ring.push([d[i], d[i + 1], d[i + 2]]); };
  take(X0, Y0 - pad, X1 - X0, pad); take(X0, Y1, X1 - X0, pad); take(X0 - pad, Y0, pad, Y1 - Y0); take(X1, Y0, pad, Y1 - Y0);
  const med = i => { const a = ring.map(p => p[i]).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 255; };
  const paper = ring.length ? [med(0), med(1), med(2)] : [255, 255, 255];
  const inner = ctx.getImageData(X0, Y0, Math.max(1, X1 - X0), Math.max(1, Y1 - Y0)).data, px = [];
  for (let i = 0; i < inner.length; i += 4) if (inner[i + 3] > 0) px.push([inner[i], inner[i + 1], inner[i + 2], inner[i] + inner[i + 1] + inner[i + 2]]);
  px.sort((a, b) => a[3] - b[3]);
  // màu chữ: nhóm 4% điểm tối nhất hoặc 4% sáng nhất — nhóm nào khác nền nhiều hơn là chữ
  // (chữ trắng trên ô màu / nền tối thì chữ là nhóm sáng)
  const nE = Math.max(1, Math.round(px.length * 0.04)), avg = a => [0, 1, 2].map(i => Math.round(a.reduce((s, p) => s + p[i], 0) / a.length));
  const lum = c => c[0] + c[1] + c[2], darkC = avg(px.slice(0, nE)), lightC = avg(px.slice(-nE));
  const inv = lum(lightC) - lum(paper) > lum(paper) - lum(darkC);
  const ink = inv ? lightC : darkC;
  let thr = (lum(paper) + lum(ink)) / 2;
  const hex = c => '#' + c.map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
  // vị trí từng từ (điểm ảnh trong vùng chữ) — dòng nhận dạng từ bản cũ không có thì bỏ qua
  // điểm ảnh màu khác hẳn màu mực (vd chữ in sẵn màu xanh của biểu mẫu chạy sát dòng) → coi như giấy, không tính khi đo kiểu chữ
  const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b), inkC = chroma(...ink);
  const fullImg = ctx.getImageData(0, 0, cw, ch), full = fullImg.data;
  for (let i = 0; i < full.length; i += 4) if (chroma(full[i], full[i + 1], full[i + 2]) > Math.max(60, inkC + 50)) { full[i] = paper[0]; full[i + 1] = paper[1]; full[i + 2] = paper[2]; }
  // chữ sáng trên nền tối: đảo màu vùng chữ để phần đo kiểu chữ luôn là "chữ tối trên nền sáng"
  let bg = paper, ulLine = false;
  if (inv) { for (let i = 0; i < full.length; i += 4) { full[i] = 255 - full[i]; full[i + 1] = 255 - full[i + 1]; full[i + 2] = 255 - full[i + 2]; } bg = paper.map(x => 255 - x); thr = 765 - thr; }
  // đường kẻ ngang (gạch chân, đường kẻ bảng): hàng điểm ảnh gần như toàn mực suốt dòng → bỏ, không phải nét chữ
  for (let y = 0; y < ch; y++) {
    let n = 0; for (let x = X0; x < X1; x++) { const i = (y * cw + x) * 4; if (full[i] + full[i + 1] + full[i + 2] < thr) n++; }
    if (n > 0.75 * (X1 - X0) && y > Y0 + 0.55 * (Y1 - Y0)) ulLine = true; // nằm nửa dưới dòng → gạch chân
    if (n > 0.75 * (X1 - X0)) for (let x = 0; x < cw; x++) { const i = (y * cw + x) * 4; full[i] = bg[0]; full[i + 1] = bg[1]; full[i + 2] = bg[2]; }
  }
  const inner2 = new ImageData(Math.max(1, X1 - X0), Math.max(1, Y1 - Y0));
  for (let y = 0; y < inner2.height; y++) inner2.data.set(full.subarray(((Y0 + y) * cw + X0) * 4, ((Y0 + y) * cw + X0 + inner2.width) * 4), y * inner2.width * 4);
  // Tesseract hay cắt mất dấu tiếng Việt khỏi khung từ → đo lại khung theo chính điểm mực trên bản scan (trong dải của dòng)
  const by0 = Math.max(0, Math.floor(Y0 - 0.6 * k)), by1 = Math.min(ch, Math.ceil(Y1 + 0.6 * k));
  const refine = (q, i, arr) => {
    // không nới sang khung của từ bên cạnh
    const lo = i > 0 ? Math.ceil(X0 + (arr[i - 1].x1 - l.x0) * k) : 0, hi = i < arr.length - 1 ? Math.floor(X0 + (arr[i + 1].x0 - l.x0) * k) : cw - 1;
    const cx0 = Math.max(0, Math.floor(X0 + (q.x0 - l.x0) * k)), cx1 = Math.min(cw, Math.ceil(X0 + (q.x1 - l.x0) * k));
    const rows = [];
    for (let y = by0; y < by1; y++) { let n = 0; for (let x = cx0; x < cx1; x++) { const i = (y * cw + x) * 4; if (full[i] + full[i + 1] + full[i + 2] < thr) n++; } rows[y] = n; }
    // hàng phủ gần kín bề ngang của từ = nét gạch chân / gạch ngang, không phải nét chữ → không tính vào chiều cao chữ
    const wpx = Math.max(1, cx1 - cx0);
    // lõi = các hàng trong khung Tesseract; nới lên / xuống theo hàng có mực liền kề (cho phép hở ≤ 2 điểm ảnh: dấu tách rời chữ)
    const cy0 = Math.max(by0, Math.floor(Y0 + (q.y0 - l.y0) * k)), cy1 = Math.min(by1 - 1, Math.ceil(Y0 + (q.y1 - l.y0) * k) - 1);
    // gạch chân: hàng gần kín bề ngang từ, nằm ở đáy khung từ trở xuống (chân chữ có chân serif thì không kín đến vậy)
    let ul = false;
    if (wpx > 3 * k) {
      const yEnd = Math.min(ch, Math.ceil(Y1 + 0.35 * (Y1 - Y0))); // gạch chân có thể nằm thấp hơn khung dòng một chút
      for (let y = Math.max(by0, cy1 - 1); y < yEnd && !ul; y++) {
        let n = rows[y]; if (n == null) { n = 0; for (let x = cx0; x < cx1; x++) { const i = (y * cw + x) * 4; if (full[i] + full[i + 1] + full[i + 2] < thr) n++; } }
        if (n > 0.75 * wpx) ul = true;
      }
    }
    if (wpx > 3 * k) for (let y = by0; y < by1; y++) if (rows[y] > 0.85 * wpx || (ul && y >= cy1 - 1 && rows[y] > 0.6 * wpx)) rows[y] = 0;
    let a = -1, b = -1; for (let y = cy0; y <= cy1; y++) if (rows[y]) { if (a < 0) a = y; b = y; }
    if (a < 0) return q;
    const ca = a, cb = b; // hàng lõi: dùng để nới ngang (không bám theo gạch chân / đường kẻ ở dưới)
    for (let y = a - 1, gap = 0; y >= by0 && gap <= 2; y--) { if (rows[y]) { a = y; gap = 0; } else gap++; }
    for (let y = b + 1, gap = 0; y < by1 && gap <= 2; y++) { if (rows[y]) { b = y; gap = 0; } else gap++; }
    let c = -1, d = -1;
    const colInk = x => { for (let y = ca; y <= cb; y++) { const i = (y * cw + x) * 4; if (full[i] + full[i + 1] + full[i + 2] < thr) return true; } return false; };
    for (let x = cx0; x < cx1; x++) if (colInk(x)) { if (c < 0) c = x; d = x; }
    if (c < 0) return q;
    // khung Tesseract hụt mất chữ đầu / cuối → nới ngang theo nét mực liền kề (khe giữa 2 chữ cái nhỏ hơn khoảng cách giữa 2 từ)
    const maxGap = Math.max(2, Math.round(0.14 * (l.y1 - l.y0) * k));
    for (let x = d + 1, gap = 0; x <= hi && gap <= maxGap; x++) { if (colInk(x)) { d = x; gap = 0; } else gap++; }
    for (let x = c - 1, gap = 0; x >= lo && gap <= maxGap; x--) { if (colInk(x)) { c = x; gap = 0; } else gap++; }
    return c < 0 ? q : { t: q.t, ul, x0: l.x0 + (c - X0) / k, x1: l.x0 + (d + 1 - X0) / k, y0: l.y0 + (a - Y0) / k, y1: l.y0 + (b + 1 - Y0) / k };
  };
  // bỏ khung từ trùm lên từ khác (Tesseract gộp nhầm "loại : Acacia" …) — giữ khung nhỏ nằm bên trong
  const W0 = (l.words || []).filter(q => q.t && q.x1 > q.x0 && q.y1 > q.y0);
  const ov = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const W = W0.filter(q => !W0.some(o => o !== q && (o.x1 - o.x0) < (q.x1 - q.x0) && ov(q, o) > 0.5 * (o.x1 - o.x0))).sort((a, b) => a.x0 - b.x0).map(refine);
  const wordsOk = W.length === W0.length;
  const wordsPx = W.map(q => ({ t: q.t, x0: (q.x0 - l.x0) * k, y0: (q.y0 - l.y0) * k, x1: (q.x1 - l.x0) * k, y1: (q.y1 - l.y0) * k }));
  // dòng có gạch chân: nét gạch kín cả dòng, hoặc phần lớn các từ có gạch dưới chân
  const underline = ulLine || (W.length >= 2 && W.filter(q => q.ul).length >= 0.6 * W.length);
  return { k, cw, ch, X0, Y0, X1, Y1, paper, ink, thr, inner2, W, wordsOk, wordsPx, hex, underline };
}
async function editOcrLine(v, l, pt) {
  showOcrHover(v, null);
  // chuẩn chữ thường của trang (lần đầu trên mỗi trang: đo vài dòng mẫu, ~1–2 giây)
  let base = v.page.ocrBase && v.page.ocrBase.v === 3 ? v.page.ocrBase : null;
  if (base == null && (v.page.ocr || []).length > 3) { busy(true, 'Đang đo kiểu chữ của trang…'); try { base = await ocrPageBase(v, l); } finally { busy(false); } }
  const crop = await ocrLineCrop(v, l);
  const { k, paper, ink, W, wordsOk, hex, underline } = crop;
  const { st, font, bold, italic, fs, cs, meas, mctx } = ocrFit(v, l, crop, base, true);
  const h = l.y1 - l.y0, mid = a => { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
  // khoảng trống giữa các từ: bản gốc cách rộng (vd 2 dấu cách) thì giữ đúng số dấu cách
  let text = l.text;
  if (W.length > 1 && wordsOk) {
    const unit = (meas(' ').adv + cs / 1000) * fs;
    // dòng căn đều 2 bên: mọi khoảng trống đều rộng như nhau → vẫn là 1 dấu cách; chỉ chỗ rộng hẳn hơn các chỗ khác mới là nhiều dấu cách
    const gaps = W.slice(1).map((b, i) => b.x0 - W[i].x1), medGap = mid(gaps);
    text = W[0].t;
    for (let i = 1; i < W.length; i++) {
      const a = W[i - 1], b = W[i], ma = meas(a.t), mb = meas(b.t);
      const gap1 = ((ma.adv - ma.ink + ma.L) - mb.L) * fs + unit + cs / 1000 * fs; // khoảng ink→ink với 1 dấu cách
      const g = b.x0 - a.x1, nsp = g < gap1 * 1.8 || g < medGap * 2 ? 1 : Math.max(1, Math.min(4, Math.round(1 + (g - Math.max(gap1, medGap)) / Math.max(0.5, unit))));
      text += ' '.repeat(nsp) + b.t;
    }
  }
  const m = mctx.measureText(text);
  // trang có thể đã được dựng lại trong lúc đo (đổi cỡ cửa sổ / zoom) → lấy lại khung vẽ hiện tại của trang
  if (!v.fc || !S.views.has(v.page.id) || S.views.get(v.page.id) !== v) { const nv = S.views.get(v.page.id); if (!nv) return; await ready(nv); v = nv; }
  if (!v.fc) return;
  const fc = v.fc;
  const cover = new fabric.Rect({ left: l.x0 - 1.5, top: l.y0 - 1.2, width: l.x1 - l.x0 + 3, height: h + 2.4 + (underline ? Math.max(2, h * 0.35) : 0), fill: hex(paper), strokeWidth: 0, kind: 'whiteout', originX: 'left', originY: 'top' });
  // đặt sao cho đỉnh chữ thật trùng đỉnh khung OCR: top của IText = đường chân chữ - phần trên chân chữ của ô fabric
  // chân chữ: theo từng từ (đỉnh từ + phần trên chân chữ của từ đó) lấy trung vị — đỡ lệch vì dấu tiếng Việt cao thấp khác nhau
  const baseline = W.length ? mid(W.map(q => q.y0 + meas(q.t).asc * fs)) : l.y0 + m.actualBoundingBoxAscent / 100 * fs;
  const t = new fabric.IText(text, { left: l.x0 - (m.actualBoundingBoxLeft ? -m.actualBoundingBoxLeft / 100 * fs : 0), top: baseline - fs * BASE_K, originX: 'left', originY: 'top', fontFamily: font, fontSize: fs,
    fill: hex(ink), fontWeight: bold ? 'bold' : 'normal', fontStyle: italic ? 'italic' : 'normal', charSpacing: cs, kind: 'text', underline: !!underline,
    // nhoè như bản scan (point) — phép đo hay ra lớn hơn thật (bù cả nét mảnh) nên giảm bớt, tối đa 0,25pt kẻo chữ nhạt đi
    ocrBlur: Math.round(Math.min(0.15, (st.blur || 0) / k * 0.4) * 100) / 100, objectCaching: false,
    ocrSrc: { x0: l.x0, y0: l.y0, text } }); // nhớ dòng OCR gốc: sửa chữ xong thì đo lại kiểu chữ theo chữ đúng
  ensureFontOption(t.fontFamily);
  l.done = true; t._cover = cover;
  t.set({ lockMovementX: true, lockMovementY: true, hasControls: false }); // cố định vị trí như chữ gốc
  v.loading = true; fc.add(cover); fc.add(t); v.loading = false;
  setTool('select'); fc.setActiveObject(t); t.enterEditing();
  // con trỏ ở chỗ bấm
  const cb = (t.__charBounds && t.__charBounds[0]) || [], lx = pt.x - l.x0;
  let ci = text.length; for (let i = 0; i < cb.length - 1; i++) if (lx < cb[i].left + cb[i].width / 2) { ci = i; break; }
  t.selectionStart = t.selectionEnd = Math.max(0, Math.min(text.length, ci)); t._updateTextarea && t._updateTextarea();
  OCR_TAIL(v, l, t, text, fc);
}
/* Đo kiểu chữ (phông, đậm, nghiêng, cỡ, khoảng cách chữ) của 1 dòng scan theo chữ `l.text`.
   record: ghi lại vào thống kê của trang (phông / cỡ hay gặp) — chỉ khi sửa lần đầu */
function ocrFit(v, l, crop, base, record) {
  const { X0, Y0, X1, Y1, thr, inner2, W, wordsPx } = crop;
  // phông hay gặp nhất trên trang (từ các dòng dài đã sửa trước) — gợi ý cho dòng ngắn khó đoán
  const isShort = [...l.text.replace(/\s/g, '')].length < 12;
  // độ đậm hay gặp nhất của các dòng NGẮN đã sửa (vd số trong ô bảng)
  const vt = v.page.ocrVars || {}, preferVar = Object.keys(vt).sort((a, b) => vt[b] - vt[a])[0];
  const baseOf = f => { f = f.replace(/\|b$/, ''); for (const [b0, arr] of Object.entries(OCR_WEIGHTS)) if (arr.includes(f)) return b0; return f; };
  const tally = v.page.ocrFonts || {}, prefer = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] || (isShort && preferVar ? baseOf(preferVar) : undefined);
  const st = ocrStyle(l.text, inner2.data, X1 - X0, Y1 - Y0, thr, wordsPx, prefer, preferVar, base);
  if (record && !isShort) { tally[st.base || st.family] = (tally[st.base || st.family] || 0) + 1; v.page.ocrFonts = tally; }
  else if (record) { const key = st.family + (st.bold ? '|b' : ''); vt[key] = (vt[key] || 0) + 1; v.page.ocrVars = vt; }
  const font = st.family, bold = st.bold, italic = st.italic;
  const fstr = s => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${s}px "${font}"`;
  const mctx = document.createElement('canvas').getContext('2d'); mctx.font = fstr(100);
  const meas = s => { const q = mctx.measureText(s); return { asc: q.actualBoundingBoxAscent / 100, desc: q.actualBoundingBoxDescent / 100, L: q.actualBoundingBoxLeft / 100, ink: ((q.actualBoundingBoxLeft + q.actualBoundingBoxRight) || q.width) / 100, adv: q.width / 100 }; };
  // cỡ chữ: chiều cao chữ thật (đỉnh dấu → chân chữ) của từng từ / chiều cao cùng từ đó trong phông đã nhận ra → lấy trung vị
  const h = l.y1 - l.y0, mid = a => { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
  // mỗi từ: cỡ theo chiều cao và theo chiều rộng, lấy cái nhỏ hơn — chiều cao hay bị gạch chân / dấu thanh làm tăng giả,
  // chiều rộng thì không (cho phép nét scan nở rộng thêm ~4%)
  const fsArr = W.filter(q => [...q.t].length >= 2).map(q => { const mm = meas(q.t); const fh = (q.y1 - q.y0) / ((mm.asc + mm.desc) || 0.9), fw = (q.x1 - q.x0) / (mm.ink || 1) / 1.04; return [...q.t].length < 3 ? fh : fh > fw * 1.12 ? fw : (fh + fw) / 2; });
  const mLine = meas(l.text);
  let fs = Math.max(4, Math.round((fsArr.length ? mid(fsArr) : h / ((mLine.asc + mLine.desc) || 0.9)) * 2) / 2);
  // chữ ngắn (số trong ô bảng): cỡ đo dễ lệch ±0,5–1pt → lấy cỡ hay gặp nhất của các ô cùng kiểu đã sửa nếu gần bằng
  if (isShort) {
    const sk = font + (bold ? '|b' : ''), sz = (v.page.ocrSizes = v.page.ocrSizes || {}), m0 = sz[sk] || {};
    const common = Object.keys(m0).map(Number).sort((a, b) => m0[b] - m0[a])[0];
    if (common && Math.abs(common - fs) <= 1) fs = common;
    if (record) { m0[fs] = (m0[fs] || 0) + 1; sz[sk] = m0; }
  }
  // khoảng cách chữ (trong từ) cho từ mới dài đúng bằng từ trên bản scan
  let cs = 0;
  if (W.length) {
    // bỏ các từ khung lệch hẳn (nhận dạng sót / thừa ký tự) — trung vị độ chênh mỗi khoảng chữ
    const per = W.map(q => { const g = [...q.t].length - 1, fw = meas(q.t).ink * fs; return g >= 1 && (q.x1 - q.x0) / fw > 0.75 && (q.x1 - q.x0) / fw < 1.35 ? ((q.x1 - q.x0) - fw) / g : null; }).filter(x => x != null);
    cs = per.length ? mid(per) / fs * 1000 : 0;
  } else cs = ((l.x1 - l.x0) - mLine.ink * fs) / Math.max(1, [...l.text].length - 1) / fs * 1000;
  cs = Math.abs(cs) < 15 ? 0 : Math.round(Math.max(-120, Math.min(300, cs)));
  return { st, font, bold, italic, fs, cs, meas, mctx };
}
// sau khi tạo ô chữ OCR: tô đỏ các từ nghi đọc sai (chỉ lúc đang sửa — tự bỏ khi thoát sửa, không lưu vào file)
function OCR_TAIL(v, l, t, text, fc) {
  const bad = [];
  let from = 0;
  if (OCR_FLAGS) for (const w of l.words || []) { const i = text.indexOf(w.t, from); if (i < 0) continue; from = i + w.t.length; if (ocrSuspicious(w)) { bad.push(w.t); t.setSelectionStyles({ textBackgroundColor: OCR_MARK }, i, i + w.t.length); } }
  t.ocrMarked = bad.length > 0;
  drawOcrFlags(v);
  fc.requestRenderAll(); syncView(v); S.activeView = v; refreshProps();
  if (bad.length) toast(`Có thể đọc sai (tô đỏ): ${bad.slice(0, 6).join(', ')}${bad.length > 6 ? '…' : ''} — kiểm tra lại`, 5000);
  else if (OCR_FLAGS && l.conf < 70) toast(`Dòng này nhận dạng chưa chắc chắn (${l.conf}%) — kiểm tra lại chữ trước khi sửa`, 4000);
  if (window.PdfExtra) PdfExtra.afterOcrEdit(v, l, t); // gợi ý chữ đúng + nút "Sửa cả đoạn"
}
// bỏ tô đỏ đánh dấu OCR khỏi chữ
function clearOcrMarks(t) {
  if (!t || !t.styles) return;
  for (const ln of Object.values(t.styles)) for (const [ci, st] of Object.entries(ln)) {
    if (st.textBackgroundColor === OCR_MARK) { delete st.textBackgroundColor; if (!Object.keys(st).length) delete ln[ci]; }
  }
  t.ocrMarked = false; t.dirty = true;
}
/* 10. Sửa chữ OCR xong (vd "PILU" → "ĐIỀU"): đo lại phông / đậm / nghiêng / cỡ theo CHỮ ĐÚNG trên đúng vùng scan đó.
   Chỉ khi số từ không đổi (để khớp từng từ với vị trí trên bản scan). */
async function ocrRestyle(v, t) {
  const src = t.ocrSrc; if (!src || !v.page.src) return;
  const now = t.text.replace(/\s+/g, ' ').trim(), was = (src.text || '').replace(/\s+/g, ' ').trim();
  if (!now || now === was) return;
  const l = (v.page.ocr || []).find(x => Math.abs(x.x0 - src.x0) < 0.5 && Math.abs(x.y0 - src.y0) < 0.5); if (!l) return;
  const toks = now.split(' ');
  if (!l.words || toks.length !== l.words.length) { t.ocrSrc = { ...src, text: t.text }; return; }
  const l2 = { ...l, text: now, words: l.words.map((w, i) => ({ ...w, t: toks[i] })) };
  try {
    const base = v.page.ocrBase && v.page.ocrBase.v === 3 ? v.page.ocrBase : null;
    const crop = await ocrLineCrop(v, l2);
    // lần đo đầu (theo chữ đọc sai) đã ghi phông vào thống kê của trang → bỏ phiếu đó trước khi đo lại
    const tally = v.page.ocrFonts || {}, of = t.fontFamily;
    if (tally[of] > 0) { if (--tally[of] === 0) delete tally[of]; }
    const F = ocrFit(v, l2, crop, base, false);
    if ([...now.replace(/\s/g, '')].length >= 12) tally[F.st.base || F.font] = (tally[F.st.base || F.font] || 0) + 1;
    v.page.ocrFonts = tally;
    const old = { f: t.fontFamily, b: t.fontWeight, i: t.fontStyle, s: t.fontSize };
    const baseline = t.top + t.fontSize * BASE_K; // giữ nguyên đường chân chữ
    t.set({ fontFamily: F.font, fontWeight: F.bold ? 'bold' : 'normal', fontStyle: F.italic ? 'italic' : 'normal', fontSize: F.fs, charSpacing: F.cs, top: baseline - F.fs * BASE_K });
    t.ocrSrc = { ...src, text: t.text };
    ensureFontOption(F.font); t.initDimensions && t.initDimensions(); t.setCoords();
    const vv = S.views.get(v.page.id) || v; vv.fc && vv.fc.requestRenderAll(); syncView(vv); refreshProps();
    if (old.f !== F.font || old.b !== t.fontWeight || old.i !== t.fontStyle || old.s !== F.fs)
      toast(`Đã đo lại kiểu chữ theo chữ đã sửa: ${F.font}${F.bold ? ' đậm' : ''}${F.italic ? ' nghiêng' : ''} ${F.fs}pt`, 3500);
  } catch (e) { console.warn('ocrRestyle', e); }
}

async function editAt(v, pt, skipText) { // chữ trước, rồi nét vẽ, rồi ảnh
  if (!v.page.src) return toast('Trang này không có nội dung gốc để sửa — dùng "Thêm chữ"');
  v.lastPt = pt;
  const T = await pageTextItems(v);
  if (!skipText && findRun(T, pt)) return editTextAt(v, pt);
  const ol = !skipText && findOcr(v.page, pt); if (ol) return editOcrLine(v, ol, pt);
  const V = await pageVectorItems(v), I = await pageImageItems(v);
  const r = findVector(V, pt), im = findImage(I, pt);
  if (r && !r.big) return extractContent(v, [r], [], r);
  if (im && isBigImage(v, im) && !skipText && !v.page.ocr && confirm('Trang này là ảnh scan — chữ nằm trong ảnh nên chưa sửa được.\n\nNhận dạng chữ (OCR) trang này để sửa được từng dòng chữ?')) {
    await ocrPage(v.page); setTool('select');
    const l2 = findOcr(v.page, pt); if (l2) return editOcrLine(v, l2, pt);
    return toast(`Đã nhận dạng ${(v.page.ocr || []).length} dòng — bấm vào dòng chữ để sửa`, 4000);
  }
  if (im && isBigImage(v, im)) { // ảnh nền cả trang: tách ra sẽ đè lên chữ -> sửa tại chỗ bằng công cụ Tẩy ảnh
    S.eraseTarget = null; setTool('erase');
    return toast('Đây là ảnh nền cả trang (viền, hình mờ…). Đã chuyển sang "Tẩy ảnh": kéo khung lên phần muốn xoá (vd hình mờ ở giữa) — chữ và bảng vẫn giữ nguyên.', 6000);
  }
  if (im) return editImageAt(v, pt);
  if (r) return extractContent(v, [r], [], r);
  toast('Không có chữ, hình hay ảnh tại vị trí này (ảnh scan liền khối thì dùng "Xoá trắng" + "Thêm chữ").', 3500);
}
/* Công cụ Tẩy ảnh: kéo khung -> xoá vùng đó trên ảnh (thành trong suốt).
   Ảnh đã tách (đối tượng) thì tẩy trên đối tượng; ảnh gốc trong PDF (vd ảnh nền có viền + hình mờ) thì sửa tại chỗ,
   giữ nguyên vị trí và thứ tự lớp (chữ, bảng vẫn nằm trên). */
async function eraseAt(v, x, y, w, h) {
  const P = new fabric.Point((x + w / 2) * S.zoom, (y + h / 2) * S.zoom);
  let img = S.eraseTarget && v.fc.getObjects().includes(S.eraseTarget) ? S.eraseTarget : v.fc.getObjects().filter(o => o.type === 'image' && o.kind !== 'region' && o.containsPoint(P)).pop();
  if (img) return eraseOnImage(v, x, y, w, h, img);
  const pg = v.page; if (!pg.src) return toast('Không có ảnh dưới khung');
  const I = await pageImageItems(v), im = findImage(I, { x: x + w / 2, y: y + h / 2 });
  if (!im) return toast('Không có ảnh dưới khung (phần này là chữ / nét vẽ — dùng Sửa nội dung để xoá)', 3500);
  busy(true, 'Đang tẩy…');
  try {
    const c = await imageCanvas(I.p, im), W = c.width, H = c.height, ctx = c.getContext('2d');
    const { P0, P1, P3 } = im, ax = P1[0] - P0[0], ay = P1[1] - P0[1], bx = P3[0] - P0[0], by = P3[1] - P0[1], det = ax * by - ay * bx;
    const toPx = (px, py) => { const dx = px - P0[0], dy = py - P0[1]; return [(dx * by - dy * bx) / det * W, (ax * dy - ay * dx) / det * H]; };
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(q => toPx(...q)).forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath(); ctx.fill();
    const id = nid('im'); S.imgStore.set(id, c.toDataURL('image/png'));
    const bb = im.bb, same = e => Math.abs(e.x0 - bb.x0) < 1.5 && Math.abs(e.y0 - bb.y0) < 1.5 && Math.abs(e.x1 - bb.x1) < 1.5 && Math.abs(e.y1 - bb.y1) < 1.5;
    pg.imgEdits = (pg.imgEdits || []).filter(e => !same(e)).concat([{ id, x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 }]);
    commit();
    v.tc = null; v.titems = null; v.titemsVal = null; v.imgs = null; v.imgsVal = null; v.vecs = null; v.vecsVal = null;
    await refreshPdfLayer(v);
  } catch (e) { console.error(e); toast('Không tẩy được ảnh này'); }
  finally { busy(false); }
}
async function eraseOnImage(v, x, y, w, h, img) {
  const el = img.getElement(), W = el.naturalWidth || el.width, H = el.naturalHeight || el.height;
  const inv = fabric.util.invertTransform(img.calcTransformMatrix());
  const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => { const q = fabric.util.transformPoint(new fabric.Point(px, py), inv); return [q.x + img.width / 2, q.y + img.height / 2]; });
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
  ctx.drawImage(el, 0, 0);
  const sx = W / img.width, sy = H / img.height;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(px * sx, py * sy) : ctx.moveTo(px * sx, py * sy))); ctx.closePath(); ctx.fill();
  await new Promise(res => img.setSrc(c.toDataURL('image/png'), res));
  img.setCoords(); v.fc.requestRenderAll(); syncView(v);
}
function downloadSelectedImage() {
  const o = activeObjs()[0]; if (!o || o.type !== 'image') return;
  const src = o.getSrc(); const ext = /^data:image\/jpe?g/i.test(src) ? 'jpg' : 'png';
  fetch(src).then(r => r.blob()).then(b => downloadBlob(b, `${baseName()}-anh.${ext}`));
}
async function replaceSelectedImage(file) {
  const v = S.activeView, o = activeObjs()[0]; if (!v || !o || o.type !== 'image') return;
  const url = await readAsDataURL(file); const el = await loadImg(url);
  const w = o.getScaledWidth(), h = o.getScaledHeight(), s = Math.min(w / el.width, h / el.height);
  // ảnh mới nằm gọn trong khung ảnh cũ, căn giữa
  const center = o.getCenterPoint();
  await new Promise(res => o.setSrc(url, res));
  o.set({ scaleX: s, scaleY: s, flipX: false, flipY: false }); o.setPositionByOrigin(center, 'center', 'center'); o.setCoords();
  v.fc.requestRenderAll(); syncView(v);
}
async function editTextAt(v, pt) {
  const pg = v.page; if (!pg.src) return toast('Trang này không có chữ gốc để sửa — dùng "Thêm chữ"');
  showHover(v, null);
  const T = await pageTextItems(v), vp = T.vp, p = T.p;
  const run = findRun(T, pt);
  if (!run) return toast('Không có chữ tại vị trí này. Chữ dạng nét vẽ / ảnh scan thì dùng "Xoá trắng" + "Thêm chữ".', 3500);
  const { hit, str, x0, x1 } = run, fh = hit.fh;
  const angDeg = Math.round(hit.ang * 180 / Math.PI * 100) / 100;

  // vùng chữ cũ (toạ độ user space của PDF) -> phân tích phông/cỡ/màu rồi xoá thật khỏi trang
  const corners = [[x0 - 0.5, -fh], [x1 + 0.5, -fh], [x0 - 0.5, fh * 0.35], [x1 + 0.5, fh * 0.35]].map(([lx, ly]) => vp.convertToPdfPoint(...toDisp(hit, lx, ly)));
  const region = { x0: Math.min(...corners.map(c => c[0])), y0: Math.min(...corners.map(c => c[1])), x1: Math.max(...corners.map(c => c[0])), y1: Math.max(...corners.map(c => c[1])) };
  let hits = [];
  try { const lib = await getLib(pg.src); hits = TextOps.analyze(lib, lib.getPage(pg.index), [region]); } catch (e) { console.warn('analyze', e); }
  const glyphs = hits.filter(h => !h.space);
  const g0 = glyphs[0] || hits[0];

  // phông, đậm, nghiêng, cỡ, màu giữ như chữ gốc
  let pdfFont = g0 ? g0.font : '';
  if (!pdfFont) { try { const f = p.commonObjs.get(hit.it.fontName); pdfFont = (f && f.name) || ''; } catch (e) {} }
  // tên phông nhúng chung chung (vd "CIDFont+F1", "F1", "T1_0") → không đoán theo tên, nhận theo hình dạng chữ trên trang
  const genericName = !pdfFont || isGenericFontName(pdfFont);
  let family = genericName ? null : matchFamily(pdfFont), shapeFont = null;
  if (genericName) {
    busy(true, 'Đang nhận dạng phông chữ…');
    try { shapeFont = await fontByShape(v, T, hit.it.fontName); } catch (e) { console.warn('fontByShape', e); } finally { busy(false); }
    if (shapeFont) family = shapeFont.family;
  }
  if (!family && pdfFont && !genericName) { busy(true, 'Đang tìm phông miễn phí trên Google Fonts…'); try { family = await webFontFor(pdfFont); } finally { busy(false); } if (family) toast(`Đã tải phông miễn phí "${family}" từ Google Fonts`, 3000); }
  else if (family) await ensureFaceLoaded(family);
  if (!family) {
    const fam = (v.tc.styles[hit.it.fontName] || {}).fontFamily || '';
    family = fam === 'monospace' ? 'Courier New' : fam === 'serif' ? 'Times New Roman' : 'Arial';
    if (pdfFont && !genericName) toast(`Máy chưa cài phông "${pdfFont.replace(/^[A-Z]{6}\+/, '')}" — tạm dùng ${family}`, 3500);
  }
  ensureFontOption(family);
  let bold = g0 ? g0.bold : /bold|black|heavy/i.test(pdfFont), italic = g0 ? g0.italic : /italic|oblique/i.test(pdfFont);
  if (shapeFont) { bold = shapeFont.bold; italic = shapeFont.italic; }
  const sizes = glyphs.map(h => h.size).sort((a, b) => a - b);
  const fs = Math.round((sizes.length ? sizes[sizes.length >> 1] : fh) * 100) / 100;
  const hexC = c => '#' + c.map(x => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
  // màu từng ký tự (dòng có đoạn màu khác, vd chữ xanh giữa dòng) — màu chính = màu nhiều nhất
  const gcols = glyphs.map(h => hexC(h.color)), cnt = {}; gcols.forEach(x => { cnt[x] = (cnt[x] || 0) + 1; });
  const color = gcols.length ? Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] : hexC(g0 ? g0.color : [0, 0, 0]);
  const multiColor = Object.keys(cnt).length > 1;

  // căn lề: so với các dòng lân cận cùng hướng (toạ độ theo hệ trục của dòng chữ)
  const local = T.items.filter(a => sameDir(a, hit)).map(a => { const [x, y] = toLocal(hit, a.ox, a.oy); return { it: a.it, x, yb: y, fh: a.fh, w: a.w }; });
  const horiz = Math.abs(hit.ang) < 0.03;
  const align = guessAlign(local, { x0, x1, yb: 0, fh, str },horiz ? dispSize(pg)[0] / 2 - hit.ox : null);
  const anchorLx = align === 'center' ? (x0 + x1) / 2 : align === 'right' ? x1 : x0;
  const [ax, ay] = toDisp(hit, anchorLx, -fs * BASE_K);

  const fc = v.fc;
  // vị trí mực của chữ gốc (trước khi xoá) — để đặt chữ mới trùng khít, không lệch
  const horizLine = Math.abs(hit.ang) < 0.002;
  const inkBox = horizLine ? { x: hit.ox + x0 - 1, y: hit.oy - fh * 1.15, w: (x1 - x0) + 2, h: fh * 1.6 } : null;
  let inkOrig = null;
  if (inkBox) { try { inkOrig = await inkOfPage(pg, inkBox); } catch (e) { console.warn('ink', e); } }
  const removed = hits.length > 0;
  if (removed) { pg.del = (pg.del || []).concat([region]); }
  const coverRect = () => { const [cx, cy] = toDisp(hit, x0 - 1.5, -fh * 0.98); return new fabric.Rect({ left: cx, top: cy, angle: angDeg, width: (x1 - x0) + 3, height: fh * 1.28, fill: '#ffffff', strokeWidth: 0, kind: 'whiteout', originX: 'left', originY: 'top' }); };
  const t = new fabric.IText(str, { left: ax, top: ay, angle: angDeg, originX: align, originY: 'top', fontFamily: family, fontSize: fs, fill: color,
    fontWeight: bold ? 'bold' : 'normal', fontStyle: italic ? 'italic' : 'normal', textAlign: align, kind: 'text' });
  // giữ đúng bề ngang như chữ gốc: (1) chữ bị kéo giãn / ép ngang trong PDF → scaleX; (2) khoảng cách chữ (Tc) → charSpacing
  const sx = hit.sx && Math.abs(hit.sx - 1) > 0.01 && hit.sx > 0.3 && hit.sx < 3 ? Math.round(hit.sx * 10000) / 10000 : 1;
  if (sx !== 1) t.set({ scaleX: sx });
  const nch = [...str].length;
  if (nch > 2 && t.width > 0) {
    const gap = (x1 - x0) - t.width * sx; // phần còn chênh sau khi giãn ngang
    if (Math.abs(gap) > (x1 - x0) * 0.01) {
      const csv = Math.round(gap / (nch - 1) / (fs * sx) * 1000);
      if (Math.abs(csv) <= 250) t.set({ charSpacing: csv });
    }
  }
  t.initDimensions && t.initDimensions();
  // đặt khít: dời chữ mới cho mép trái mực + đường chân chữ trùng đúng chữ gốc (phông trên máy khác phông nhúng một chút)
  if (inkOrig) {
    try {
      let inkNew = inkOfText(t);
      if (inkNew) { // bề ngang mực: chỉnh giãn ngang cho 2 mép mực trùng nhau
        const f = (inkOrig.right - inkOrig.left) / Math.max(0.1, inkNew.right - inkNew.left);
        if (Math.abs(f - 1) > 0.0005 && Math.abs(f - 1) < 0.03) { t.set({ scaleX: (t.scaleX || 1) * f }); t.setCoords(); inkNew = inkOfText(t); }
      }
      if (inkNew) { const dx = inkOrig.left - inkNew.left, dy = inkOrig.base - inkNew.base; if (Math.abs(dx) < fs * 0.6) t.set({ left: t.left + dx }); if (Math.abs(dy) < fs * 0.4) t.set({ top: t.top + dy }); t.setCoords(); }
    } catch (e) { console.warn('ink', e); }
  }
  // chữ sửa từ chữ gốc: cố định vị trí (không kéo lệch khi bấm / bôi đen)
  t.set({ lockMovementX: true, lockMovementY: true, hasControls: false });
  // chữ gốc vẽ kiểu "tô + viền" (Tr 2, hay dùng để làm đậm giả) → giữ nét viền cùng màu, cùng độ dày
  const g2 = glyphs.find(h => h.mode === 2 && h.lw > 0);
  if (g2) t.set({ stroke: hexC(g2.strokeColor || g2.color), strokeWidth: Math.round(g2.lw * 1000) / 1000, paintFirst: 'fill', strokeLineJoin: 'round' });
  if (multiColor) { // giữ màu riêng từng đoạn: hình chữ gốc nằm ở ô ký tự nào của dòng mới thì ký tự đó mang màu của nó
    const cb = (t.__charBounds && t.__charBounds[0]) || [], st = {};
    const start = align === 'left' ? x0 : align === 'center' ? (x0 + x1) / 2 - t.width * sx / 2 : x1 - t.width * sx;
    for (const h of glyphs) {
      const [dx, dy] = vp.convertToViewportPoint((h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2), lx = (toLocal(hit, dx, dy)[0] - start) / sx;
      const ci = cb.findIndex(b => lx >= b.left && lx < b.left + b.width);
      const colr = hexC(h.color); if (ci >= 0 && colr !== color && str[ci] && str[ci].trim()) st[ci] = g2 ? { fill: colr, stroke: colr } : { fill: colr };
    }
    if (Object.keys(st).length) { t.styles = { 0: st }; t.dirty = true; }
  }
  v.loading = true;
  if (!removed) fc.add(coverRect());
  fc.add(t); v.loading = false;
  setTool('select'); fc.setActiveObject(t); t.enterEditing();
  // đặt con trỏ đúng chỗ bấm (không bôi đen cả dòng)
  const start = align === 'left' ? x0 : align === 'center' ? (x0 + x1) / 2 - t.width * sx / 2 : x1 - t.width * sx;
  const lx = (toLocal(hit, pt.x, pt.y)[0] - start) / sx, cb = (t.__charBounds && t.__charBounds[0]) || [];
  let ci = str.length; for (let i = 0; i < cb.length - 1; i++) if (lx < cb[i].left + cb[i].width / 2) { ci = i; break; }
  t.selectionStart = t.selectionEnd = Math.max(0, Math.min(str.length, ci)); t._updateTextarea && t._updateTextarea();
  fc.requestRenderAll();
  syncView(v);
  if (removed) {
    v.tc = null; v.titems = null; v.titemsVal = null; v.imgs = null; v.imgsVal = null; v.vecs = null; v.vecsVal = null; await refreshPdfLayer(v);
    // kiểm tra chữ cũ còn sót (vd phông mã hoá lạ) -> che trắng phần còn sót để không bị chồng chữ nhoè
    try {
      const T2 = await pageTextItems(v);
      const left = T2.items.some(a => {
        if (!a.it.str.trim() || !sameDir(a, hit)) return false;
        const [lx2, ly2] = toLocal(hit, ...toDisp(a, a.w / 2, -a.fh * 0.35));
        return lx2 > x0 && lx2 < x1 && ly2 > -fh && ly2 < fh * 0.35;
      });
      if (left) {
        v.loading = true; fc.insertAt(coverRect(), Math.max(0, fc.getObjects().indexOf(t)), false); v.loading = false;
        fc.requestRenderAll(); syncView(v);
      }
    } catch (e) { console.warn(e); }
  }
  else toast('Chữ này nằm trong đối tượng lồng (XObject) — đã che trắng thay vì xoá', 3500);
}
/* mép trái mực + đường chân chữ (hàng mà nhiều cột mực kết thúc nhất) của 1 vùng ảnh — toạ độ trang (point) */
const INK_K = 8;
function inkMeasure(c, ox, oy, k) {
  const W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  let left = -1, right = -1; const bot = new Int32Array(W).fill(-1);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) { const i = (y * W + x) * 4; if (d[i + 3] > 60 && d[i] + d[i + 1] + d[i + 2] < 600) { if (left < 0) left = x; right = x; bot[x] = y; } }
  if (left < 0) return null;
  const cnt = new Map(); for (const b of bot) if (b >= 0) cnt.set(b, (cnt.get(b) || 0) + 1);
  let base = -1, best = 0; for (const [y, n] of cnt) if (n > best || (n === best && y > base)) { best = n; base = y; }
  return { left: ox + left / k, right: ox + (right + 1) / k, base: oy + (base + 1) / k };
}
async function inkOfPage(pg, box) {
  const k = INK_K, p = await getJsPage(pg), c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(box.w * k)); c.height = Math.max(1, Math.ceil(box.h * k));
  await p.render({ canvasContext: c.getContext('2d'), viewport: p.getViewport({ scale: k, rotation: effRot(pg), offsetX: -box.x * k, offsetY: -box.y * k }), background: 'rgba(0,0,0,0)' }).promise;
  return inkMeasure(c, box.x, box.y, k);
}
function inkOfText(t) {
  const k = INK_K, br = t.getBoundingRect(true, true), c = document.createElement('canvas');
  const pad = 4; c.width = Math.ceil((br.width + pad * 2) * k); c.height = Math.ceil((br.height + pad * 2) * k);
  const x = c.getContext('2d'); x.setTransform(k, 0, 0, k, (pad - br.left) * k, (pad - br.top) * k);
  const m = t.calcTransformMatrix(); x.transform(...m);
  const ed = t.isEditing; t.isEditing = true; try { _textRender.call(t, x); } finally { t.isEditing = ed; }
  return inkMeasure(c, br.left - pad, br.top - pad, k);
}
function guessAlign(items, L0, centerX) {
  // gom mảnh chữ thành các đoạn dòng liền nhau
  const runs = [];
  const sorted = items.filter(a => a.it.str.trim()).sort((a, b) => a.yb - b.yb || a.x - b.x);
  for (const a of sorted) {
    const r = runs.find(r => Math.abs(r.yb - a.yb) < a.fh * 0.25 && a.x - r.x1 < a.fh * 0.8 && a.x >= r.x0 - 1);
    if (r) { r.x1 = Math.max(r.x1, a.x + a.w); } else runs.push({ x0: a.x, x1: a.x + a.w, yb: a.yb, fh: a.fh });
  }
  const tol = Math.max(1.5, L0.fh * 0.15), mid = (L0.x0 + L0.x1) / 2;
  const near = runs.filter(r => Math.abs(r.yb - L0.yb) > L0.fh * 0.5 && Math.abs(r.yb - L0.yb) < L0.fh * 4 && Math.abs(r.fh - L0.fh) < L0.fh * 0.35 && r.x1 > L0.x0 - L0.fh * 3 && r.x0 < L0.x1 + L0.fh * 3);
  let l = 0, c = 0, rr = 0;
  for (const r of near) { if (Math.abs(r.x0 - L0.x0) < tol) l++; if (Math.abs(r.x1 - L0.x1) < tol) rr++; if (Math.abs((r.x0 + r.x1) / 2 - mid) < tol) c++; }
  if (c > l && c > rr) return 'center';
  if (rr > l) return 'right';
  if (l) return 'left';
  // số kích thước đứng riêng (bản vẽ kỹ thuật) thường canh giữa trên đường kích thước
  if (!near.length && L0.str && /^[\s\dØR±xX×.,°/()+-]{1,12}$/.test(L0.str)) return 'center';
  if (centerX != null && Math.abs(mid - centerX) < Math.max(3, L0.fh * 0.3)) return 'center';
  return 'left';
}
async function refreshPdfLayer(v) {
  const pg = v.page; if (!pg.src) return;
  await paintPdf(v);
  if (v.fc) v.fc.requestRenderAll();
  renderTextLayer(v);
  const t = S.thumbs.get(pg.id); if (t) { t.base = null; t.busy = false; renderThumb(pg.id); }
}
async function insertImage(url, kind = 'image') {
  const v = curView(); if (!v) return toast('Hãy mở PDF trước');
  await ready(v);
  const img = await new Promise(ok => fabric.Image.fromURL(url, ok));
  const [W, H] = dispSize(v.page);
  const s = Math.min(kind === 'sign' ? W * 0.28 / img.width : W * 0.6 / img.width, H * 0.5 / img.height, kind === 'sign' ? 1 : 0.75);
  const viewer = $('#viewer'), visTop = Math.max(0, (viewer.scrollTop - v.el.offsetTop) / S.zoom);
  const top = Math.min(H - img.height * s, visTop + Math.min(H, viewer.clientHeight / S.zoom) / 2 - img.height * s / 2);
  img.set({ left: (W - img.width * s) / 2, top: Math.max(0, top), scaleX: s, scaleY: s, kind, originX: 'left', originY: 'top' });
  setTool('select');
  v.loading = true; v.fc.add(img); v.loading = false;
  v.fc.setActiveObject(img); v.fc.requestRenderAll(); syncView(v);
}

/* ---------------- đối tượng đang chọn ---------------- */
function activeObjs() { const v = S.activeView; return v && v.fc ? v.fc.getActiveObjects() : []; }
function deleteSelected() {
  const v = S.activeView; if (!v) return;
  const a = v.fc.getActiveObject(); if (!a || a.isEditing) return;
  const objs = v.fc.getActiveObjects(); v.fc.discardActiveObject();
  v.loading = true; objs.forEach(o => v.fc.remove(o)); v.loading = false;
  v.fc.requestRenderAll(); syncView(v);
}
/* ---------------- clipboard nội bộ (copy được giữa các tab tài liệu) ----------------
   S.clip = { kind: 'objs', objs: [JSON fabric], text, pageId, ready? }  hoặc  { kind: 'pages', pages: [...], text } */
function setClip(c) { S.clip = c; updateUI(); }
function copySelected() {
  const v = S.activeView; if (!v) return null;
  const a = v.fc.getActiveObject(); if (!a || a.isEditing) return null;
  const act = v.fc.getActiveObjects();
  const objs = v.fc.toObject(PROPS).objects.filter((o, i) => act.includes(v.fc.item(i)));
  const text = objs.filter(o => o.text).map(o => o.text).join('\n') || `[PDF Editor: ${objs.length} đối tượng]`;
  setClip({ kind: 'objs', objs, text, pageId: v.page.id });
  return text;
}
async function pasteObjs(clip = S.clip) {
  if (!clip || clip.kind !== 'objs') return;
  if (clip.ready) { busy(true, 'Đang chuẩn bị…'); try { await clip.ready; } finally { busy(false); } }
  if (!clip.objs || !clip.objs.length) return;
  // chuột đang trỏ trên 1 trang → dán đúng chỗ con trỏ (góc trên-trái của phần dán = vị trí chuột)
  const at = S.mouse && S.views.get(S.mouse.id) ? S.mouse : null;
  const v = at ? S.views.get(at.id) : curView(); if (!v) return; await ready(v);
  const same = clip.pageId === v.page.id, off = same && !at ? 12 : 0;
  const objs = await enliven(clip.objs);
  objs.forEach(o => o.set({ left: o.left + off, top: o.top + off }));
  if (at) {
    objs.forEach(o => o.setCoords());
    const bb = objs.map(o => o.getBoundingRect(true, true));
    const dx = at.x - Math.min(...bb.map(b => b.left)), dy = at.y - Math.min(...bb.map(b => b.top));
    objs.forEach(o => o.set({ left: o.left + dx, top: o.top + dy }));
  }
  // dán sang trang khác / tại chuột: giữ trong trang, nếu tràn ra ngoài thì dịch vào trong
  if (!same || at) {
    const [W, H] = dispSize(v.page);
    objs.forEach(o => o.setCoords());
    const bb = objs.map(o => o.getBoundingRect(true, true));
    const x0 = Math.min(...bb.map(b => b.left)), y0 = Math.min(...bb.map(b => b.top)), x1 = Math.max(...bb.map(b => b.left + b.width)), y1 = Math.max(...bb.map(b => b.top + b.height));
    const dx = x1 > W ? Math.max(-x0, W - x1) : x0 < 0 ? -x0 : 0, dy = y1 > H ? Math.max(-y0, H - y1) : y0 < 0 ? -y0 : 0;
    if (dx || dy) objs.forEach(o => o.set({ left: o.left + dx, top: o.top + dy }));
  }
  v.loading = true; objs.forEach(o => { v.fc.add(o); o.setCoords(); }); v.loading = false;
  if (same && off) clip.objs = clip.objs.map(o => ({ ...o, left: o.left + off, top: o.top + off }));
  clearSelBox();
  setTool('select');
  v.fc.discardActiveObject();
  if (objs.length === 1) v.fc.setActiveObject(objs[0]); else v.fc.setActiveObject(new fabric.ActiveSelection(objs, { canvas: v.fc }));
  v.fc.requestRenderAll(); syncView(v);
  S.activeView = v; refreshProps();
}
function copyPagesClip() {
  const list = targetPages(); if (!list.length) return null;
  const pages = JSON.parse(JSON.stringify(list));
  const text = `[PDF Editor: ${pages.length} trang từ ${S.fileName}]`;
  setClip({ kind: 'pages', pages, text });
  toast(`Đã copy ${pages.length} trang — chuyển sang tab khác rồi bấm Ctrl+V (hoặc "Dán trang")`, 3500);
  const c = S.clip; try { navigator.clipboard.writeText(text).catch(() => { c.noSync = true; }); } catch (e) { c.noSync = true; }
  return text;
}
function pastePages() {
  if (!S.clip || S.clip.kind !== 'pages') return;
  const copies = S.clip.pages.map(p => ({ ...JSON.parse(JSON.stringify(p)), id: nid('p') }));
  const at = S.pages.length ? S.cur + 1 : 0;
  S.pages.splice(at, 0, ...copies);
  if (S.pages.length === copies.length) { S.fileName = 'tai-lieu-moi.pdf'; S.zoom = fitZoom(); }
  rebuild(); commit(); scrollToPage(at);
  toast(`Đã dán ${copies.length} trang`);
}
async function pasteClip() { if (!S.clip) return; if (S.clip.kind === 'pages') pastePages(); else { if (!S.pages.length) return toast('Hãy mở file PDF đích trước'); await pasteObjs(); } }

/* chữ quét chọn trên lớp chữ -> các ô chữ giữ phông, cỡ, đậm, nghiêng, màu, vị trí */
function clipFromSelection(sel) {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0), parts = [];
  for (const v of S.views.values()) {
    if (!v.tl || !v.tlMap || !range.intersectsNode(v.tl)) continue;
    for (const { div, a } of v.tlMap) {
      if (!range.intersectsNode(div)) continue;
      const full = div.textContent; let s = 0, e = full.length;
      if (div === range.startContainer) s = range.startOffset ? full.length : 0; else if (div.contains(range.startContainer)) s = range.startOffset;
      if (div === range.endContainer) e = range.endOffset ? full.length : 0; else if (div.contains(range.endContainer)) e = range.endOffset;
      let txt = full.slice(s, e); const lead = txt.length - txt.trimStart().length; s += lead; txt = txt.trim();
      if (!txt) continue;
      parts.push({ v, a, s, e: s + txt.length, len: full.length || 1, txt });
    }
  }
  if (!parts.length) return null;
  const clip = { kind: 'objs', objs: [], pageId: parts[0].v.page.id };
  clip.ready = buildTextObjs(parts).then(objs => { clip.objs = objs; }).catch(e => { console.error(e); });
  return clip;
}
function styleFromGlyphs(glyphs, fh, fallbackName) {
  const g0 = glyphs[0];
  const pdfFont = g0 ? g0.font : fallbackName || '';
  const family = matchFamily(pdfFont) || 'Arial';
  ensureFontOption(family);
  const sizes = glyphs.map(h => h.size).sort((x, y) => x - y);
  const c = g0 ? g0.color : [0, 0, 0];
  return {
    family, bold: g0 ? g0.bold : /bold|black|heavy/i.test(pdfFont), italic: g0 ? g0.italic : /italic|oblique/i.test(pdfFont),
    fs: Math.round((sizes.length ? sizes[sizes.length >> 1] : fh) * 100) / 100,
    color: '#' + c.map(x => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join(''),
  };
}
async function buildTextObjs(parts) {
  const out = [];
  const byView = new Map(); parts.forEach(pt => { if (!byView.has(pt.v)) byView.set(pt.v, []); byView.get(pt.v).push(pt); });
  for (const [v, list] of byView) {
    const pg = v.page, p = v.tlP, vp = p.getViewport({ scale: 1, rotation: effRot(pg) });
    const regs = list.map(({ a, s, e, len }) => {
      const xs = a.w * s / len, xe = a.w * e / len;
      const cs = [[xs, -a.fh], [xe, -a.fh], [xs, a.fh * 0.35], [xe, a.fh * 0.35]].map(([lx, ly]) => vp.convertToPdfPoint(...toDisp(a, lx, ly)));
      return { x0: Math.min(...cs.map(c => c[0])) - 0.3, y0: Math.min(...cs.map(c => c[1])), x1: Math.max(...cs.map(c => c[0])) + 0.3, y1: Math.max(...cs.map(c => c[1])) };
    });
    let hits = [];
    if (pg.src) { try { const lib = await getLib(pg.src); hits = TextOps.analyze(lib, lib.getPage(pg.index), regs); } catch (e) { console.warn(e); } }
    const T = await pageTextItems(v);
    for (let i = 0; i < list.length; i++) {
      const { a, s, len, txt } = list[i];
      // cùng cách với sửa chữ / chép vùng: nhận phông (cả theo hình dạng), khớp mực chữ gốc → bản dán giống hệt bản gốc
      const gl0 = hits.filter(h => h.ri === i && !h.space);
      if (gl0.length) {
        try {
          const full = await textObjFor(v, T, a, gl0), cb = (full.__charBounds && full.__charBounds[0]) || [];
          if (s === 0 && txt === a.it.str) { out.push(full.toObject(PROPS)); continue; }
          const ci = [...a.it.str].slice(0, s).join('').length; // vị trí ký tự đầu đoạn được chọn
          const lx = (cb[ci] ? cb[ci].left : 0) * (full.scaleX || 1), rad = (full.angle || 0) * Math.PI / 180;
          const o = full.toObject(PROPS);
          Object.assign(o, { text: txt, left: full.left + lx * Math.cos(rad), top: full.top + lx * Math.sin(rad), styles: {} });
          out.push(o); continue;
        } catch (e) { console.warn('textObjFor', e); }
      }
      let fname = ''; try { const f = p.commonObjs.get(a.it.fontName); fname = (f && f.name) || ''; } catch (e) {}
      const gl = hits.filter(h => h.ri === i && !h.space), pf = (gl[0] && gl[0].font) || fname;
      if (pf && !matchFamily(pf)) await webFontFor(pf); // phông chưa có → thử tải bản miễn phí
      const st = styleFromGlyphs(gl, a.fh, fname);
      await ensureFaceLoaded(st.family);
      const [x, y] = toDisp(a, a.w * s / len, -st.fs * BASE_K);
      const t = new fabric.IText(txt, { left: x, top: y, angle: Math.round(a.ang * 180 / Math.PI * 100) / 100, originX: 'left', originY: 'top', fontFamily: st.family, fontSize: st.fs, fill: st.color,
        fontWeight: st.bold ? 'bold' : 'normal', fontStyle: st.italic ? 'italic' : 'normal', kind: 'text' });
      out.push(t.toObject(PROPS));
    }
  }
  return out;
}

/* Copy vùng: nội dung PDF trong khung (dạng vector khi xuất) + các đối tượng đã thêm nằm trong khung */
function pageB(R, x0, y0, W, H) { return { 0: [1, 0, 0, -1, x0, y0 + H], 90: [0, 1, 1, 0, x0, y0], 180: [-1, 0, 0, 1, x0 + W, y0], 270: [0, -1, -1, 0, x0 + W, y0 + H] }[R]; }
function invM(m) { const [a, b, c, d, e, f] = m, det = a * d - b * c; return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]; }
async function copyRegion(v, box, quiet, withText = true) { // quiet: chỉ trả về danh sách đối tượng (người gọi tự cất vào clipboard)
  // độ nét phần hình của vùng chép: 8 điểm ảnh / point (rõ khi phóng to tới ~800%), vùng lớn thì giảm cho ảnh ≤ ~12 triệu điểm ảnh
  const pg = v.page, sc = Math.max(2, Math.min(8, Math.sqrt(12e6 / Math.max(1, box.w * box.h))));
  const inside = new Set(v.fc.getObjects().filter(o => { const b = o.getBoundingRect(true, true); return b.left >= box.x - 1 && b.top >= box.y - 1 && b.left + b.width <= box.x + box.w + 1 && b.top + b.height <= box.y + box.h + 1; }));
  const objs = v.fc.toObject(PROPS).objects.filter((o, i) => inside.has(v.fc.item(i)));
  if (pg.src) {
    // chữ gốc nằm gọn trong vùng → chép thành ô chữ sửa được (giữ phông / cỡ / màu / vị trí); phần hình vẽ còn lại chép như cũ
    let texts = [], tdel = [];
    if (withText) { try { ({ texts, tdel } = await regionTextObjs(v, box)); } catch (e) { console.warn('regionText', e); texts = []; tdel = []; } }
    const del = (pg.del || []).concat(tdel);
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(box.w * sc)); c.height = Math.max(1, Math.ceil(box.h * sc));
    const p = tdel.length ? await strippedJsPage(pg, del) : await getJsPage(pg);
    await p.render({ canvasContext: c.getContext('2d'), viewport: p.getViewport({ scale: sc, rotation: effRot(pg), offsetX: -box.x * sc, offsetY: -box.y * sc }), background: 'rgba(0,0,0,0)' }).promise;
    if (await canvasHasInk(c)) objs.unshift({ type: 'image', version: '5.3.0', originX: 'left', originY: 'top', left: box.x, top: box.y, width: c.width, height: c.height, scaleX: 1 / sc, scaleY: 1 / sc,
      src: c.toDataURL('image/png'), kind: 'region', region: { src: pg.src, index: pg.index, del, imgEdits: pg.imgEdits || [], rm: pg.rm || null, R: effRot(pg), box, sc } });
    objs.push(...texts);
  }
  if (quiet) return objs;
  if (!objs.length) return toast('Vùng trống — không có gì để copy');
  setClip({ kind: 'objs', objs, text: '[PDF Editor: vùng đã copy]', pageId: pg.id });
  try { await navigator.clipboard.writeText(S.clip.text); } catch (e) { S.clip.noSync = true; }
  toast('Đã copy vùng — chuyển sang file/trang khác rồi bấm Ctrl+V', 3500);
}
const canvasHasInk = c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) return true; return false; };
// trang gốc đã bỏ thêm các vùng chữ (del) — để vẽ phần hình của vùng chép mà không dính chữ đã tách thành ô chữ
async function strippedJsPage(pg, del) {
  const tmp = await L.PDFDocument.create();
  const [cp] = await tmp.copyPages(await getLib(pg.src), [pg.index]); tmp.addPage(cp);
  TextOps.strip(tmp, cp, await prepRegions(tmp, del, pg.imgEdits || []), pg.rm || null);
  const doc = await pdfjsLib.getDocument({ data: await tmp.save() }).promise;
  return doc.getPage(1);
}
/* các dòng chữ gốc nằm gọn trong khung → ô chữ (dạng JSON của fabric) + vùng xoá chữ đó khỏi phần hình */
async function regionTextObjs(v, box) {
  const pg = v.page, T = await pageTextItems(v), vp = T.vp, texts = [], tdel = [];
  const inBox = ([x, y]) => x >= box.x - 1 && x <= box.x + box.w + 1 && y >= box.y - 1 && y <= box.y + box.h + 1;
  const items = T.items.filter(a => a.it.str.trim() && [[0, -a.fh], [a.w, -a.fh], [0, a.fh * 0.2], [a.w, a.fh * 0.2]].every(([lx, ly]) => inBox(toDisp(a, lx, ly))));
  if (!items.length) return { texts, tdel };
  const lib = await getLib(pg.src);
  for (const a of items) {
    const corners = [[-0.5, -a.fh], [a.w + 0.5, -a.fh], [-0.5, a.fh * 0.35], [a.w + 0.5, a.fh * 0.35]].map(([lx, ly]) => vp.convertToPdfPoint(...toDisp(a, lx, ly)));
    const region = { x0: Math.min(...corners.map(c => c[0])), y0: Math.min(...corners.map(c => c[1])), x1: Math.max(...corners.map(c => c[0])), y1: Math.max(...corners.map(c => c[1])) };
    let hits = []; try { hits = TextOps.analyze(lib, lib.getPage(pg.index), [region]); } catch (e) {}
    const gl = hits.filter(h => !h.space); if (!gl.length) continue; // chữ trong XObject lồng → để nguyên trong phần hình
    const t = await textObjFor(v, T, a, gl);
    texts.push(t.toObject(PROPS)); tdel.push(region);
  }
  return { texts, tdel };
}
/* 1 mảnh chữ gốc → ô chữ cùng phông / cỡ / màu, mực trùng khít chữ gốc (như khi sửa chữ) */
async function textObjFor(v, T, a, glyphs) {
  const g0 = glyphs[0];
  let pdfFont = g0.font || ''; if (!pdfFont) { try { const f = T.p.commonObjs.get(a.it.fontName); pdfFont = (f && f.name) || ''; } catch (e) {} }
  const generic = !pdfFont || isGenericFontName(pdfFont);
  let family = generic ? null : matchFamily(pdfFont), bold = g0.bold, italic = g0.italic;
  if (generic) { const sf = await fontByShape(v, T, a.it.fontName).catch(() => null); if (sf) ({ family, bold, italic } = sf); }
  else if (!family) family = await webFontFor(pdfFont);
  if (!family) { const fam = (v.tc && v.tc.styles[a.it.fontName] || {}).fontFamily || ''; family = fam === 'monospace' ? 'Courier New' : fam === 'serif' ? 'Times New Roman' : 'Arial'; }
  await ensureFaceLoaded(family); ensureFontOption(family);
  const sizes = glyphs.map(h => h.size).sort((x, y) => x - y), fs = Math.round(sizes[sizes.length >> 1] * 100) / 100;
  const hexC = c => '#' + c.map(x => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
  const str = a.it.str, [x, y] = toDisp(a, 0, -fs * BASE_K);
  const t = new fabric.IText(str, { left: x, top: y, angle: Math.round(a.ang * 180 / Math.PI * 100) / 100, originX: 'left', originY: 'top', fontFamily: family, fontSize: fs, fill: hexC(g0.color),
    fontWeight: bold ? 'bold' : 'normal', fontStyle: italic ? 'italic' : 'normal', kind: 'text' });
  const sx = a.sx && Math.abs(a.sx - 1) > 0.01 && a.sx > 0.3 && a.sx < 3 ? Math.round(a.sx * 10000) / 10000 : 1;
  if (sx !== 1) t.set({ scaleX: sx });
  const nch = [...str].length;
  if (nch > 2 && t.width > 0) { const gap = a.w - t.width * sx; if (Math.abs(gap) > a.w * 0.01) { const csv = Math.round(gap / (nch - 1) / (fs * sx) * 1000); if (Math.abs(csv) <= 250) t.set({ charSpacing: csv }); } }
  t.initDimensions && t.initDimensions();
  if (Math.abs(a.ang) < 0.002) { // đặt khít theo mực chữ gốc
    try {
      const io = await inkOfPage(v.page, { x: a.ox - 1, y: a.oy - a.fh * 1.15, w: a.w + 2, h: a.fh * 1.6 });
      let inN = io && inkOfText(t);
      if (inN) { const f = (io.right - io.left) / Math.max(0.1, inN.right - inN.left); if (Math.abs(f - 1) > 0.0005 && Math.abs(f - 1) < 0.03) { t.set({ scaleX: (t.scaleX || 1) * f }); t.setCoords(); inN = inkOfText(t); } }
      if (inN) { const dx = io.left - inN.left, dy = io.base - inN.base; if (Math.abs(dx) < fs * 0.6) t.set({ left: t.left + dx }); if (Math.abs(dy) < fs * 0.4) t.set({ top: t.top + dy }); }
    } catch (e) { console.warn('ink', e); }
  }
  const g2 = glyphs.find(h => h.mode === 2 && h.lw > 0);
  if (g2) t.set({ stroke: hexC(g2.strokeColor || g2.color), strokeWidth: Math.round(g2.lw * 1000) / 1000, paintFirst: 'fill', strokeLineJoin: 'round' });
  return t;
}
async function drawRegion(out, page, o, ctx) {
  const r = o.region, key = r.src + '|' + r.index + '|' + JSON.stringify(r.del || []) + '|' + JSON.stringify(r.rm || {}) + '|' + JSON.stringify(r.imgEdits || []);
  if (!ctx.regionPages[key]) {
    const tmp = await L.PDFDocument.create();
    const [cp] = await tmp.copyPages(await getLib(r.src), [r.index]); tmp.addPage(cp);
    TextOps.strip(tmp, cp, await prepRegions(tmp, r.del, r.imgEdits), r.rm);
    ctx.regionPages[key] = cp;
  }
  const sp = ctx.regionPages[key];
  const { x: x0, y: y0, width: W, height: H } = sp.getCropBox();
  const B = pageB(r.R, x0, y0, W, H), b = r.box;
  const cs = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => TextOps.apply(B, x, y));
  const bbox = { left: Math.min(...cs.map(c => c[0])), bottom: Math.min(...cs.map(c => c[1])), right: Math.max(...cs.map(c => c[0])), top: Math.max(...cs.map(c => c[1])) };
  const emb = await out.embedPage(sp, bbox, [1, 0, 0, 1, 0, 0]);
  const T = [1 / r.sc, 0, 0, 1 / r.sc, b.x + o.width / (2 * r.sc), b.y + o.height / (2 * r.sc)];
  page.pushOperators(L.concatTransformationMatrix(...invM(TextOps.mul(T, B))));
  page.drawPage(emb, { x: 0, y: 0, xScale: 1, yScale: 1, opacity: o.opacity ?? 1 });
}
/* Thứ tự lớp: đối tượng có under=true nằm DƯỚI nội dung gốc của PDF (chữ, bảng, ảnh nền…), vẽ trên canvas v.uc phía dưới;
   còn lại nằm TRÊN nội dung PDF. Trong mỗi nhóm theo thứ tự trong danh sách của fabric. */
const _render = fabric.Object.prototype.render;
fabric.Object.prototype.render = function (ctx) {
  if (this.under && this.canvas && this.canvas._mainView && ctx === this.canvas.contextContainer) return; // vẽ ở lớp dưới
  return _render.call(this, ctx);
};
/* Chữ sửa trên bản scan (ocrBlur = độ nhoè, point): vẽ nhoè đúng như chữ trong ảnh scan cho khỏi "sắc" khác hẳn chữ xung quanh.
   Đang gõ thì vẽ nét rõ để dễ sửa. */
const _textRender = fabric.IText.prototype._render;
fabric.IText.prototype._render = function (ctx) {
  if (!this.ocrBlur || this.isEditing || !('filter' in ctx)) return _textRender.call(this, ctx);
  const m = ctx.getTransform(), px = this.ocrBlur * Math.hypot(m.a, m.b);
  if (px < 0.15) return _textRender.call(this, ctx);
  const f = ctx.filter; ctx.filter = `blur(${px.toFixed(2)}px)`;
  try { _textRender.call(this, ctx); } finally { ctx.filter = f; }
};
function drawUnder(v) {
  if (!v.uc || !v.fc) return;
  const ctx = v.uc.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, v.uc.width, v.uc.height);
  const objs = v.fc.getObjects().filter(o => o.under && o.visible !== false);
  if (!objs.length) return;
  const k = v.uc.width / (v.fc.getWidth() || 1) * S.zoom; ctx.setTransform(k, 0, 0, k, 0, 0);
  for (const o of objs) _render.call(o, ctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
function arrange(mode) {
  const v = S.activeView; if (!v) return;
  const fc = v.fc, sel = fc.getActiveObjects(); if (!sel.length) return;
  const all = () => fc.getObjects();
  const top = sel.slice().sort((a, b) => all().indexOf(a) - all().indexOf(b));
  if (mode === 'top') top.forEach(o => { o.under = false; fc.bringToFront(o); });
  else if (mode === 'bottom') top.slice().reverse().forEach(o => { o.under = true; fc.sendToBack(o); });
  else if (mode === 'up') {
    for (const o of top.slice().reverse()) {
      if (o.under) { // lên khỏi lớp dưới nếu đã ở trên cùng của nhóm dưới
        const higher = all().slice(all().indexOf(o) + 1).filter(x => x.under && !sel.includes(x));
        if (higher.length) fc.moveTo(o, all().indexOf(higher[0])); else o.under = false;
      } else {
        const higher = all().slice(all().indexOf(o) + 1).find(x => !x.under && !sel.includes(x) && x.intersectsWithObject(o));
        if (higher) fc.moveTo(o, all().indexOf(higher)); else fc.bringForward(o);
      }
    }
  } else if (mode === 'down') {
    for (const o of top) {
      if (!o.under) {
        const lower = all().slice(0, all().indexOf(o)).reverse().find(x => !x.under && !sel.includes(x) && x.intersectsWithObject(o));
        if (lower) fc.moveTo(o, all().indexOf(lower)); else o.under = true; // không còn gì bên dưới -> xuống dưới nội dung PDF
      } else {
        const lower = all().slice(0, all().indexOf(o)).reverse().find(x => x.under && !sel.includes(x));
        if (lower) fc.moveTo(o, all().indexOf(lower));
      }
    }
  }
  fc.requestRenderAll(); syncView(v); refreshProps();
  const u = sel.every(o => o.under);
  toast(u ? 'Đang nằm DƯỚI nội dung PDF (chữ, bảng đè lên trên)' : 'Đang nằm TRÊN nội dung PDF', 2200);
}

/* ---------------- bảng thuộc tính ---------------- */
const SWATCHES = ['#000000', '#d32f2f', '#1a73e8', '#188038', '#f9ab00', '#ffeb3b', '#8e24aa', '#ffffff'];
function refreshProps() {
  const objs = activeObjs(), o = objs[0], st = S.style, t = S.tool;
  const hlMode = (o && objs.every(x => x.kind === 'highlight')) || (!o && t === 'highlight');
  let color = hlMode ? st.hl : st.color, fill = st.fill, stroke = st.stroke, op = st.opacity;
  if (o) {
    color = isText(o) || o.kind === 'highlight' ? o.fill : (o.stroke || st.color);
    fill = (o.type === 'rect' || o.type === 'ellipse' || o.kind === 'vector') && o.fill && o.fill !== 'transparent' ? o.fill : '';
    stroke = o.strokeWidth || st.stroke; op = o.opacity ?? 1;
  }
  const toHex = c => { try { return '#' + new fabric.Color(c || '#000').toHex(); } catch (e) { return '#000000'; } };
  $('#pColor').value = toHex(color);
  $('#pNoFill').checked = !fill; if (fill) $('#pFill').value = toHex(fill);
  $('#pStroke').value = stroke; $('#pStrokeV').textContent = stroke;
  $('#pOpacity').value = op; $('#pOpacityV').textContent = Math.round(op * 100) + '%';
  const tx = o ? objs.find(isText) : null;
  const showText = !!tx || (!o && (t === 'text' || t === 'edittext'));
  $('#grpText').classList.toggle('hidden', !showText);
  const src = tx || { fontFamily: st.font, fontSize: st.size, fontWeight: st.bold ? 'bold' : 'normal', fontStyle: st.italic ? 'italic' : 'normal', textAlign: st.align };
  $('#pFont').value = src.fontFamily; $('#pSize').value = Math.round(src.fontSize * (tx ? (tx.scaleY || 1) : 1) * 10) / 10;
  $('#pBold').classList.toggle('on', src.fontWeight === 'bold' || +src.fontWeight >= 600);
  $('#pItalic').classList.toggle('on', src.fontStyle === 'italic');
  $$('.al').forEach(b => b.classList.toggle('on', b.dataset.align === src.textAlign));
  const shapeLike = o ? objs.some(x => !isText(x) && x.type !== 'image' && x.kind !== 'highlight' && x.kind !== 'whiteout') : ['draw', 'rect', 'ellipse', 'line', 'arrow'].includes(t);
  $('#rowStroke').classList.toggle('hidden', !shapeLike);
  const fillable = o ? objs.some(x => ['rect', 'ellipse', 'whiteout', 'vector'].includes(x.kind)) : ['rect', 'ellipse', 'whiteout'].includes(t);
  $('#rowFill').classList.toggle('hidden', !fillable);
  $('#objBtns').classList.toggle('hidden', !o);
  if (o) $('#oLayerInfo').textContent = objs.every(x => x.under) ? 'Lớp: DƯỚI nội dung PDF (chữ, bảng đè lên)' : objs.some(x => x.under) ? 'Lớp: lẫn lộn trên / dưới' : 'Lớp: TRÊN nội dung PDF';
  $('#imgBtns').classList.toggle('hidden', !(o && objs.length === 1 && o.type === 'image' && o.kind !== 'region'));
  $('#hint').textContent = o ? (o.type === 'image' && objs.length === 1 && o.kind !== 'region' ? 'Ảnh: kéo để di chuyển, kéo góc để đổi cỡ (giữ Shift để co giãn tự do), Delete để xoá, Ctrl+C rồi Ctrl+V để copy sang trang / file khác.' : isText(o) ?'Bấm đúp vào chữ để sửa nội dung. Kéo góc để phóng to/thu nhỏ.' : 'Kéo để di chuyển, kéo góc để đổi kích thước, núm tròn phía trên để xoay.') : (HINTS[t] || '');
}
function applyProp(k, val, final = true) {
  const st = S.style, objs = activeObjs();
  const hlMode = (objs.length && objs.every(x => x.kind === 'highlight')) || (!objs.length && S.tool === 'highlight');
  if (k === 'color') { if (hlMode) st.hl = val; else st.color = val; } else st[k] = val;
  for (const o of objs) {
    const txt = isText(o);
    if (k === 'color') {
      if (txt || o.kind === 'highlight') o.set('fill', val);
      else if (o.type !== 'image' && o.kind !== 'whiteout') o.set('stroke', val);
    } else if (k === 'fill') { if (o.kind === 'vector') o.set('fill', val || ''); else if (['rect', 'ellipse'].includes(o.kind)) o.set('fill', val || 'transparent'); else if (o.kind === 'whiteout') o.set('fill', val || '#ffffff'); }
    else if (k === 'stroke') { if (!txt && o.type !== 'image' && o.strokeWidth > 0) o.set('strokeWidth', +val); }
    else if (k === 'opacity') o.set('opacity', +val);
    else if (txt) {
      if (k === 'font') {
        o.set('fontFamily', val);
        // phông tải từ Google Fonts: chờ nạp xong rồi đo / vẽ lại chữ
        ensureFaceLoaded(val).then(() => { o.initDimensions && o.initDimensions(); o.setCoords(); o.dirty = true; o.canvas && o.canvas.requestRenderAll(); });
      }
      if (k === 'size') { o.set({ fontSize: +val / (o.scaleY || 1) }); }
      if (k === 'bold') o.set('fontWeight', val ? 'bold' : 'normal');
      if (k === 'italic') o.set('fontStyle', val ? 'italic' : 'normal');
      if (k === 'align') o.set('textAlign', val);
      o.initDimensions && o.initDimensions();
    }
    o.setCoords();
  }
  const v = S.activeView;
  if (v && objs.length) { v.fc.requestRenderAll(); if (final) syncView(v); }
  if (S.tool === 'draw') for (const x of S.views.values()) applyToolTo(x);
}

/* ---------------- xuất PDF ---------------- */
/* Phông: danh sách phông Windows từ server (/fonts/list) */
const FONTS = { list: [], fams: [], byNorm: new Map() };
const ALIASES = { helvetica: 'Arial', arialmt: 'Arial', helveticaneue: 'Arial', times: 'Times New Roman', timesroman: 'Times New Roman', timesnewroman: 'Times New Roman', courier: 'Courier New', couriernew: 'Courier New', symbol: 'Symbol', zapfdingbats: 'Wingdings' };
const normFam = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/* Phông miễn phí tải từ Google Fonts (máy chủ lưu ở fonts-extra, đánh dấu web:true) — không cài vào Windows
   nên trình duyệt phải nạp qua FontFace mới vẽ được */
const webFaces = new Map();
function registerWebFaces() {
  for (const f of FONTS.list) if (f.web && !webFaces.has(f.file)) {
    try { const ff = new FontFace(f.family, `url(fonts/f/${encodeURIComponent(f.file)})`, { weight: f.bold ? '700' : '400', style: f.italic ? 'italic' : 'normal' }); document.fonts.add(ff); webFaces.set(f.file, ff); } catch (e) {}
  }
}
async function ensureFaceLoaded(fam) { // chờ phông tải xong trước khi đo / vẽ chữ
  const fs2 = FONTS.list.filter(f => f.web && f.family === fam).map(f => webFaces.get(f.file)).filter(Boolean);
  if (fs2.length) await Promise.all(fs2.map(ff => ff.load().catch(() => null)));
}
/* phông trong PDF chưa có trên máy → hỏi máy chủ tải từ Google Fonts (nếu là phông miễn phí có ở đó) */
const webTried = new Map();
async function webFontFor(pdfName) {
  const raw = (pdfName || '').replace(/^[A-Z]{6}\+/, ''), base = raw.split(/[-,]/)[0].replace(/(PSMT|PS|MT)$/, '').replace(/(Bold|Italic|Oblique|Regular|SemiBold|Semibold|Light|Medium|Black|Condensed|Thin|ExtraBold)+$/, '');
  if (!base || base.length < 3) return null;
  const spaced = base.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ').trim();
  for (const name of [...new Set([spaced, base])]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9 ]{1,48}$/.test(name)) continue;
    if (!webTried.has(name)) webTried.set(name, fetch('fonts/fetch?family=' + encodeURIComponent(name)).then(r => r.json()).catch(() => ({ ok: false })));
    const r = await webTried.get(name);
    if (r && r.ok) { await loadFontList(); const fam = matchFamily(r.family) || r.family; await ensureFaceLoaded(fam); return fam; }
  }
  return null;
}
async function loadFontList() {
  try { FONTS.list = await (await fetch('fonts/list')).json(); } catch (e) { FONTS.list = []; }
  FONTS.loadedAt = Date.now();
  registerWebFaces();
  FONTS.fams = [...new Set(FONTS.list.map(f => f.family))].sort((a, b) => a.localeCompare(b));
  for (const f of FONTS.fams) FONTS.byNorm.set(normFam(f), f);
  const sel = $('#pFont'); const keep = sel.value || 'Arial';
  if (FONTS.fams.length) { sel.innerHTML = ''; for (const f of FONTS.fams) { const o = document.createElement('option'); o.value = o.textContent = f; o.style.fontFamily = `"${f}"`; sel.appendChild(o); } }
  sel.value = keep;
}
function ensureFontOption(fam) {
  const sel = $('#pFont'); if ([...sel.options].some(o => o.value === fam)) return;
  const o = document.createElement('option'); o.value = o.textContent = fam; sel.appendChild(o);
}
/* Tên phông trong PDF (vd "ABCDEF+TimesNewRomanPS-BoldItalicMT") -> họ phông đã cài (vd "Times New Roman") */
function matchFamily(pdfName) {
  const raw = (pdfName || '').replace(/^[A-Z]{6}\+/, '');
  const base = raw.split(/[-,]/)[0];
  const cands = [normFam(base), normFam(base).replace(/(psmt|ps|mt)$/, ''), normFam(base).replace(/(psmt|ps|mt)$/, '').replace(/(bold|italic|oblique|regular|semibold|light|medium|black|condensed)+$/, ''), normFam(raw)];
  for (const c of cands) {
    if (FONTS.byNorm.has(c)) return FONTS.byNorm.get(c);
    if (ALIASES[c] && (FONTS.byNorm.has(normFam(ALIASES[c])) || !FONTS.fams.length)) return ALIASES[c];
  }
  // tên có khoảng trắng/gạch dưới dạng khác: thử khớp tiền tố dài nhất
  let best = null;
  for (const [k, f] of FONTS.byNorm) if (cands[1].startsWith(k) && k.length >= 4 && (!best || k.length > normFam(best).length)) best = f;
  return best;
}
/* Tên phông nhúng không mang tên phông thật (vd "CIDFont+F1", "ABCDEF+F2", "T1_0", "TT3") — phần mềm xuất PDF đặt tên tạm */
function isGenericFontName(pdfName) {
  const raw = (pdfName || '').replace(/^[A-Z]{6}\+/, '').replace(/^CIDFont\+/i, '').trim();
  if (!raw || raw.length < 3) return true;
  if (/^(cidfont|font|f|t|tt|c|r|ft|fnt)[_+-]?\d+([_+-]\d+)*$/i.test(raw)) return true;
  if (/^[A-Z]{1,3}\d+(_\d+)?$/.test(raw)) return true;
  return false;
}
/* Nhận phông theo hình dạng chữ: lấy vài dòng chữ cùng phông nhúng trên trang (bản vẽ rõ nét từ PDF),
   vẽ thử bằng các phông có trên máy rồi so hình (giống cách nhận phông trang scan) — bỏ phiếu theo từng dòng */
const shapeFontCache = new Map();
async function fontByShape(v, T, fontName) {
  const pg = v.page, key = pg.id + '|' + fontName;
  if (shapeFontCache.has(key)) return shapeFontCache.get(key);
  const samples = T.items.filter(a => a.it.fontName === fontName && Math.abs(a.ang) < 0.002 && [...a.it.str.replace(/\s/g, '')].length >= 2 && a.w > 2)
    .sort((a, b) => b.it.str.replace(/\s/g, '').length - a.it.str.replace(/\s/g, '').length).slice(0, 5);
  if (!samples.length) return null;
  const p = await getJsPage(pg), k = 6, votes = {}, bolds = [], itals = [];
  for (const a of samples) {
    const box = { x: a.ox - 1, y: a.oy - a.fh * 1.15, w: a.w + 2, h: a.fh * 1.6 };
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(box.w * k)); c.height = Math.max(1, Math.ceil(box.h * k));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await p.render({ canvasContext: ctx, viewport: p.getViewport({ scale: k, rotation: effRot(pg), offsetX: -box.x * k, offsetY: -box.y * k }), background: 'white' }).promise;
    // khung sát mực của dòng chữ
    const W = c.width, H = c.height, d = ctx.getImageData(0, 0, W, H).data, thr = 384;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (d[i] + d[i + 1] + d[i + 2] < thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, crop = ctx.getImageData(x0, y0, cw, ch).data;
    const st = ocrStyle(a.it.str.trim(), crop, cw, ch, thr, null);
    if (!st || !st.family) continue;
    const wgt = [...a.it.str.replace(/\s/g, '')].length; // dòng dài đáng tin hơn
    votes[st.family] = (votes[st.family] || 0) + wgt; bolds.push([st.bold, wgt]); itals.push([st.italic, wgt]);
  }
  const fam = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
  const maj = arr => { let y = 0, n = 0; for (const [b, w] of arr) { n += w; if (b) y += w; } return y > n / 2; };
  const res = fam ? { family: fam, bold: maj(bolds), italic: maj(itals) } : null;
  shapeFontCache.set(key, res);
  return res;
}
const fontBytes = {};
function pickFontFile(fam, bold, italic) {
  const all = FONTS.list.filter(f => f.family === fam);
  const f = all.find(x => x.bold === bold && x.italic === italic) || all.find(x => x.bold === bold) || all.find(x => !x.bold && !x.italic) || all[0];
  if (f) return f.file;
  return ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'][(bold ? 1 : 0) + (italic ? 2 : 0)];
}
async function getFont(out, cache, fam, bold, italic) {
  const file = pickFontFile(fam, bold, italic);
  if (cache[file]) return cache[file];
  try {
    if (!fontBytes[file]) { const r = await fetch(`fonts/f/${encodeURIComponent(file)}`); if (!r.ok) throw new Error('font ' + r.status); fontBytes[file] = await r.arrayBuffer(); }
    try { cache[file] = await out.embedFont(fontBytes[file], { subset: true }); }
    catch (e) { cache[file] = await out.embedFont(fontBytes[file]); }
  } catch (e) {
    console.warn('Không tải được phông, dùng Helvetica (không dấu):', e);
    cache[file] = await out.embedFont(L.StandardFonts[['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'][(bold ? 1 : 0) + (italic ? 2 : 0)]]);
  }
  return cache[file];
}
function col(c) {
  if (!c || c === 'transparent' || typeof c !== 'string') return null;
  const [r, g, b, a] = new fabric.Color(c).getSource();
  if (a === 0) return null;
  return { rgb: L.rgb(r / 255, g / 255, b / 255), a: a ?? 1 };
}
async function imageBytes(o) {
  let src = o.getSrc ? o.getSrc() : o.src;
  if (!/^data:image\/(png|jpe?g)/i.test(src || '')) {
    const el = o.getElement(); const c = document.createElement('canvas');
    c.width = el.naturalWidth || el.width; c.height = el.naturalHeight || el.height; c.getContext('2d').drawImage(el, 0, 0); src = c.toDataURL('image/png');
  }
  return src;
}
async function drawObj(out, page, o, ctx) {
  const op = Math.max(0, Math.min(1, o.opacity ?? 1));
  const fill = col(o.fill), stroke = o.strokeWidth > 0 ? col(o.stroke) : null;
  const blend = o.globalCompositeOperation === 'multiply' ? L.BlendMode.Multiply : undefined;
  const flip = () => page.pushOperators(L.concatTransformationMatrix(1, 0, 0, -1, 0, 0));
  if (o.kind === 'region' && o.region && S.sources[o.region.src]) { try { await drawRegion(out, page, o, ctx); return; } catch (e) { console.warn('region -> ảnh', e); } }
  switch (o.type) {
    case 'rect':
      if (!fill && !stroke) return;
      page.drawRectangle({ x: -o.width / 2, y: -o.height / 2, width: o.width, height: o.height,
        color: fill ? fill.rgb : undefined, opacity: fill ? fill.a * op : undefined,
        borderColor: stroke ? stroke.rgb : undefined, borderWidth: stroke ? o.strokeWidth : 0, borderOpacity: stroke ? stroke.a * op : undefined, blendMode: blend });
      return;
    case 'ellipse':
      if (!fill && !stroke) return;
      page.drawEllipse({ x: 0, y: 0, xScale: o.rx, yScale: o.ry, color: fill ? fill.rgb : undefined, opacity: fill ? fill.a * op : undefined,
        borderColor: stroke ? stroke.rgb : undefined, borderWidth: stroke ? o.strokeWidth : 0, borderOpacity: stroke ? stroke.a * op : undefined, blendMode: blend });
      return;
    case 'line': {
      if (!stroke) return; const p = o.calcLinePoints();
      page.drawLine({ start: { x: p.x1, y: p.y1 }, end: { x: p.x2, y: p.y2 }, thickness: o.strokeWidth, color: stroke.rgb, opacity: stroke.a * op, lineCap: L.LineCapStyle.Round });
      return;
    }
    case 'path': {
      const d = o.path.map(c => c.join(' ')).join(' ');
      flip();
      page.drawSvgPath(d, { x: -o.pathOffset.x, y: o.pathOffset.y, borderColor: stroke ? stroke.rgb : undefined, borderWidth: stroke ? o.strokeWidth : 0, borderOpacity: stroke ? stroke.a * op : undefined,
        color: fill ? fill.rgb : undefined, opacity: fill ? fill.a * op : undefined, borderLineCap: o.strokeLineCap === 'butt' ? L.LineCapStyle.Butt : o.strokeLineCap === 'square' ? L.LineCapStyle.Projecting : L.LineCapStyle.Round,
        borderDashArray: o.strokeDashArray && o.strokeDashArray.length ? o.strokeDashArray : undefined });
      return;
    }
    case 'image': {
      const src = await imageBytes(o);
      if (!ctx.img[src]) ctx.img[src] = /^data:image\/jpe?g/i.test(src) ? await out.embedJpg(src) : await out.embedPng(src);
      flip();
      page.drawImage(ctx.img[src], { x: -o.width / 2, y: -o.height / 2, width: o.width, height: o.height, opacity: op });
      return;
    }
    case 'i-text': case 'textbox': case 'text': {
      if (!fill) return;
      // chữ ẩn (Tr 3): lớp chữ OCR để tìm / copy được, và lớp chữ đi kèm ảnh chữ nhoè bên dưới
      let invisible = !!o.ocrInvisible;
      if (o.ocrBlur > 0.04 && typeof o._render === 'function') { // chữ sửa trên bản scan: lưu thành ảnh nhoè như bản scan
        const s = 4.17, m = o.ocrBlur * 3 + 1, cw = Math.ceil((o.width + 2 * m) * s), chh = Math.ceil((o.height + 2 * m) * s);
        const c = document.createElement('canvas'); c.width = cw; c.height = chh; const x = c.getContext('2d');
        x.setTransform(s, 0, 0, s, (o.width / 2 + m) * s, (o.height / 2 + m) * s);
        x.filter = `blur(${(o.ocrBlur * s).toFixed(2)}px)`;
        const ed = o.isEditing; o.isEditing = true; try { _textRender.call(o, x); } finally { o.isEditing = ed; } // isEditing: bỏ qua nhoè lồng trong _render
        const png = await out.embedPng(c.toDataURL('image/png'));
        flip();
        page.drawImage(png, { x: -o.width / 2 - m, y: -o.height / 2 - m, width: o.width + 2 * m, height: o.height + 2 * m, opacity: op });
        return; // (không thêm lớp chữ ẩn — theo yêu cầu)
      }
      const font = await getFont(out, ctx.fonts, o.fontFamily, o.fontWeight === 'bold' || +o.fontWeight >= 600, o.fontStyle === 'italic');
      const chars = font.getCharacterSet ? new Set(font.getCharacterSet()) : null;
      const clean = s => [...s.replace(/\t/g, '    ')].map(ch => (!chars || chars.has(ch.codePointAt(0)) ? ch : '?')).join('');
      flip();
      const fs = o.fontSize; let acc = 0;
      const tc = (o.charSpacing || 0) / 1000 * fs; // khoảng cách chữ (vd chữ OCR khớp độ dài bản scan)
      if (tc) page.pushOperators(L.setCharacterSpacing(tc));
      // chữ có viền (đậm giả, Tr 2): đặt chế độ tô + viền và độ dày nét cho các lệnh vẽ chữ bên dưới
      const outline = !invisible && o.stroke && o.strokeWidth > 0 && col(o.stroke);
      if (invisible) page.pushOperators(L.setTextRenderingMode(L.TextRenderingMode.Invisible));
      if (outline) page.pushOperators(L.setTextRenderingMode(L.TextRenderingMode.FillAndOutline), L.setLineWidth(o.strokeWidth), L.setStrokingColor(outline.rgb));
      const has = ch => !chars || chars.has(ch.codePointAt(0));
      const isB = o.fontWeight === 'bold' || +o.fontWeight >= 600, isI = o.fontStyle === 'italic';
      let fb = null; // phông dự phòng cho ký tự phông chính không có (vd SimSun thiếu chữ Việt có dấu)
      const lines = o._textLines || o.textLines.map(l => [...l]);
      for (let i = 0; i < lines.length; i++) {
        const lh = o.getHeightOfLine(i);
        const yDown = -o.height / 2 + acc + lh / o.lineHeight * (1 - o._fontSizeFraction); // đúng như fabric vẽ (_renderChars)
        acc += lh;
        const gs = lines[i].map(ch => (ch === '\t' ? ' ' : ch)); if (!gs.join('').trim()) continue;
        if (o.underline && !invisible) { // gạch chân như fabric vẽ: dưới chân chữ 0,1 cỡ chữ, dày cỡ chữ / 15
          const lw2 = o.getLineWidth ? o.getLineWidth(i) : 0, lx = -o.width / 2 + (o._getLineLeftOffset ? o._getLineLeftOffset(i) : 0), th = fs / 15;
          page.drawRectangle({ x: lx, y: -yDown - fs * 0.1 - th / 2, width: lw2, height: th, color: fill.rgb, opacity: fill.a * op, borderWidth: 0 });
        }
        const st = (o.styles && o.styles[i]) || {};
        // vẽ từng từ đúng vị trí ký tự như trên màn hình (căn đều 2 bên, kerning của phông…) → file lưu ra trùng khít màn hình
        const just = o.__charBounds && o.__charBounds[i] && !Object.keys(st).length && gs.every(has);
        if (just) {
          const cb = o.__charBounds[i], left = -o.width / 2 + (o._getLineLeftOffset ? o._getLineLeftOffset(i) : 0);
          let j = 0;
          while (j < gs.length) {
            if (/\s/.test(gs[j])) { j++; continue; }
            let k = j; while (k < gs.length && !/\s/.test(gs[k])) k++;
            const w = gs.slice(j, k).join('');
            // khoảng cách chữ riêng cho từ này để bề ngang từ trùng đúng màn hình (kerning / làm tròn của trình duyệt)
            if (k - j > 1 && cb[j] && cb[k - 1]) {
              const want = cb[k - 1].left + cb[k - 1].kernedWidth - cb[j].left, got = font.widthOfTextAtSize(w, fs) + tc * (k - j - 1);
              page.pushOperators(L.setCharacterSpacing(tc + (want - got) / (k - j - 1)));
            }
            page.drawText(w, { x: left + (cb[j] ? cb[j].left : 0), y: -yDown, size: fs, font, color: fill.rgb, opacity: fill.a * op });
            if (k - j > 1) page.pushOperators(L.setCharacterSpacing(tc));
            j = k;
          }
          continue;
        }
        if (!Object.keys(st).length && gs.every(has)) { // cả dòng 1 kiểu: vẽ 1 lần
          const txt = gs.join(''), lw = font.widthOfTextAtSize(txt, fs) + tc * Math.max(0, gs.length - 1);
          const x = o.textAlign === 'center' ? -lw / 2 : o.textAlign === 'right' ? o.width / 2 - lw : -o.width / 2;
          page.drawText(txt, { x, y: -yDown, size: fs, font, color: fill.rgb, opacity: fill.a * op });
          continue;
        }
        // nhiều đoạn (màu riêng từng đoạn / ký tự cần phông dự phòng): vẽ từng đoạn đúng vị trí ký tự như trên màn hình
        if (!fb && !gs.every(has)) fb = await getFont(out, ctx.fonts, 'Arial', isB, isI);
        const fbChars = fb && fb.getCharacterSet ? new Set(fb.getCharacterSet()) : null;
        const cb = (o.__charBounds && o.__charBounds[i]) || [], left = -o.width / 2 + (o._getLineLeftOffset ? o._getLineLeftOffset(i) : 0);
        let j = 0;
        while (j < gs.length) {
          const f0 = has(gs[j]) ? font : fb, c0 = (st[j] && st[j].fill) || o.fill; let k = j, s = '';
          while (k < gs.length && (has(gs[k]) ? font : fb) === f0 && ((st[k] && st[k].fill) || o.fill) === c0) {
            s += f0 === fb && fbChars && !fbChars.has(gs[k].codePointAt(0)) ? '?' : gs[k]; k++;
          }
          const fc2 = col(c0) || fill;
          if (outline) page.pushOperators(L.setStrokingColor(((st[j] && st[j].stroke && col(st[j].stroke)) || outline).rgb));
          if (s.trim()) page.drawText(s, { x: left + (cb[j] ? cb[j].left : 0), y: -yDown, size: fs, font: f0 || font, color: fc2.rgb, opacity: fc2.a * op });
          j = k;
        }
      }
      if (tc) page.pushOperators(L.setCharacterSpacing(0));
      if (outline || invisible) page.pushOperators(L.setTextRenderingMode(L.TextRenderingMode.Fill));
      return;
    }
    default: console.warn('Bỏ qua đối tượng', o.type);
  }
}
function wrapPage(out, page) {
  try {
    const c = out.context;
    const a = c.register(c.contentStream([L.pushGraphicsState()])), b = c.register(c.contentStream([L.popGraphicsState()]));
    page.node.wrapContentStreams(a, b);
  } catch (e) { console.warn('wrap', e); }
}
async function buildPdf(list = S.pages, opts = {}) { // opts.final: bản lưu chính (gắn mục lục…)
  const out = await L.PDFDocument.create();
  out.registerFontkit(fontkit);
  out.setProducer('PDF Editor'); out.setCreator('PDF Editor');
  const ctx = { fonts: {}, img: {}, regionPages: {}, imgRefs: new Map() };
  for (const pg of list) {
    let page;
    if (pg.src) {
      const [cp] = await out.copyPages(await getLib(pg.src), [pg.index]); page = out.addPage(cp);
      if (pageEdited(pg)) TextOps.strip(out, page, await prepRegions(out, pg.del, pg.imgEdits, ctx.imgRefs), pg.rm);
    } else page = out.addPage([pg.w, pg.h]);
    const R = effRot(pg); page.setRotation(L.degrees(R));
    const objs = await enliven(pg.objs);
    if (!objs.length) continue;
    // có đối tượng "dưới nội dung PDF": tách nội dung trang thành [nền, phần còn lại] TRƯỚC khi bọc q..Q
    let bgCut = null;
    if (pg.src && objs.some(o => o.under)) {
      try { const sp = TextOps.bgSplit(out, page); if (sp.offset > 0) { const [r1] = TextOps.splitContents(out, page, sp); bgCut = { ref: r1, ctm: sp.ctm }; } }
      catch (e) { console.warn('bgSplit', e); }
    }
    wrapPage(out, page);
    const { x: x0, y: y0, width: W, height: H } = page.getCropBox();
    const B = { 0: [1, 0, 0, -1, x0, y0 + H], 90: [0, 1, 1, 0, x0, y0], 180: [-1, 0, 0, 1, x0 + W, y0], 270: [0, -1, -1, 0, x0 + W, y0 + H] }[R];
    const drawList = async list => {
      page.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(...B));
      for (const o of list) {
        page.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(...o.calcTransformMatrix()));
        try { await drawObj(out, page, o, ctx); } catch (e) { console.error('Lỗi xuất đối tượng', o.type, e); }
        page.pushOperators(L.popGraphicsState());
      }
      page.pushOperators(L.popGraphicsState());
    };
    const under = objs.filter(o => o.under), over = objs.filter(o => !o.under);
    if (under.length) {
      // nhóm "dưới nội dung PDF": chèn ngay SAU phần nền của trang (ảnh nền / mảng tô cả trang) nếu có,
      // để không bị nền che mất; không có nền thì chèn lên đầu
      const after = bgCut ? bgCut.ref : null, inv = bgCut ? invM(bgCut.ctm) : null;
      if (inv) page.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(...inv));
      await drawList(under);
      if (inv) page.pushOperators(L.popGraphicsState());
      const ref = page.contentStreamRef, arr = page.node.Contents();
      if (ref && arr instanceof L.PDFArray) {
        const items = arr.asArray().filter(x => x !== ref);
        const at = after ? items.indexOf(after) + 1 : 0;
        items.splice(at, 0, ref);
        page.node.set(L.PDFName.of('Contents'), out.context.obj(items));
      }
      page.contentStream = undefined; page.contentStreamRef = undefined; // nhóm "trên" dùng content stream mới ở CUỐI
    }
    if (over.length) await drawList(over);
  }
  if (opts.final && window.PdfTools) { try { await PdfTools.beforeSave(out, list); } catch (e) { console.warn('beforeSave', e); } }
  return out.save();
}
function finishEditing() { for (const v of S.views.values()) { const a = v.fc && v.fc.getActiveObject(); if (a && a.isEditing) a.exitEditing(); } }
async function savePdf(saveAs = false) {
  if (!S.pages.length) return;
  finishEditing();
  busy(true, 'Đang tạo PDF…');
  let bytes;
  try { bytes = await buildPdf(undefined, { final: true }); } catch (e) { console.error(e); busy(false); return alert('Lỗi khi tạo PDF: ' + e.message); }
  busy(false);
  if (window.showSaveFilePicker) {
    try {
      if (!S.handle || saveAs) S.handle = await showSaveFilePicker({ suggestedName: S.fileName, types: [{ description: 'Tài liệu PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      const w = await S.handle.createWritable(); await w.write(bytes); await w.close();
      S.fileName = S.handle.name; S.dirty = false; updateUI(); toast('Đã lưu ' + S.handle.name);
      if (window.PdfRecent) PdfRecent.add([S.handle]);
      return;
    } catch (e) { if (e.name === 'AbortError') return; console.warn(e); S.handle = null; }
  }
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), S.fileName); S.dirty = false; updateUI();
}
async function downloadPdf() {
  if (!S.pages.length) return; finishEditing();
  busy(true, 'Đang tạo PDF…');
  try { const bytes = await buildPdf(undefined, { final: true }); downloadBlob(new Blob([bytes], { type: 'application/pdf' }), S.fileName); S.dirty = false; updateUI(); }
  catch (e) { console.error(e); alert('Lỗi khi tạo PDF: ' + e.message); } finally { busy(false); }
}
async function printPdf() {
  if (!S.pages.length) return; finishEditing();
  const w = window.open('', '_blank');
  busy(true, 'Đang tạo PDF…');
  try { const bytes = await buildPdf(undefined, { final: true }); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); if (w) w.location.href = url; else window.open(url); }
  catch (e) { w && w.close(); alert('Lỗi: ' + e.message); } finally { busy(false); }
}

/* ---------------- chữ ký ---------------- */
const Sig = { drawing: false, has: false };
function sigSaved() { try { return JSON.parse(localStorage.getItem('pdfedit.sigs') || '[]'); } catch (e) { return []; } }
function sigStore(list) { try { localStorage.setItem('pdfedit.sigs', JSON.stringify(list.slice(0, 6))); } catch (e) {} }
function openSig() {
  if (!S.pages.length) return toast('Hãy mở PDF trước');
  const pad = $('#sigPad'); pad.getContext('2d').clearRect(0, 0, pad.width, pad.height); Sig.has = false;
  const box = $('#sigSaved'); box.innerHTML = '';
  const list = sigSaved();
  list.forEach((u, i) => {
    const d = document.createElement('div'); d.className = 's'; d.title = 'Bấm để chèn chữ ký này';
    d.innerHTML = `<img src="${u}"><span class="x" title="Xoá">×</span>`;
    d.onclick = e => { if (e.target.classList.contains('x')) { const l = sigSaved(); l.splice(i, 1); sigStore(l); openSig(); return; } closeSig(); insertImage(u, 'sign'); };
    box.appendChild(d);
  });
  $('#sigModal').hidden = false;
}
function closeSig() { $('#sigModal').hidden = true; }
function sigTrim() {
  const c = $('#sigPad'), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let i = 0; i < c.width; i++) if (d[(y * c.width + i) * 4 + 3] > 8) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const p = 6; x0 = Math.max(0, x0 - p); y0 = Math.max(0, y0 - p); x1 = Math.min(c.width - 1, x1 + p); y1 = Math.min(c.height - 1, y1 + p);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o.toDataURL('image/png');
}
function initSig() {
  const c = $('#sigPad'), x = c.getContext('2d'); let last = null;
  const pos = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
  c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); Sig.drawing = true; last = pos(e); });
  c.addEventListener('pointermove', e => {
    if (!Sig.drawing) return; const p = pos(e);
    x.strokeStyle = $('#sigColor').value; x.lineWidth = +$('#sigWidth').value * 1.6; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(...last); x.lineTo(...p); x.stroke(); last = p; Sig.has = true;
  });
  const end = () => { Sig.drawing = false; };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  $('#sigClear').onclick = () => { x.clearRect(0, 0, c.width, c.height); Sig.has = false; };
  $('#sigCancel').onclick = closeSig;
  $('#sigModal').addEventListener('mousedown', e => { if (e.target.id === 'sigModal') closeSig(); });
  $('#sigOk').onclick = () => {
    const u = Sig.has && sigTrim(); if (!u) return toast('Hãy vẽ chữ ký trước');
    const l = sigSaved(); l.unshift(u); sigStore(l);
    closeSig(); insertImage(u, 'sign');
  };
}

/* ---------------- giao diện chung ---------------- */
function updateUI() {
  const has = S.pages.length > 0;
  const f = $('#fname'); f.textContent = has ? S.fileName : ''; f.classList.toggle('dirty', has && S.dirty);
  document.title = has ? `${S.dirty ? '• ' : ''}${S.fileName} — PDF Editor` : 'PDF Editor';
  $('#pgTotal').textContent = S.pages.length; $('#pgNum').max = S.pages.length; $('#pgNum').value = has ? S.cur + 1 : 0;
  $('#zVal').textContent = Math.round(S.zoom * 100) + '%';
  $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length;
  for (const id of ['btnSave', 'btnDownload', 'btnPrint', 'opDup', 'opRotL', 'opRotR', 'opDel', 'opExtract', 'opPng', 'opBlank', 'opMerge', 'selAll', 'opCopyPg', 'opWm', 'opOcr']) $('#' + id).disabled = !has;
  $('#opPastePg').disabled = !(S.clip && S.clip.pages);
  renderDocTabs();
  if (window.PdfRecent) PdfRecent.touch(); // tự lưu bản nháp vài giây sau khi có thay đổi
}
function bind() {
  $$('#tools [data-tool]').forEach(b => (b.onclick = () => setTool(b.dataset.tool)));
  $('#btnOpen').onclick = $('#emptyOpen').onclick = () => openPicker();
  $('#btnNew').onclick = $('#emptyNew').onclick = newDoc;
  $('#fileOpen').onchange = e => { openFiles(e.target.files, true); e.target.value = ''; };
  $('#opMerge').onclick = () => $('#fileMerge').click();
  $('#fileMerge').onchange = e => { openFiles(e.target.files, false); e.target.value = ''; };
  $('#btnImage').onclick = () => (S.pages.length ? $('#fileImage').click() : toast('Hãy mở PDF trước'));
  $('#fileImage').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) insertImage(await readAsDataURL(f)); };
  $('#btnSign').onclick = openSig;
  $('#btnSave').onclick = e => savePdf(e.shiftKey);
  $('#btnDownload').onclick = downloadPdf;
  $('#btnPrint').onclick = printPdf;
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#zIn').onclick = () => setZoom(S.zoom * 1.2);
  $('#zOut').onclick = () => setZoom(S.zoom / 1.2);
  $('#zFit').onclick = () => fitNow();
  $('#pgNum').onchange = e => scrollToPage(Math.max(1, Math.min(S.pages.length, +e.target.value)) - 1);
  $('#opBlank').onclick = insertBlank;
  $('#opDup').onclick = () => duplicatePages(targetPages());
  $('#opRotL').onclick = () => rotatePages(targetPages(), -90);
  $('#opRotR').onclick = () => rotatePages(targetPages(), 90);
  $('#opDel').onclick = () => deletePages(targetPages());
  $('#opExtract').onclick = extractPages;
  $('#opPng').onclick = exportPng;
  $('#selAll').onclick = () => { S.sel = new Set(S.pages.map(p => p.id)); $$('.thumb').forEach(t => t.classList.add('sel')); };
  $('#oTop').onclick = () => arrange('top'); $('#oUp').onclick = () => arrange('up');
  $('#oDown').onclick = () => arrange('down'); $('#oBottom').onclick = () => arrange('bottom');
  $('#oDup').onclick = () => { if (copySelected()) pasteObjs(); };
  $('#oImgSave').onclick = downloadSelectedImage;
  $('#oImgErase').onclick = () => { const o = activeObjs()[0]; if (!o || o.type !== 'image') return; S.eraseTarget = o; setTool('erase'); toast('Kéo khung trên ảnh để tẩy vùng đó — Esc hoặc chọn công cụ khác để xong', 3500); };
  $('#oImgReplace').onclick = () => $('#fileReplace').click();
  $('#fileReplace').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) replaceSelectedImage(f); };
  $('#opCopyPg').onclick = copyPagesClip;
  $('#opWm').onclick = openWatermarkPanel;
  $('#opOcr').onclick = runOcrCurrent;
  $('#wmApply').onclick = applyWatermarkPanel;
  $('#wmClose').onclick = () => { $('#wmModal').hidden = true; };
  $('#opPastePg').onclick = pastePages;
  // copy / dán qua phím Ctrl+C, Ctrl+V (dùng sự kiện copy/paste của trình duyệt)
  const editable = el => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  // doCopy chạy ở phím Ctrl+C và ở sự kiện copy (lần sau dùng lại kết quả lần đầu)
  const doCopy = () => {
    if (Date.now() - (S.lastCopyAt || 0) < 400 && S.clip) return S.clip.text;
    let text = null;
    if (S.selBox && S.views.get(S.selBox.v.page.id) === S.selBox.v) { // vùng quét bằng Chọn đối tượng (có chữ / ảnh gốc)
      text = '[PDF Editor: vùng đã copy]';
      const c = { kind: 'objs', objs: [], text, pageId: S.selBox.v.page.id };
      c.ready = copyRegion(S.selBox.v, S.selBox.box, true).then(o => { c.objs = o || []; }).catch(e => console.error(e));
      setClip(c);
      toast('Đã sao chép vùng — trỏ chuột vào chỗ muốn dán rồi bấm Ctrl+V (dán được sang trang / file khác)', 3500);
    } else if (activeObjs().length && !activeObjs().some(o => o.isEditing)) { text = copySelected(); if (text) toast('Đã copy đối tượng — Ctrl+V để dán (cả sang tab file khác)'); }
    else {
      const sel = window.getSelection();
      const c = clipFromSelection(sel);
      if (c) { text = sel.toString(); c.text = text; setClip(c); toast('Đã copy chữ (giữ phông, cỡ, màu) — Ctrl+V để dán vào file khác', 3000); }
      else if (S.focus === 'pages' && S.pages.length) text = copyPagesClip();
    }
    if (text) S.lastCopyAt = Date.now();
    return text;
  };
  S.doCopy = doCopy;
  document.addEventListener('copy', e => {
    if (editable(e.target) || !$('#sigModal').hidden) return;
    const text = doCopy();
    if (text) { e.clipboardData.setData('text/plain', text); e.preventDefault(); }
  });
  document.addEventListener('paste', async e => {
    clearTimeout(S.pasteT);
    if (editable(e.target) || !$('#sigModal').hidden) return;
    const text = e.clipboardData.getData('text/plain');
    const img = [...e.clipboardData.files].find(f => /^image\//.test(f.type));
    if (S.clip && (text === S.clip.text || S.clip.noSync || (!text && !img))) { e.preventDefault(); await pasteClip(); return; }
    if (!S.pages.length) return;
    e.preventDefault();
    if (img) { insertImage(await readAsDataURL(img)); return; }
    if (text && text.trim()) {
      const v = curView(); if (!v) return; await ready(v);
      const [W, H] = dispSize(v.page), viewer = $('#viewer');
      const y = Math.min(H - 40, Math.max(20, (viewer.scrollTop - v.el.offsetTop + viewer.clientHeight / 2) / S.zoom));
      const t = addText(v, { x: W * 0.15, y }, text.replace(/\r/g, '')); t.exitEditing(); syncView(v);
      v.fc.setActiveObject(t); v.fc.requestRenderAll();
    }
  });
  $('#oDel').onclick = deleteSelected;
  $('#viewer').addEventListener('scroll', onScroll, { passive: true });
  let zt; $('#viewer').addEventListener('wheel', e => {
    if (!e.ctrlKey) return; e.preventDefault();
    S.pendingZoom = (S.pendingZoom || S.zoom) * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
    const at = { x: e.clientX, y: e.clientY }; // giữ điểm dưới con trỏ chuột đứng yên
    clearTimeout(zt); zt = setTimeout(() => { setZoom(S.pendingZoom, at); S.pendingZoom = 0; }, 120);
  }, { passive: false });

  // thumbnails: chọn, nút, kéo thả sắp xếp
  const tb = $('#thumbs'); let dragIds = null;
  tb.addEventListener('mousedown', () => { S.focus = 'pages'; });
  $('#viewer').addEventListener('mousedown', () => { S.focus = 'canvas'; });
  tb.addEventListener('click', e => {
    const th = e.target.closest('.thumb'); if (!th) return;
    const btn = e.target.closest('button'); const pg = S.pages.find(p => p.id === th.dataset.id);
    if (btn) { if (btn.dataset.a === 'l') rotatePages([pg], -90); else if (btn.dataset.a === 'r') rotatePages([pg], 90); else deletePages([pg]); return; }
    thumbsSelect(th.dataset.id, e);
  });
  tb.addEventListener('dragstart', e => {
    const th = e.target.closest('.thumb'); if (!th) return;
    dragIds = S.sel.has(th.dataset.id) ? new Set(S.sel) : new Set([th.dataset.id]);
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-page', th.dataset.id);
  });
  const clearMarks = () => $$('.thumb').forEach(t => t.classList.remove('drop-before', 'drop-after'));
  tb.addEventListener('dragover', e => {
    if (!dragIds) return; e.preventDefault(); clearMarks();
    const th = e.target.closest('.thumb'); if (!th) return;
    const r = th.getBoundingClientRect(); th.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  tb.addEventListener('drop', e => {
    if (!dragIds) return; e.preventDefault(); e.stopPropagation();
    const th = e.target.closest('.thumb'); clearMarks();
    let before = null;
    if (th) { const r = th.getBoundingClientRect(); const i = S.pages.findIndex(p => p.id === th.dataset.id); const after = e.clientY >= r.top + r.height / 2; let j = after ? i + 1 : i; while (j < S.pages.length && dragIds.has(S.pages[j].id)) j++; before = S.pages[j] ? S.pages[j].id : null; }
    movePages(dragIds, before); dragIds = null;
  });
  tb.addEventListener('dragend', () => { dragIds = null; clearMarks(); });

  // kéo thả file vào cửa sổ
  window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dragover'); } });
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragover'); });
  window.addEventListener('drop', e => {
    if (!e.dataTransfer.files.length) return; e.preventDefault(); document.body.classList.remove('dragover');
    openFiles(e.dataTransfer.files, true);
  });

  // bảng thuộc tính
  const sw = $('#swatches');
  SWATCHES.forEach(c => { const s = document.createElement('span'); s.style.background = c; s.title = c; s.onclick = () => { $('#pColor').value = c; applyProp('color', c); }; sw.appendChild(s); });
  $('#pColor').addEventListener('input', e => applyProp('color', e.target.value, false));
  $('#pColor').addEventListener('change', e => applyProp('color', e.target.value));
  $('#pFill').addEventListener('input', e => { $('#pNoFill').checked = false; applyProp('fill', e.target.value, false); });
  $('#pFill').addEventListener('change', e => applyProp('fill', e.target.value));
  $('#pNoFill').addEventListener('change', e => applyProp('fill', e.target.checked ? '' : $('#pFill').value));
  $('#pStroke').addEventListener('input', e => { $('#pStrokeV').textContent = e.target.value; applyProp('stroke', +e.target.value, false); });
  $('#pStroke').addEventListener('change', e => applyProp('stroke', +e.target.value));
  $('#pOpacity').addEventListener('input', e => { $('#pOpacityV').textContent = Math.round(e.target.value * 100) + '%'; applyProp('opacity', +e.target.value, false); });
  $('#pOpacity').addEventListener('change', e => applyProp('opacity', +e.target.value));
  $('#pFont').onchange = e => applyProp('font', e.target.value);
  // mở danh sách phông: cập nhật thêm các phông vừa tải ngầm (tối đa 1 lần / phút)
  $('#pFont').addEventListener('mousedown', () => { if (Date.now() - (FONTS.loadedAt || 0) > 60000) loadFontList(); });
  $('#pSize').onchange = e => applyProp('size', Math.max(4, +e.target.value || 12));
  $('#pBold').onclick = () => { const on = !$('#pBold').classList.contains('on'); applyProp('bold', on); refreshProps(); };
  $('#pItalic').onclick = () => { const on = !$('#pItalic').classList.contains('on'); applyProp('italic', on); refreshProps(); };
  $$('.al').forEach(b => (b.onclick = () => { applyProp('align', b.dataset.align); refreshProps(); }));

  // phím tắt
  const KEYS = { v: 'select', i: 'textsel',e: 'edittext', t: 'text', p: 'draw', h: 'highlight', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout', m: 'measure' };
  window.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const editing = activeObjs().some(o => o.isEditing);
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (ctrl && k === 's') { e.preventDefault(); savePdf(e.shiftKey); return; }
    if (ctrl && k === 'o') { e.preventDefault(); openPicker(); return; }
    if (ctrl && k === 'f' && window.PdfFind) { e.preventDefault(); PdfFind.open(); return; } // tìm chữ trong file
    if (e.key === 'F3' && window.PdfFind && PdfFind.isOpen()) { e.preventDefault(); e.shiftKey ? PdfFind.prev() : PdfFind.next(); return; }
    if (editing || tag === 'input' || tag === 'textarea' || tag === 'select' || !$('#sigModal').hidden) return;
    if (ctrl && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (ctrl && k === 'y') { e.preventDefault(); redo(); return; }
    if (ctrl && k === 'c') { S.doCopy(); return; }
    if (ctrl && k === 'v') { clearTimeout(S.pasteT); if (S.clip) S.pasteT = setTimeout(() => pasteClip(), 200); return; } // dự phòng nếu trình duyệt không phát sự kiện paste
    if (ctrl && k === 'd') { e.preventDefault(); if (copySelected()) pasteObjs(); return; }
    if (ctrl && (e.code === 'BracketRight' || e.code === 'BracketLeft') && activeObjs().length) {
      e.preventDefault(); arrange(e.code === 'BracketRight' ? (e.shiftKey ? 'top' : 'up') : (e.shiftKey ? 'bottom' : 'down')); return;
    }
    if (ctrl && k === 'a' && S.tool === 'select' && S.focus !== 'pages') {
      // chọn hết đối tượng đã thêm/sửa trên trang hiện tại (để copy sang file khác)
      const v = curView(), objs = v && v.fc ? v.fc.getObjects().filter(o => o.selectable !== false) : []; if (objs.length) {
        e.preventDefault(); window.getSelection().removeAllRanges(); deselectOthers(v);
        v.fc.discardActiveObject();
        v.fc.setActiveObject(objs.length === 1 ? objs[0] : new fabric.ActiveSelection(objs, { canvas: v.fc })); v.fc.requestRenderAll();
        S.activeView = v; refreshProps();
      }
      return;
    }
    if (ctrl && k === 'a' && S.focus === 'pages') { e.preventDefault(); $('#selAll').click(); return; }
    if ((k === 'delete' || k === 'backspace') && S.selBusy) { e.preventDefault(); S.pendingDelete = true; toast('Đang quét vùng… sẽ xoá ngay khi xong'); return; }
    if ((k === 'delete' || k === 'backspace') && S.selBox && S.views.get(S.selBox.v.page.id) === S.selBox.v) { e.preventDefault(); deleteSelBox(); return; }
    if (k === 'delete' || k === 'backspace') { if (activeObjs().length) { e.preventDefault(); deleteSelected(); } return; }
    if (k === 'escape') { clearSelBox(); setTool('select'); for (const v of S.views.values()) if (v.fc) { v.fc.discardActiveObject(); v.fc.requestRenderAll(); } return; }
    if (k.startsWith('arrow') && activeObjs().length) {
      e.preventDefault(); const d = e.shiftKey ? 10 : 1, v = S.activeView, a = v.fc.getActiveObject();
      a.set({ left: a.left + (k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0), top: a.top + (k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0) }); a.setCoords(); v.fc.requestRenderAll();
      clearTimeout(S.nudgeT); S.nudgeT = setTimeout(() => syncView(v), 300); return;
    }
    if (!ctrl && !e.altKey && KEYS[k] && S.pages.length) setTool(KEYS[k]);
    if (!ctrl && (k === '+' || k === '=')) setZoom(S.zoom * 1.2);
    if (!ctrl && k === '-') setZoom(S.zoom / 1.2);
  });
  window.addEventListener('beforeunload', e => { if ((S.dirty && S.pages.length) || S.docs.some((d, i) => i !== S.docIdx && d.dirty && d.pages.length)) { e.preventDefault(); e.returnValue = ''; } });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(updateUI, 200); });
}

S.docs.push(emptyDoc()); S.docIdx = 0;
bind(); initSig(); setTool('select'); updateUI(); loadFontList();
