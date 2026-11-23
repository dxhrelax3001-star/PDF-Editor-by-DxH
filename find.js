/* PDF Editor — 26. Tìm chữ trong file (Ctrl+F)
   Tìm trong: chữ gốc của PDF, chữ nhận dạng trên trang scan (OCR), chữ đã thêm / đã sửa.
   Mọi chỗ trùng tô vàng, chỗ đang xem tô cam; Enter / Shift+Enter (hoặc F3) để nhảy tới / lui; Esc để đóng.
   Tuỳ chọn: phân biệt hoa / thường, bỏ qua dấu tiếng Việt ("hop dong" tìm ra "hợp đồng"). */
const PdfFind = (() => {
  let bar = null, hits = [], cur = -1, tok = 0, opt = { cs: false, nd: false };
  try { const o = JSON.parse(localStorage.getItem('pdfedit.find') || '{}'); opt.cs = !!o.cs; opt.nd = !!o.nd; } catch (e) {}
  const saveOpt = () => { try { localStorage.setItem('pdfedit.find', JSON.stringify(opt)); } catch (e) {} };
  const fold1 = c => { let x = c.normalize('NFD')[0] || c; if (x === 'đ') x = 'd'; else if (x === 'Đ') x = 'D'; return x; };
  // chuẩn hoá từng ký tự (giữ đúng vị trí ký tự để tô đúng chỗ)
  const norm = s => { let a = [...s]; if (opt.nd) a = a.map(fold1); if (!opt.cs) a = a.map(c => c.toLowerCase()); return a.join(''); };
  function findAll(str, q) { // vị trí (theo ký tự) các lần xuất hiện
    const A = [...norm(str)], Q = [...norm(q)], out = [];
    if (!Q.length || A.length < Q.length) return out;
    outer: for (let i = 0; i + Q.length <= A.length; i++) { for (let j = 0; j < Q.length; j++) if (A[i + j] !== Q[j]) continue outer; out.push(i); i += Q.length - 1; }
    return out;
  }

  /* ---------- gom chỗ trùng trên mọi trang ---------- */
  async function search(q) {
    const my = ++tok; hits = []; cur = -1;
    if (!q.trim() || !S.pages.length) { draw(); count(); return; }
    setCount('Đang tìm…');
    for (let pi = 0; pi < S.pages.length; pi++) {
      const pg = S.pages[pi], v = S.views.get(pg.id); if (!v) continue;
      // 1) chữ gốc PDF (mỗi mảnh có hệ trục riêng: gốc đầu chân chữ, hướng viết)
      if (pg.src) {
        try {
          const T = await pageTextItems(v); if (my !== tok) return;
          for (const a of T.items) {
            const s = a.it.str || '', n = [...s].length; if (!n) continue;
            const fam = ((v.tc && v.tc.styles[a.it.fontName]) || {}).fontFamily || 'sans-serif', chars = [...s], qn = [...q].length;
            for (const i of findAll(s, q)) {
              // vị trí theo bề rộng chữ thật (đo bằng phông cùng kiểu) thay vì chia đều theo số ký tự
              const W = mw(chars.join(''), fam) || 1, k = a.w / W;
              hits.push({ pi, kind: 'pdf', ox: a.ox, oy: a.oy, ang: a.ang, fh: a.fh, x0: mw(chars.slice(0, i).join(''), fam) * k, x1: mw(chars.slice(0, i + qn).join(''), fam) * k });
            }
          }
        } catch (e) { console.warn('find', e); }
      }
      // 2) dòng chữ OCR chưa sửa (trang scan)
      for (const l of pg.ocr || []) {
        if (l.done || !l.text) continue;
        const n = [...l.text].length, qn = [...q].length;
        for (const i of findAll(l.text, q)) hits.push({ pi, kind: 'box', x: l.x0 + (l.x1 - l.x0) * i / n, y: l.y0, w: (l.x1 - l.x0) * qn / n, h: l.y1 - l.y0 });
      }
      // 3) chữ đã thêm / đã sửa (đối tượng)
      for (const o of pg.objs || []) {
        if (typeof o.text !== 'string' || !o.text) continue;
        if (!findAll(o.text, q).length) continue;
        const sx = o.scaleX || 1, sy = o.scaleY || 1, w = (o.width || 0) * sx, h = (o.height || 0) * sy;
        const x = o.originX === 'center' ? o.left - w / 2 : o.originX === 'right' ? o.left - w : o.left;
        const y = o.originY === 'center' ? o.top - h / 2 : o.originY === 'bottom' ? o.top - h : o.top;
        hits.push({ pi, kind: 'box', x, y, w, h, ang: o.angle || 0, ox: o.left, oy: o.top, obj: true, n: findAll(o.text, q).length });
      }
      if (pi % 5 === 4) await new Promise(r => setTimeout(r, 0));
    }
    if (my !== tok) return;
    // thứ tự đọc: trang → trên xuống → trái sang
    const key = h => [h.pi, h.kind === 'pdf' ? h.oy - h.fh : h.y, h.kind === 'pdf' ? h.ox + h.x0 : h.x];
    hits.sort((a, b) => { const A = key(a), B = key(b); return A[0] - B[0] || (Math.abs(A[1] - B[1]) > 3 ? A[1] - B[1] : A[2] - B[2]); });
    // bắt đầu từ chỗ gần trang đang xem
    cur = hits.length ? Math.max(0, hits.findIndex(h => h.pi >= S.cur)) : -1;
    draw(); count(); if (cur >= 0) show(cur);
  }
  const mctx = document.createElement('canvas').getContext('2d');
  const mw = (t, fam) => { mctx.font = `100px ${fam}`; return mctx.measureText(t).width; };
  const total = () => hits.reduce((a, h) => a + (h.n || 1), 0);

  /* ---------- vẽ ô tô sáng trên từng trang ---------- */
  function draw() {
    document.querySelectorAll('.find-layer').forEach(e => e.remove());
    if (!hits.length) return;
    const z = S.zoom, by = new Map();
    hits.forEach((h, i) => { if (!by.has(h.pi)) by.set(h.pi, []); by.get(h.pi).push([h, i]); });
    for (const [pi, list] of by) {
      const pg = S.pages[pi], v = pg && S.views.get(pg.id); if (!v) continue;
      const layer = document.createElement('div'); layer.className = 'find-layer';
      for (const [h, i] of list) {
        const d = document.createElement('i'); d.className = 'find-hit' + (i === cur ? ' cur' : ''); d.dataset.i = i;
        if (h.kind === 'pdf') {
          Object.assign(d.style, { left: h.ox * z + 'px', top: h.oy * z + 'px', width: Math.max(2, (h.x1 - h.x0) * z) + 'px', height: h.fh * 1.2 * z + 'px',
            transform: `rotate(${h.ang}rad) translate(${h.x0 * z}px, ${-h.fh * 0.95 * z}px)` });
        } else {
          Object.assign(d.style, { left: h.x * z + 'px', top: h.y * z + 'px', width: Math.max(2, h.w * z) + 'px', height: Math.max(2, h.h * z) + 'px' });
          if (h.ang) Object.assign(d.style, { transformOrigin: `${(h.ox - h.x) * z}px ${(h.oy - h.y) * z}px`, transform: `rotate(${h.ang}deg)` });
        }
        layer.appendChild(d);
      }
      v.el.appendChild(layer);
    }
  }
  function show(i) {
    if (!hits.length) return;
    cur = (i + hits.length) % hits.length;
    document.querySelectorAll('.find-hit.cur').forEach(e => e.classList.remove('cur'));
    const el = document.querySelector(`.find-hit[data-i="${cur}"]`);
    if (el) {
      el.classList.add('cur');
      const viewer = $('#viewer'), r = el.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
      if (r.top < vr.top + 60 || r.bottom > vr.bottom - 40) viewer.scrollTop += r.top - vr.top - vr.height * 0.35;
      if (r.left < vr.left + 20 || r.right > vr.right - 20) viewer.scrollLeft += r.left - vr.left - vr.width * 0.4;
    } else { scrollToPage(hits[cur].pi); setTimeout(() => show(cur), 120); }
    count();
  }
  function setCount(t) { if (bar) bar.querySelector('[data-c]').textContent = t; }
  function count() {
    if (!bar) return;
    const q = bar.querySelector('input').value;
    bar.classList.toggle('none', !!q.trim() && !hits.length);
    setCount(!q.trim() ? '' : hits.length ? `${cur + 1} / ${hits.length}` + (total() > hits.length ? ` (${total()} chỗ)` : '') : 'Không thấy');
  }

  /* ---------- thanh tìm ---------- */
  function open() {
    if (!bar) {
      bar = document.createElement('div'); bar.className = 'find-bar';
      bar.innerHTML = `<span class="ti ti-search"></span><input type="text" placeholder="Tìm trong file…" spellcheck="false">
        <span class="fc" data-c></span>
        <button data-k="cs" title="Phân biệt chữ hoa / thường">Aa</button>
        <button data-k="nd" title="Bỏ qua dấu tiếng Việt: gõ &quot;hop dong&quot; vẫn ra &quot;hợp đồng&quot;">a≈á</button>
        <span class="fsep"></span>
        <button data-k="prev" title="Chỗ trước (Shift+Enter)"><span class="ti ti-chevron-up"></span></button>
        <button data-k="next" title="Chỗ sau (Enter / F3)"><span class="ti ti-chevron-down"></span></button>
        <button data-k="rep" title="Thay thế chữ này hàng loạt (giữ phông / cỡ / màu)">Thay…</button>
        <button data-k="x" title="Đóng (Esc)"><span class="ti ti-x"></span></button>`;
      document.body.appendChild(bar);
      const inp = bar.querySelector('input');
      let t; inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => search(inp.value), 220); });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); if (hits.length) show(cur + (e.shiftKey ? -1 : 1)); else search(inp.value); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      bar.querySelectorAll('[data-k]').forEach(b => (b.onclick = () => {
        const k = b.dataset.k;
        if (k === 'cs' || k === 'nd') { opt[k] = !opt[k]; saveOpt(); sync(); search(inp.value); inp.focus(); }
        else if (k === 'prev') show(cur - 1); else if (k === 'next') show(cur + 1);
        else if (k === 'x') close();
        else if (k === 'rep' && window.PdfTools) { const q = inp.value; PdfTools.findReplace(); setTimeout(() => { const f = document.querySelector('.tool-modal [data-q]'); if (f) { f.value = q; f.select(); } }, 80); }
      }));
      sync();
    }
    place(); bar.hidden = false;
    const inp = bar.querySelector('input'), sel = String(window.getSelection() || '').trim();
    if (sel && sel.length < 80 && !sel.includes('\n')) inp.value = sel;
    inp.focus(); inp.select();
    if (inp.value.trim()) search(inp.value);
  }
  function sync() { bar.querySelector('[data-k=cs]').classList.toggle('on', opt.cs); bar.querySelector('[data-k=nd]').classList.toggle('on', opt.nd); }
  function place() { if (!bar) return; const r = $('#viewer').getBoundingClientRect(); Object.assign(bar.style, { top: r.top + 8 + 'px', right: Math.max(8, innerWidth - r.right + 18) + 'px' }); }
  function close() { if (!bar) return; bar.hidden = true; tok++; hits = []; cur = -1; draw(); }
  const isOpen = () => !!bar && !bar.hidden;
  // trang được dựng lại (phóng to, đổi trang…) → vẽ lại ô tô sáng; nội dung đổi → tìm lại
  function redraw() { if (isOpen() && hits.length) { draw(); count(); } }
  function refresh() { if (isOpen()) search(bar.querySelector('input').value); }
  window.addEventListener('resize', () => { place(); });
  return { open, close, isOpen, redraw, refresh, next: () => isOpen() && show(cur + 1), prev: () => isOpen() && show(cur - 1) };
})();
window.PdfFind = PdfFind;
