// Máy chủ tĩnh cho PDF Editor — http://localhost:3300
// Mọi xử lý PDF chạy trên trình duyệt (pdf.js + pdf-lib + fabric.js), file không gửi đi đâu.
// /fonts/list   : danh sách phông cài trên Windows (đọc registry) → giữ đúng phông khi sửa chữ
// /fonts/f/<file>: trả file phông (.ttf/.otf) để nhúng vào PDF
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = process.env.PORT || 3300;
const ROOT = __dirname;
const WIN_FONTS = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PRIVATE = new Set(['package.json', 'package-lock.json', 'server.js']);

// ---- phông chữ Windows ----
const fontFiles = new Map(); // tên file (chữ thường) -> đường dẫn đầy đủ  (phông con trong .ttc: { full, index })
// đọc các phông con trong 1 file .ttc: tên họ phông + đậm / nghiêng (bảng 'name', 'OS/2')
function ttcFaces(full) {
  const b = fs.readFileSync(full); if (b.toString('latin1', 0, 4) !== 'ttcf') return [];
  const n = b.readUInt32BE(8), faces = [];
  for (let i = 0; i < n; i++) {
    const off = b.readUInt32BE(12 + i * 4), nt = b.readUInt16BE(off + 4), tabs = {};
    for (let t = 0; t < nt; t++) { const r = off + 12 + t * 16; tabs[b.toString('latin1', r, r + 4)] = { o: b.readUInt32BE(r + 8), l: b.readUInt32BE(r + 12) }; }
    let family = '', sub = '';
    if (tabs.name) {
      const o = tabs.name.o, cnt = b.readUInt16BE(o + 2), so = o + b.readUInt16BE(o + 4), best = {};
      for (let k = 0; k < cnt; k++) {
        const r = o + 6 + k * 12, pid = b.readUInt16BE(r), lid = b.readUInt16BE(r + 4), nid = b.readUInt16BE(r + 6), len = b.readUInt16BE(r + 8), so2 = so + b.readUInt16BE(r + 10);
        if (pid !== 3 || (nid !== 1 && nid !== 2)) continue;
        const s = Buffer.from(b.subarray(so2, so2 + len)).swap16().toString('utf16le'), score = lid === 0x409 ? 2 : 1;
        if (!best[nid] || score > best[nid].score) best[nid] = { s, score };
      }
      family = best[1] ? best[1].s : ''; sub = best[2] ? best[2].s : '';
    }
    let bold = /bold/i.test(sub), italic = /italic|oblique/i.test(sub);
    if (tabs['OS/2']) { const sel = b.readUInt16BE(tabs['OS/2'].o + 62); bold = bold || !!(sel & 0x20); italic = italic || !!(sel & 0x01); }
    if (family) faces.push({ family, bold, italic });
    else faces.push({ family: path.basename(full, '.ttc') + ' ' + i, bold, italic });
  }
  return faces;
}
// tách 1 phông con trong .ttc thành file .ttf độc lập (để nhúng vào PDF)
function ttcExtract(full, index) {
  const b = fs.readFileSync(full), off = b.readUInt32BE(12 + index * 4), nt = b.readUInt16BE(off + 4);
  const recs = []; for (let t = 0; t < nt; t++) { const r = off + 12 + t * 16; recs.push({ tag: b.subarray(r, r + 4), sum: b.readUInt32BE(r + 4), o: b.readUInt32BE(r + 8), l: b.readUInt32BE(r + 12) }); }
  const head = 12 + nt * 16; let size = head; for (const r of recs) size += (r.l + 3) & ~3;
  const out = Buffer.alloc(size); b.copy(out, 0, off, off + 12); // sfnt version, numTables, searchRange…
  let p = head;
  recs.forEach((r, t) => { const q = 12 + t * 16; r.tag.copy(out, q); out.writeUInt32BE(r.sum, q + 4); out.writeUInt32BE(p, q + 8); out.writeUInt32BE(r.l, q + 12); b.copy(out, p, r.o, r.o + r.l); p += (r.l + 3) & ~3; });
  return out;
}
let fontList = [];
function loadFonts() {
  const list = [];
  const keys = ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'];
  for (const key of keys) {
    let out = '';
    try { out = execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true }); } catch (e) { continue; }
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/); if (!m) continue;
      const file = m[2]; if (!/\.(ttf|otf|ttc)$/i.test(file)) continue; // bỏ .fon
      const full = path.isAbsolute(file) ? file : path.join(WIN_FONTS, file);
      if (!fs.existsSync(full)) continue;
      if (/\.ttc$/i.test(full)) { // bộ nhiều phông (vd simsun.ttc = SimSun + NSimSun): mỗi phông con là 1 file ảo "<tên>.<số>.ttf"
        try { ttcFaces(full).forEach((f, i) => { const v = `${path.basename(full).toLowerCase()}.${i}.ttf`; fontFiles.set(v, { full, index: i }); list.push({ family: f.family, bold: f.bold, italic: f.italic, file: v }); }); } catch (e) { console.warn('ttc', full, e.message); }
        continue;
      }
      const base = path.basename(full).toLowerCase();
      fontFiles.set(base, full);
      const name = m[1].replace(/\s*\((TrueType|OpenType)\)\s*$/i, '');
      for (const part of name.split(/\s+&\s+/)) {
        let fam = part.trim(), bold = false, italic = false, mm;
        while ((mm = fam.match(/\s+(Bold|Italic|Oblique|Regular)$/i))) {
          const w = mm[1].toLowerCase(); if (w === 'bold') bold = true; if (w === 'italic' || w === 'oblique') italic = true;
          fam = fam.slice(0, mm.index);
        }
        list.push({ family: fam, bold, italic, file: base });
      }
    }
  }
  // phông miễn phí đã tải về từ Google Fonts (thư mục fonts-extra)
  for (const [family, rec] of Object.entries(gf.families)) for (const f of rec.files || []) {
    const full = path.join(EXTRA_DIR, f.file); if (!fs.existsSync(full)) continue;
    fontFiles.set(f.file.toLowerCase(), full);
    list.push({ family, bold: f.bold, italic: f.italic, file: f.file.toLowerCase(), web: true, weight: f.weight });
  }
  fontList = list;
  console.log(`Đã đọc ${list.length} phông chữ`);
}

/* ---- phông miễn phí Google Fonts (giấy phép mở OFL / Apache — dùng thương mại được) ----
   - /fonts/fetch?family=Tên  : tải họ phông đó (thường, đậm, nghiêng, đậm nghiêng) nếu Google Fonts có
   - lúc khởi động tải sẵn bộ phông phổ biến có tiếng Việt; mỗi tuần kiểm tra bản mới (đường dẫn file đổi = có bản mới)
   Chỉ gửi tên phông lên Google, không gửi nội dung tài liệu. Phông lưu trong pdf-editor/fonts-extra, không cài vào Windows. */
const EXTRA_DIR = path.join(ROOT, 'fonts-extra'), GF_MANIFEST = path.join(EXTRA_DIR, 'manifest.json');
let gf = { families: {}, missing: {} };
try { gf = Object.assign(gf, JSON.parse(fs.readFileSync(GF_MANIFEST, 'utf8'))); } catch (e) {}
const saveGf = () => { try { fs.mkdirSync(EXTRA_DIR, { recursive: true }); fs.writeFileSync(GF_MANIFEST, JSON.stringify(gf, null, 1)); } catch (e) { console.warn('manifest', e.message); } };
const GF_POPULAR = ['Roboto', 'Open Sans', 'Noto Sans', 'Noto Serif', 'Montserrat', 'Be Vietnam Pro', 'Lora', 'Merriweather', 'Source Sans 3', 'Inter',
  'Nunito', 'Nunito Sans', 'Raleway', 'Roboto Slab', 'Roboto Condensed', 'Roboto Mono', 'Playfair Display', 'Quicksand', 'Mulish', 'Work Sans',
  'Fira Sans', 'IBM Plex Sans', 'IBM Plex Serif', 'Josefin Sans', 'Oswald', 'Pacifico', 'Dancing Script', 'Lexend', 'Manrope', 'Archivo',
  'Barlow', 'Barlow Condensed', 'Arimo', 'Tinos', 'Cousine', 'Encode Sans', 'Exo 2', 'Kanit', 'Saira', 'Space Grotesk',
  'Sarabun', 'Alegreya', 'Cormorant Garamond', 'EB Garamond', 'Crimson Pro', 'Noto Sans Mono', 'Prompt', 'Signika', 'Asap', 'Cabin',
  'Comfortaa', 'Lobster', 'Patrick Hand', 'Bai Jamjuree', 'Chakra Petch', 'Literata', 'Source Serif 4', 'Spectral', 'Vollkorn', 'Bitter'];
const GF_WEEK = 7 * 24 * 3600 * 1000;
const gfBusy = new Map();
const validFam = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ]{1,48}$/.test(s);
async function gfFetchFamily(family, force) {
  if (!validFam(family)) return null;
  const key = family.trim().replace(/\s+/g, ' ');
  if (!force && gf.families[key]) return gf.families[key];
  if (!force && gf.missing[key] && Date.now() - gf.missing[key] < GF_WEEK) return null; // vừa tìm không thấy
  if (Object.keys(gf.families).length >= 400 && !gf.families[key]) return null; // giới hạn dung lượng
  if (gfBusy.has(key)) return gfBusy.get(key);
  const job = (async () => {
    const url = 'https://fonts.googleapis.com/css?family=' + encodeURIComponent(key).replace(/%20/g, '+') + ':400,700,400italic,700italic&subset=vietnamese,latin-ext';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/4.0' } }); // trình duyệt cũ → Google trả file .ttf
    if (r.status === 400 || r.status === 404) { gf.missing[key] = Date.now(); saveGf(); return null; }
    if (!r.ok) throw new Error('Google Fonts ' + r.status);
    const css = await r.text(), faces = [];
    for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
      const b = m[1], st = (b.match(/font-style:\s*(\w+)/) || [])[1], wt = +((b.match(/font-weight:\s*(\d+)/) || [])[1] || 400), u = (b.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/) || [])[1];
      if (u && !faces.some(f => f.url === u)) faces.push({ url: u, italic: st === 'italic', weight: wt, bold: wt >= 600 });
    }
    if (!faces.length) { gf.missing[key] = Date.now(); saveGf(); return null; }
    const old = gf.families[key];
    if (old && old.files && old.files.length === faces.length && faces.every(f => old.files.some(o => o.url === f.url))) { old.checked = Date.now(); saveGf(); return old; } // không có bản mới
    fs.mkdirSync(EXTRA_DIR, { recursive: true });
    const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-'), files = [];
    for (const f of faces) {
      const fr = await fetch(f.url); if (!fr.ok) continue;
      const buf = Buffer.from(await fr.arrayBuffer()); if (buf.length < 1000 || buf.length > 30e6) continue;
      const file = `g-${slug}-${f.weight}${f.italic ? 'i' : ''}.ttf`;
      fs.writeFileSync(path.join(EXTRA_DIR, file), buf);
      files.push({ file, url: f.url, weight: f.weight, bold: f.bold, italic: f.italic, size: buf.length });
    }
    if (!files.length) return null;
    gf.families[key] = { files, checked: Date.now() }; delete gf.missing[key]; saveGf(); loadFonts();
    console.log(`Đã tải phông ${key} (${files.length} kiểu)`);
    return gf.families[key];
  })().finally(() => gfBusy.delete(key));
  gfBusy.set(key, job);
  return job;
}
// tải sẵn bộ phổ biến (lần đầu) + mỗi tuần kiểm tra bản mới — chạy nền, lần lượt từng phông
async function gfMaintain() {
  for (const fam of GF_POPULAR) { if (!gf.families[fam]) { try { await gfFetchFamily(fam); } catch (e) { console.warn('gf', fam, e.message); return; } } }
  for (const [fam, rec] of Object.entries(gf.families)) if (Date.now() - (rec.checked || 0) > GF_WEEK) { try { await gfFetchFamily(fam, true); } catch (e) { console.warn('gf', fam, e.message); return; } }
}
loadFonts();
setTimeout(gfMaintain, 15000); setInterval(gfMaintain, 6 * 3600 * 1000);

// ---- nhật ký truy cập qua link Internet (chỉ xem được trên máy này: http://localhost:3300/truy-cap) ----
const VISITS = path.join(ROOT, 'logs', 'visits.jsonl');
// IP Tailscale của chính máy này: anh mở link Internet trên máy mình thì không tính
let ownIps = new Set();
try { ownIps = new Set(execFileSync('tailscale', ['ip'], { encoding: 'utf8', windowsHide: true }).split(/\s+/).filter(Boolean)); } catch (e) {}
// IP người vào: Tailscale Funnel ghi vào X-Forwarded-For (lấy giá trị cuối = do proxy thêm, không giả mạo được)
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();
const fromLoopback = req => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
function logVisit(req, page) {
  const ip = clientIp(req);
  if (ownIps.has(ip)) return;
  const rec = { t: new Date().toISOString(), ip, page: page === '/index.html' ? 'PDF Editor' : 'Hướng dẫn', ua: req.headers['user-agent'] || '', lang: (req.headers['accept-language'] || '').split(',')[0], ref: req.headers['referer'] || '' };
  fs.mkdir(path.dirname(VISITS), { recursive: true }, () => fs.appendFile(VISITS, JSON.stringify(rec) + '\n', () => {}));
}
function readVisits() {
  try { return fs.readFileSync(VISITS, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { return []; }
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';

  if (p === '/fonts/fetch') { // tải 1 họ phông miễn phí từ Google Fonts khi tài liệu cần
    const fam = new URL(req.url, 'http://x').searchParams.get('family') || '';
    gfFetchFamily(fam).then(rec => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(JSON.stringify({ ok: !!rec, family: rec ? fam.trim().replace(/\s+/g, ' ') : null })); })
      .catch(e => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (p === '/fonts/list') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(fontList));
  }
  const fm = p.match(/^\/fonts\/f\/([^/\\]+)$/i) || p.match(/^\/fonts\/([a-z0-9_-]+\.ttf)$/i);
  if (fm) {
    const full = fontFiles.get(fm[1].toLowerCase());
    if (!full) { res.writeHead(404); return res.end(); }
    if (typeof full === 'object') { // phông con trong .ttc
      try { const data = ttcExtract(full.full, full.index); res.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'max-age=86400' }); return res.end(data); }
      catch (e) { res.writeHead(500); return res.end(); }
    }
    return fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': /\.otf$/i.test(full) ? 'font/otf' : 'font/ttf', 'Cache-Control': 'max-age=86400' });
      res.end(data);
    });
  }

  const file = path.join(ROOT, p);
  // thư mục thử nghiệm / log chỉ mở cho máy này (không qua link Internet)
  const local = fromLoopback(req) && /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.headers.host || '') && !req.headers['tailscale-funnel-request'] && !req.headers['x-forwarded-for'];
  // chủ máy: mở trên máy này, kể cả qua link Internet (IP Tailscale của chính máy này)
  const owner = local || (fromLoopback(req) && ownIps.has(clientIp(req)));
  if (p === '/truy-cap' || p === '/truy-cap.json') {
    if (!owner) { res.writeHead(404); return res.end('Not found'); }
    if (p === '/truy-cap.json') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(JSON.stringify(readVisits())); }
    p = '/_admin/truy-cap.html';
    return fs.readFile(path.join(ROOT, p), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' }); res.end(data);
    });
  }
  if (/^\/_admin\//i.test(p) && !owner) { res.writeHead(404); return res.end('Not found'); }
  if (!local && (p === '/index.html' || p === '/huong-dan.html')) logVisit(req, p);
  if (/^\/(_test|logs)\//i.test(p) && !local) { res.writeHead(403); return res.end(); }
  if (!file.startsWith(ROOT) || PRIVATE.has(path.basename(file)) || /\.(cmd|bat|vbs|log)$/i.test(file)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`PDF Editor: http://localhost:${PORT}`));
