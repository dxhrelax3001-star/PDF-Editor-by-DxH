/* PDF Editor — 15. So sánh 2 bản PDF (vd bản vẽ trước / sau khi sửa, hợp đồng 2 phiên bản)
   - Cạnh nhau: 2 bản đặt song song, khung đỏ quanh chỗ khác nhau
   - Chồng lớp: 1 hình — đen = giống nhau, ĐỎ = chỉ có ở bản A (đã bị bỏ), XANH = chỉ có ở bản B (mới thêm)
   So từng trang theo số thứ tự, bằng hình ảnh (nên so được cả bản vẽ, bản scan). Chạy hết trên máy, không gửi file đi đâu. */
const PdfCompare = (() => {
  const AW = 1100; // độ rộng ảnh dùng để so (điểm ảnh)
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let M = null; // trạng thái hộp so sánh đang mở

  /* ---------- nguồn: tab đang mở hoặc file chọn từ máy ---------- */
  function tabOptions() {
    return S.docs.map((d, i) => {
      const cur = i === S.docIdx, pages = cur ? S.pages : d.pages, name = cur ? S.fileName : d.fileName;
      return pages && pages.length ? { i, name, cur } : null;
    }).filter(Boolean);
  }
  async function loadTab(i) {
    const cur = i === S.docIdx, pages = cur ? S.pages : S.docs[i].pages, name = cur ? S.fileName : S.docs[i].fileName;
    if (cur) finishEditing();
    const bytes = await buildPdf(pages);
    return { name: name + (cur && S.dirty ? ' (đang sửa)' : ''), js: await pdfjsLib.getDocument({ data: bytes }).promise };
  }
  const pickFile = () => new Promise(ok => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf,.pdf';
    inp.onchange = async () => { const f = inp.files[0]; ok(f ? await fileSrc(f) : null); };
    inp.click();
  });

  /* ---------- vẽ 1 trang ở độ rộng cho trước ---------- */
  async function renderPage(js, n, width) {
    if (!js || n > js.numPages) return null;
    const p = await js.getPage(n), v1 = p.getViewport({ scale: 1 }), sc = width / v1.width, vp = p.getViewport({ scale: sc });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: x, viewport: vp }).promise;
    return c;
  }

  /* ---------- so 1 trang: mặt nạ "chỉ có ở A" / "chỉ có ở B" + các khung chỗ khác ---------- */
  // n = số thứ tự CẶP trang (M.pairs[n-1] = { a: trang bản A | null, b: trang bản B | null })
  async function diffPage(n) {
    if (M.cache.has(n)) return M.cache.get(n);
    const pr = M.pairs[n - 1];
    const [ca, cb] = await Promise.all([pr.a ? renderPage(M.A.js, pr.a, AW) : null, pr.b ? renderPage(M.B.js, pr.b, AW) : null]);
    let res;
    if (!ca || !cb) res = { missing: !ca ? 'A' : 'B', rects: [{ x: 0, y: 0, w: 1, h: 1 }] };
    else {
      const W = AW, H = Math.max(ca.height, cb.height);
      const lum = c => { const d = c.getContext('2d').getImageData(0, 0, W, c.height).data, L0 = new Uint8Array(W * H).fill(255); for (let i = 0, j = 0; j < W * c.height; i += 4, j++) L0[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; return L0; };
      const la = lum(ca), lb = lum(cb);
      const ink = L0 => { const m = new Uint8Array(W * H); for (let i = 0; i < m.length; i++) m[i] = L0[i] < 200 ? 1 : 0; return m; };
      const ia = ink(la), ib = ink(lb);
      // nới 1–2 điểm ảnh: lệch khử răng cưa / làm tròn không tính là khác
      const dil = m => { const o = new Uint8Array(m.length); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!m[y * W + x]) continue; for (let dy = -2; dy <= 2; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -2; dx <= 2; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) o[yy * W + xx] = 1; } } } return o; };
      const da = dil(ia), db = dil(ib);
      const onlyA = new Uint8Array(W * H), onlyB = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) { if (ia[i] && !db[i]) onlyA[i] = 1; if (ib[i] && !da[i]) onlyB[i] = 1; }
      // gom thành ô 10px, ô có >= 3 điểm khác → nối các ô gần nhau thành khung
      const G = 10, gw = Math.ceil(W / G), gh = Math.ceil(H / G), cell = new Uint16Array(gw * gh);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (onlyA[i] || onlyB[i]) cell[((y / G) | 0) * gw + ((x / G) | 0)]++; }
      const on = new Uint8Array(gw * gh); for (let i = 0; i < on.length; i++) on[i] = cell[i] >= 3 ? 1 : 0;
      const seen = new Uint8Array(gw * gh), rects = [];
      for (let s = 0; s < on.length; s++) {
        if (!on[s] || seen[s]) continue;
        let x0 = s % gw, x1 = x0, y0 = (s / gw) | 0, y1 = y0; const st = [s]; seen[s] = 1;
        while (st.length) {
          const k = st.pop(), cx = k % gw, cy = (k / gw) | 0;
          if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue; const q = ny * gw + nx; if (on[q] && !seen[q]) { seen[q] = 1; st.push(q); } }
        }
        rects.push({ x: x0 * G / W, y: y0 * G / H, w: (x1 - x0 + 1) * G / W, h: (y1 - y0 + 1) * G / H });
      }
      res = { W, H, ia, ib, onlyA, onlyB, rects };
    }
    M.cache.set(n, res);
    // mặt nạ điểm ảnh rất nặng (~7 MB / trang): chỉ giữ cho 3 trang gần nhất, trang cũ chỉ giữ các khung chỗ khác
    if (res.ia) { M.masked = (M.masked || []).filter(k => k !== n); M.masked.push(n); while (M.masked.length > 3) { const o = M.cache.get(M.masked.shift()); if (o) { o.ia = o.ib = o.onlyA = o.onlyB = null; } } }
    return res;
  }

  /* ---------- hộp so sánh ---------- */
  function open() {
    if (M) return;
    const tabs = tabOptions();
    const opts = sel => tabs.map(t => `<option value="t${t.i}"${t.i === sel ? ' selected' : ''}>${t.cur ? 'Đang sửa' : 'Đang mở'}: ${esc(t.name)}</option>`).join('') + '<option value="file">Chọn file từ máy…</option>';
    const a0 = tabs.find(t => t.cur) || tabs[0], b0 = tabs.find(t => !a0 || t.i !== a0.i);
    // nằm gọn trong vùng xem trang (giữ thanh trên, thanh công cụ, cột Trang và cột Thuộc tính như bình thường)
    const m = document.createElement('div'); m.className = 'cmp-dock';
    m.innerHTML = `<div class="cmp-card">
      <div class="cmp-top">
        <b class="cmp-title"><span class="ti ti-arrows-diff"></span> So sánh 2 bản PDF</b>
        <label>Bản A <select data-a>${opts(a0 ? a0.i : -1)}</select></label>
        <label>Bản B <select data-b>${b0 ? opts(b0.i) : opts(-1).replace('<option value="file">', '<option value="" selected>— chọn —</option><option value="file">')}</select></label>
        <span class="spacer"></span>
        <div class="cmp-mode"><button data-mode="side" class="on">Cạnh nhau</button><button data-mode="over">Chồng lớp</button></div>
        <button class="ghost" data-report title="Tải file PDF báo cáo: trang tóm tắt + mỗi trang có chỗ khác (2 bản cạnh nhau, khung đỏ đánh số)"><span class="ti ti-file-export"></span> Xuất báo cáo PDF</button>
        <button class="ghost" data-x title="Đóng (Esc)">Đóng</button>
      </div>
      <div class="cmp-nav">
        <button class="ghost" data-prev title="Trang trước">◀</button><span data-pg>—</span><button class="ghost" data-next title="Trang sau">▶</button>
        <button class="ghost" data-nextdiff title="Tới trang có chỗ khác tiếp theo">Trang khác tiếp ▶▶</button>
        <span data-sum class="cmp-sum"></span><span class="spacer"></span><span data-pages class="cmp-pages"></span>
      </div>
      <div class="cmp-legend" data-legend hidden><i class="lg-a"></i> Chỉ có ở bản A (đã bị bỏ) <i class="lg-b"></i> Chỉ có ở bản B (mới thêm) <i class="lg-s"></i> Giống nhau</div>
      <div class="cmp-body" data-body><p class="muted" style="padding:30px;text-align:center">Chọn 2 bản cần so sánh ở trên.</p></div>
    </div>`;
    document.body.appendChild(m);
    const place = () => { const r = $('#viewer').getBoundingClientRect(); Object.assign(m.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); };
    let rt; const onResize = () => { place(); clearTimeout(rt); rt = setTimeout(() => { if (M && M.A && M.B) show(); }, 300); };
    place(); window.addEventListener('resize', onResize);
    M = { m, A: null, B: null, n: 1, mode: 'side', cache: new Map(), total: 0, token: 0, diffPages: new Map() };
    const q = s => m.querySelector(s);
    const close = () => { m.remove(); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize); M = null; };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'ArrowRight' && e.target.tagName !== 'SELECT') go(M.n + 1); else if (e.key === 'ArrowLeft' && e.target.tagName !== 'SELECT') go(M.n - 1); };
    document.addEventListener('keydown', onKey, true);
    q('[data-x]').onclick = close;
    q('[data-report]').onclick = exportReport;
    q('[data-prev]').onclick = () => go(M.n - 1);
    q('[data-next]').onclick = () => go(M.n + 1);
    q('[data-nextdiff]').onclick = () => { const ks = [...M.diffPages.keys()].filter(k => M.diffPages.get(k) > 0).sort((a, b) => a - b); const nx = ks.find(k => k > M.n) || ks[0]; if (nx) go(nx); else toast('Chưa thấy trang nào khác (đang so dần các trang…)'); };
    m.querySelectorAll('[data-mode]').forEach(b => (b.onclick = () => { M.mode = b.dataset.mode; m.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b)); show(); }));
    const pick = async (sel, side) => {
      const v = sel.value; if (!v) return;
      busy(true, 'Đang chuẩn bị bản ' + side + '…');
      try {
        const src = v === 'file' ? await pickFile() : await loadTab(+v.slice(1));
        if (!src) { sel.value = ''; return; }
        if (v === 'file') { const o = document.createElement('option'); o.value = 'f' + Date.now(); o.textContent = 'File chọn: ' + src.name; sel.insertBefore(o, sel.lastElementChild); sel.value = o.value; M.files = M.files || {}; M.files[o.value] = src; }
        M[side] = src;
      } finally { busy(false); }
      restart();
    };
    q('[data-a]').onchange = e => { const v = e.target.value; if (M.files && M.files[v]) { M.A = M.files[v]; restart(); } else pick(e.target, 'A'); };
    q('[data-b]').onchange = e => { const v = e.target.value; if (M.files && M.files[v]) { M.B = M.files[v]; restart(); } else pick(e.target, 'B'); };
    // nhận file kéo thả vào hộp so sánh làm bản B (không mở thành tab mới)
    m.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); m.classList.add('cmp-drag'); });
    m.addEventListener('dragleave', e => { if (e.target === m) m.classList.remove('cmp-drag'); });
    m.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); m.classList.remove('cmp-drag');
      const f = [...e.dataTransfer.files].find(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)); if (!f) return toast('Hãy thả file PDF');
      setFileB(await fileSrc(f));
    });
    // mặc định: A = tab đang xem; B = tab khác nếu có, không thì HỎI FILE NGAY (mở hộp chọn file trong lúc còn "cú bấm" của người dùng,
    // trước khi chuẩn bị bản A — chờ xong mới mở thì trình duyệt chặn hộp chọn file)
    const pb = b0 ? null : pickFile();
    if (!b0) q('[data-body]').innerHTML = `<div class="cmp-ask"><p>So <b>${esc(a0 ? a0.name : 'bản đang mở')}</b> với file nào?</p><button class="primary" data-pickb><span class="ti ti-folder-open"></span> Chọn file bản B…</button><p class="muted">hoặc kéo thả file PDF vào đây — không cần mở thành tab mới</p></div>`;
    const pbBtn = q('[data-pickb]'); if (pbBtn) pbBtn.onclick = async () => { const s = await pickFile(); if (s) setFileB(s); };
    (async () => {
      if (a0) await pick(q('[data-a]'), 'A');
      if (b0) await pick(q('[data-b]'), 'B');
      else { const s = await pb; if (s && M && !M.B) setFileB(s); }
    })();
  }
  // đặt 1 file (không phải tab) làm bản B
  function setFileB(src) {
    if (!M || !src) return;
    const sel = M.m.querySelector('[data-b]'), o = document.createElement('option');
    o.value = 'f' + Date.now(); o.textContent = 'File chọn: ' + src.name;
    sel.insertBefore(o, sel.querySelector('option[value=file]')); sel.value = o.value;
    M.files = M.files || {}; M.files[o.value] = src; M.B = src; restart();
  }
  const fileSrc = async f => { try { return { name: f.name, js: await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise }; } catch (e) { alert('Không mở được file: ' + (e.message || e)); return null; } };
  /* ---------- 21. ghép cặp trang khi 2 bản lệch trang (thêm / bớt trang ở giữa) ----------
     Mỗi trang → "dấu vân" = lưới 32×44 độ phủ mực (vẽ nhỏ 200px). Khoảng cách 2 trang = Σ|a−b| / Σ(a+b) (0 = giống hệt, 1 = khác hẳn).
     Ghép theo thứ tự bằng quy hoạch động (như so sánh văn bản): ghép 2 trang tốn đúng khoảng cách, bỏ lẻ 1 trang tốn GAP
     → trang sửa nhẹ vẫn ghép với nhau; trang chèn thêm / bị bỏ thành trang lẻ, các trang sau không bị lệch. */
  const GX = 32, GY = 44, GAP = 0.33;
  async function pageSig(js, n) {
    const c = await renderPage(js, n, 200), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data;
    const g = new Float32Array(GX * GY), cnt = new Float32Array(GX * GY);
    for (let y = 0; y < c.height; y++) for (let xx = 0; xx < c.width; xx++) {
      const i = (y * c.width + xx) * 4, k = Math.min(GY - 1, (y * GY / c.height) | 0) * GX + Math.min(GX - 1, (xx * GX / c.width) | 0);
      cnt[k]++; if (d[i] + d[i + 1] + d[i + 2] < 600) g[k]++;
    }
    for (let k = 0; k < g.length; k++) g[k] /= cnt[k] || 1;
    return { g, asp: c.height / c.width };
  }
  function sigDist(a, b) {
    let s = 0, t = 0; for (let k = 0; k < a.g.length; k++) { s += Math.abs(a.g[k] - b.g[k]); t += a.g[k] + b.g[k]; }
    return (t > 1e-6 ? s / t : 0) + (Math.abs(a.asp - b.asp) / Math.max(a.asp, b.asp) > 0.08 ? 0.4 : 0);
  }
  async function alignPages(tok) {
    const na = M.A.js.numPages, nb = M.B.js.numPages, SA = [], SB = [];
    for (let i = 1; i <= na; i++) { if (!M || tok !== M.token) return null; SA.push(await pageSig(M.A.js, i)); setMsg(`Đang ghép trang ${i + SB.length}/${na + nb}…`); }
    for (let j = 1; j <= nb; j++) { if (!M || tok !== M.token) return null; SB.push(await pageSig(M.B.js, j)); setMsg(`Đang ghép trang ${na + j}/${na + nb}…`); }
    const D = [], P = [];
    for (let i = 0; i <= na; i++) { D.push(new Float64Array(nb + 1)); P.push(new Uint8Array(nb + 1)); }
    for (let i = 1; i <= na; i++) { D[i][0] = i * GAP; P[i][0] = 1; }
    for (let j = 1; j <= nb; j++) { D[0][j] = j * GAP; P[0][j] = 2; }
    for (let i = 1; i <= na; i++) for (let j = 1; j <= nb; j++) {
      const m0 = D[i - 1][j - 1] + sigDist(SA[i - 1], SB[j - 1]), m1 = D[i - 1][j] + GAP, m2 = D[i][j - 1] + GAP;
      if (m0 <= m1 && m0 <= m2) { D[i][j] = m0; P[i][j] = 0; } else if (m1 <= m2) { D[i][j] = m1; P[i][j] = 1; } else { D[i][j] = m2; P[i][j] = 2; }
    }
    const out = []; let i = na, j = nb;
    while (i > 0 || j > 0) { const p = P[i][j]; if (p === 0) { out.push({ a: i, b: j }); i--; j--; } else if (p === 1) { out.push({ a: i, b: null }); i--; } else { out.push({ a: null, b: j }); j--; } }
    return out.reverse();
  }
  const setMsg = s => { const b = M && M.m.querySelector('[data-body]'); if (b) b.innerHTML = `<p class="muted" style="padding:30px;text-align:center">${s}</p>`; };
  const pairLabel = p => p.a && p.b ? (p.a === p.b ? `${p.a}` : `A${p.a}↔B${p.b}`) : p.a ? `A${p.a}` : `B${p.b}`;
  async function restart() {
    if (!M) return;
    M.cache.clear(); M.diffPages.clear(); M.masked = []; M.pairs = null; const tok = ++M.token;
    if (!M.A || !M.B) return;
    const pairs = await alignPages(tok); if (!M || tok !== M.token || !pairs) return;
    M.pairs = pairs; M.total = pairs.length; M.n = Math.min(M.n, M.total) || 1;
    const shifted = pairs.some(p => !p.a || !p.b || p.a !== p.b);
    if (shifted) toast(`Hai bản lệch trang: ${pairs.filter(p => !p.b).length} trang bị bỏ, ${pairs.filter(p => !p.a).length} trang thêm — đã tự ghép các trang giống nhau`, 5000);
    show(); scanAll(tok);
  }
  // so dần tất cả các trang ở nền → hiện danh sách trang có chỗ khác
  async function scanAll(tok) {
    for (let n = 1; M && tok === M.token && n <= M.total; n++) {
      try { const r = await diffPage(n); if (!M || tok !== M.token) return; M.diffPages.set(n, r.rects.length); renderChips(); } catch (e) { console.warn(e); }
      await new Promise(r => setTimeout(r, 0));
    }
  }
  function renderChips() {
    const box = M.m.querySelector('[data-pages]'), done = M.diffPages.size, bad = [...M.diffPages].filter(([, c]) => c > 0).map(([k]) => k).sort((a, b) => a - b);
    box.innerHTML = (done < M.total ? `<span class="muted">Đang so ${done}/${M.total} trang… </span>` : '') +
      (bad.length ? 'Trang có chỗ khác: ' + bad.map(k => { const p = M.pairs[k - 1]; return `<button class="cmp-chip${k === M.n ? ' on' : ''}${!p.a ? ' add' : !p.b ? ' del' : ''}" data-go="${k}" title="${!p.a ? 'Trang mới thêm ở bản B' : !p.b ? 'Trang bị bỏ (chỉ có ở bản A)' : `Bản A trang ${p.a} ↔ bản B trang ${p.b}`}">${pairLabel(p)}</button>`; }).join('') : done >= M.total ? '<span class="cmp-same">✓ Các trang giống nhau</span>' : '');
    box.querySelectorAll('[data-go]').forEach(b => (b.onclick = () => go(+b.dataset.go)));
  }
  function go(n) { if (!M || !M.total) return; n = Math.max(1, Math.min(M.total, n)); if (n === M.n) return; M.n = n; show(); }
  async function show() {
    if (!M || !M.A || !M.B) return;
    if (!M.pairs) return;
    const tok = ++M.showTok || (M.showTok = 1), n = M.n, body = M.m.querySelector('[data-body]'), pr = M.pairs[n - 1];
    M.m.querySelector('[data-pg]').textContent = pr.a && pr.b && pr.a === pr.b ? `Trang ${pr.a} (${n}/${M.total})` : `A: ${pr.a ? 'trang ' + pr.a : '—'} ↔ B: ${pr.b ? 'trang ' + pr.b : '—'} (${n}/${M.total})`;
    M.m.querySelector('[data-legend]').hidden = M.mode !== 'over';
    body.innerHTML = '<p class="muted" style="padding:30px;text-align:center">Đang so trang ' + n + '…</p>';
    let d = await diffPage(n); if (!M || M.showTok !== tok) return;
    if (M.mode === 'over' && !d.missing && !d.ia) { M.cache.delete(n); d = await diffPage(n); if (!M || M.showTok !== tok) return; } // cần lại mặt nạ để vẽ chồng lớp
    M.diffPages.set(n, d.rects.length); renderChips();
    const sum = M.m.querySelector('[data-sum]');
    sum.textContent = d.missing === 'A' ? 'Trang mới thêm ở bản B' : d.missing === 'B' ? 'Trang bị bỏ — chỉ có ở bản A' : d.rects.length ? `${d.rects.length} chỗ khác nhau` : 'Giống nhau';
    sum.className = 'cmp-sum ' + (d.missing || d.rects.length ? 'bad' : 'ok');
    body.innerHTML = '';
    const bw = body.clientWidth - 32;
    if (M.mode === 'side' || d.missing) {
      const W = Math.max(200, Math.floor((bw - 16) / 2)), dpr = Math.min(2, devicePixelRatio || 1);
      const wrap = document.createElement('div'); wrap.className = 'cmp-side'; body.appendChild(wrap);
      for (const [side, src] of [['A', M.A], ['B', M.B]]) {
        const col = document.createElement('div'); col.className = 'cmp-col';
        const pn = side === 'A' ? pr.a : pr.b;
        col.innerHTML = `<div class="cmp-cap">Bản ${side}: ${esc(src.name)}${pn ? ' — trang ' + pn : ''}</div>`;
        const c = pn ? await renderPage(src.js, pn, W * dpr) : null; if (!M || M.showTok !== tok) return;
        if (!c) { col.insertAdjacentHTML('beforeend', `<div class="cmp-miss" style="width:${W}px">${side === 'A' ? 'Bản A không có trang này<br><b>Trang mới thêm ở bản B</b>' : 'Bản B không có trang này<br><b>Trang đã bị bỏ</b>'}</div>`); wrap.appendChild(col); continue; }
        c.style.width = W + 'px'; const pg = document.createElement('div'); pg.className = 'cmp-page'; pg.appendChild(c);
        if (!d.missing) for (const r of d.rects) { const b = document.createElement('i'); b.className = 'cmp-box'; Object.assign(b.style, { left: r.x * 100 + '%', top: r.y * (d.H / (c.height / c.width * AW)) * 100 + '%', width: r.w * 100 + '%', height: r.h * (d.H / (c.height / c.width * AW)) * 100 + '%' }); pg.appendChild(b); }
        col.appendChild(pg); wrap.appendChild(col);
      }
    } else {
      // chồng lớp: đen = giống, đỏ = chỉ A, xanh = chỉ B
      const c = document.createElement('canvas'); c.width = d.W; c.height = d.H;
      const x = c.getContext('2d'), img = x.createImageData(d.W, d.H), p = img.data;
      for (let i = 0, j = 0; i < d.W * d.H; i++, j += 4) {
        let r = 255, g = 255, b = 255;
        if (d.onlyA[i]) { r = 220; g = 30; b = 30; } else if (d.onlyB[i]) { r = 20; g = 110; b = 230; } else if (d.ia[i] || d.ib[i]) { r = g = b = 70; }
        p[j] = r; p[j + 1] = g; p[j + 2] = b; p[j + 3] = 255;
      }
      x.putImageData(img, 0, 0);
      c.style.width = Math.min(bw, 900) + 'px'; c.className = 'cmp-over';
      const pg = document.createElement('div'); pg.className = 'cmp-page cmp-one'; pg.appendChild(c); body.appendChild(pg);
    }
  }
  /* ---------- 22. xuất báo cáo so sánh ra PDF (A3 ngang) ----------
     Trang 1: tóm tắt (tên 2 bản, ngày, danh sách trang khác). Mỗi trang sau: 2 bản cạnh nhau, khung đỏ đánh số quanh chỗ khác. */
  const RW = 1191, RH = 842, RK = 2; // A3 ngang (point) × 2 điểm ảnh / point
  function sheet() {
    const c = document.createElement('canvas'); c.width = RW * RK; c.height = RH * RK;
    const x = c.getContext('2d'); x.scale(RK, RK); x.fillStyle = '#fff'; x.fillRect(0, 0, RW, RH);
    return { c, x };
  }
  const F = (w, s) => `${w} ${s}px Arial, "Segoe UI", sans-serif`;
  function header(x, title, sub) {
    x.fillStyle = '#1a73e8'; x.fillRect(0, 0, RW, 6);
    x.fillStyle = '#1f2328'; x.font = F('bold', 20); x.fillText(title, 28, 38);
    x.fillStyle = '#555'; x.font = F('normal', 12); x.fillText(sub, 28, 58);
  }
  function footer(x, k, n) {
    x.fillStyle = '#888'; x.font = F('normal', 10); x.textAlign = 'right';
    x.fillText(`Báo cáo so sánh — PDF Editor by DxH — trang ${k}/${n}`, RW - 28, RH - 16); x.textAlign = 'left';
  }
  const fitText = (x, s, w) => { if (x.measureText(s).width <= w) return s; while (s.length > 3 && x.measureText(s + '…').width > w) s = s.slice(0, -1); return s + '…'; };
  async function exportReport() {
    if (!M || !M.pairs) return toast('Hãy chọn đủ 2 bản cần so sánh trước');
    busy(true, 'Đang làm báo cáo…');
    try {
      for (let n = 1; n <= M.total; n++) { if (!M.diffPages.has(n)) M.diffPages.set(n, (await diffPage(n)).rects.length); $('#busyMsg').textContent = `Đang so trang ${n}/${M.total}…`; }
      renderChips();
      const list = M.pairs.map((p, i) => ({ p, n: i + 1, d: M.cache.get(i + 1) || null, c: M.diffPages.get(i + 1) })).filter(e => e.c > 0);
      const when = new Date().toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
      const total = 1 + list.length, out = await L.PDFDocument.create();
      out.setTitle(`So sánh ${M.A.name} – ${M.B.name}`); out.setProducer('PDF Editor'); out.setCreator('PDF Editor by DxH');
      const add = async c => {
        const buf = await new Promise(ok => c.toBlob(b => b.arrayBuffer().then(ok), 'image/png'));
        const im = await out.embedPng(buf), pg = out.addPage([RW, RH]); pg.drawImage(im, { x: 0, y: 0, width: RW, height: RH });
      };
      // --- trang tóm tắt ---
      {
        const { c, x } = sheet();
        header(x, 'BÁO CÁO SO SÁNH 2 BẢN PDF', `Lập lúc ${when}`);
        x.font = F('bold', 14); x.fillStyle = '#1f2328';
        x.fillText('Bản A:', 28, 100); x.fillText('Bản B:', 28, 124);
        x.font = F('normal', 14);
        x.fillText(fitText(x, `${M.A.name}  (${M.A.js.numPages} trang)`, RW - 140), 90, 100);
        x.fillText(fitText(x, `${M.B.name}  (${M.B.js.numPages} trang)`, RW - 140), 90, 124);
        const nAdd = M.pairs.filter(p => !p.a).length, nDel = M.pairs.filter(p => !p.b).length, nChg = list.filter(e => e.p.a && e.p.b).length;
        x.font = F('bold', 16);
        x.fillStyle = list.length ? '#d93025' : '#188038';
        x.fillText(list.length ? `Có ${list.length} trang khác nhau: ${nChg} trang sửa, ${nAdd} trang mới thêm, ${nDel} trang bị bỏ` : 'Hai bản giống nhau — không có chỗ nào khác', 28, 166);
        let y = 204; x.fillStyle = '#1f2328';
        if (list.length) {
          x.font = F('bold', 12); x.fillText('STT', 28, y); x.fillText('Bản A', 80, y); x.fillText('Bản B', 170, y); x.fillText('Nội dung', 260, y); x.fillText('Xem ở trang báo cáo', 760, y);
          x.strokeStyle = '#ccc'; x.beginPath(); x.moveTo(28, y + 8); x.lineTo(RW - 28, y + 8); x.stroke(); y += 26;
          x.font = F('normal', 12);
          list.forEach((e, i) => {
            if (y > RH - 50) return;
            const what = !e.p.a ? 'Trang mới thêm ở bản B' : !e.p.b ? 'Trang bị bỏ (chỉ có ở bản A)' : `${e.c} chỗ khác nhau`;
            x.fillStyle = !e.p.a ? '#146ee6' : !e.p.b ? '#b3261e' : '#1f2328';
            x.fillText(String(i + 1), 28, y); x.fillText(e.p.a ? 'trang ' + e.p.a : '—', 80, y); x.fillText(e.p.b ? 'trang ' + e.p.b : '—', 170, y); x.fillText(what, 260, y); x.fillText(String(i + 2), 760, y);
            y += 22;
          });
          if (list.length > Math.floor((RH - 50 - 230) / 22)) { x.fillStyle = '#888'; x.fillText('… (xem tiếp ở các trang sau)', 28, RH - 40); }
        }
        x.fillStyle = '#666'; x.font = F('normal', 11);
        x.fillText('Cách đọc: mỗi trang sau đặt bản A (trái) và bản B (phải) cạnh nhau; khung đỏ đánh số là chỗ khác nhau, cùng số ở 2 bên là cùng một chỗ.', 28, RH - 60);
        footer(x, 1, total); await add(c);
      }
      // --- mỗi trang có chỗ khác ---
      for (let k = 0; k < list.length; k++) {
        const e = list[k], d = e.d || await diffPage(e.n);
        $('#busyMsg').textContent = `Đang vẽ trang báo cáo ${k + 2}/${total}…`;
        const { c, x } = sheet();
        const what = !e.p.a ? 'Trang mới thêm ở bản B' : !e.p.b ? 'Trang bị bỏ — chỉ có ở bản A' : `${e.c} chỗ khác nhau`;
        header(x, `${what}`, `Bản A: ${e.p.a ? 'trang ' + e.p.a : '—'}   ↔   Bản B: ${e.p.b ? 'trang ' + e.p.b : '—'}     ·     ${M.A.name}  /  ${M.B.name}`);
        const top = 92, gap = 24, pw = (RW - 28 * 2 - gap) / 2, ph = RH - top - 40;
        for (const [i, side, src, pn] of [[0, 'A', M.A, e.p.a], [1, 'B', M.B, e.p.b]]) {
          const left = 28 + i * (pw + gap);
          x.fillStyle = '#1f2328'; x.font = F('bold', 12); x.fillText(fitText(x, `Bản ${side}: ${src.name}${pn ? ' — trang ' + pn : ''}`, pw), left, top - 8);
          const pc = pn ? await renderPage(src.js, pn, Math.round(pw * RK * 1.2)) : null;
          if (!pc) {
            x.strokeStyle = '#ccc'; x.setLineDash([6, 4]); x.strokeRect(left, top, pw, ph); x.setLineDash([]);
            x.fillStyle = '#888'; x.font = F('normal', 16); x.textAlign = 'center';
            x.fillText(side === 'A' ? 'Bản A không có trang này (trang mới thêm ở bản B)' : 'Bản B không có trang này (trang đã bị bỏ)', left + pw / 2, top + ph / 2); x.textAlign = 'left';
            continue;
          }
          const s = Math.min(pw / pc.width, ph / pc.height), dw = pc.width * s, dh = pc.height * s, ox = left + (pw - dw) / 2, oy = top;
          x.drawImage(pc, ox, oy, dw, dh); x.strokeStyle = '#999'; x.lineWidth = 0.6; x.strokeRect(ox, oy, dw, dh);
          if (!d.missing) {
            const hAW = pc.height / pc.width * AW;
            d.rects.forEach((r, ri) => {
              const rx = ox + r.x * dw - 2, ry = oy + r.y * d.H / hAW * dh - 2, rw = r.w * dw + 4, rh = r.h * d.H / hAW * dh + 4;
              x.fillStyle = 'rgba(217,48,37,0.10)'; x.fillRect(rx, ry, rw, rh);
              x.strokeStyle = '#d93025'; x.lineWidth = 1.6; x.strokeRect(rx, ry, rw, rh);
              const lx = Math.max(ox + 8, rx), ly = Math.max(oy + 8, ry);
              x.fillStyle = '#d93025'; x.beginPath(); x.arc(lx, ly, 8, 0, Math.PI * 2); x.fill();
              x.fillStyle = '#fff'; x.font = F('bold', 10); x.textAlign = 'center'; x.fillText(String(ri + 1), lx, ly + 3.5); x.textAlign = 'left';
            });
          }
        }
        footer(x, k + 2, total); await add(c);
        await new Promise(r => setTimeout(r, 0));
      }
      const bytes = await out.save();
      const nm = s => s.replace(/\.pdf$/i, '').replace(/\s*\(đang sửa\)$/, '').replace(/[\\/:*?"<>|]+/g, '-');
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `So sanh - ${nm(M.A.name)} vs ${nm(M.B.name)}.pdf`);
      toast(`Đã xuất báo cáo ${total} trang`, 3000);
    } catch (e) { console.error(e); alert('Không xuất được báo cáo: ' + (e.message || e)); }
    finally { busy(false); }
  }
  return { open, exportReport };
})();
window.PdfCompare = PdfCompare;
