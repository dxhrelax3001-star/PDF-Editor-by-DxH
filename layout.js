/* PDF Editor — bố cục:
   18. Kéo mép để đổi độ rộng cột Trang / ảnh thu nhỏ / Thuộc tính; nút ẩn / hiện từng cột; nhớ cách xếp cho lần sau (trên máy này)
   19. Xem 1 trang (cuộn dọc) hoặc 2 trang cạnh nhau */
const PdfLayout = (() => {
  const KEY = 'pdfedit.layout'; // khoá theo quy ước pdfedit.* (các ứng dụng dùng chung tên miền dxh3001)
  const COLS = {
    side: { sel: '#side', min: 150, max: 380, def: 200, grip: 'after', label: 'cột nút Trang', icon: 'layout-sidebar' },
    thumb: { sel: '#thumbcol', min: 110, max: 320, def: 156, grip: 'after', label: 'cột ảnh thu nhỏ', icon: 'layout-list' },
    props: { sel: '#props', min: 190, max: 420, def: 230, grip: 'before', label: 'cột Thuộc tính', icon: 'layout-sidebar-right' },
  };
  let P = {};
  try { P = JSON.parse(localStorage.getItem(KEY) || localStorage.getItem('pdfLayoutV1') || '{}') || {}; localStorage.removeItem('pdfLayoutV1'); } catch (e) { P = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) {} };
  let rt;
  const changed = () => { window.dispatchEvent(new Event('resize')); clearTimeout(rt); rt = setTimeout(() => { if (typeof placeSelBox === 'function') placeSelBox(); }, 50); };

  function apply() {
    for (const [k, c] of Object.entries(COLS)) {
      const el = $(c.sel); if (!el) continue;
      const w = Math.max(c.min, Math.min(c.max, P[k + 'W'] || c.def));
      el.style.width = w + 'px'; el.style.flex = 'none';
      const hide = !!P[k + 'Hide'];
      el.style.display = hide ? 'none' : '';
      const g = document.querySelector(`.col-grip[data-k="${k}"]`); if (g) g.style.display = hide ? 'none' : '';
      const b = document.querySelector(`.lay-btn[data-k="${k}"]`); if (b) { b.classList.toggle('on', !hide); b.title = (hide ? 'Hiện ' : 'Ẩn ') + c.label; }
    }
    const tb = document.querySelector('.lay-btn[data-k="two"]');
    if (tb) { tb.classList.toggle('on', !!S.twoUp); tb.title = S.twoUp ? 'Đang xem 2 trang cạnh nhau — bấm để xem 1 trang' : 'Xem 2 trang cạnh nhau'; }
  }
  // tay nắm kéo đổi độ rộng
  function addGrips() {
    for (const [k, c] of Object.entries(COLS)) {
      const el = $(c.sel); if (!el || document.querySelector(`.col-grip[data-k="${k}"]`)) continue;
      const g = document.createElement('div'); g.className = 'col-grip'; g.dataset.k = k; g.title = `Kéo để đổi độ rộng ${c.label} · bấm đúp để ẩn`;
      if (c.grip === 'after') el.after(g); else el.before(g);
      g.addEventListener('pointerdown', e => {
        e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('drag'); document.body.classList.add('col-resizing');
        const sx = e.clientX, w0 = el.getBoundingClientRect().width, dir = c.grip === 'after' ? 1 : -1;
        const move = ev => { P[k + 'W'] = Math.round(Math.max(c.min, Math.min(c.max, w0 + dir * (ev.clientX - sx)))); el.style.width = P[k + 'W'] + 'px'; changed(); };
        const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up); g.classList.remove('drag'); document.body.classList.remove('col-resizing'); save(); changed(); };
        g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
      });
      g.addEventListener('dblclick', () => toggle(k));
    }
  }
  function toggle(k) { P[k + 'Hide'] = !P[k + 'Hide']; save(); apply(); changed(); }
  function setTwoUp(on) {
    S.twoUp = !!on; P.two = S.twoUp; save(); apply();
    if (!S.pages.length) return;
    const cur = S.cur; S.zoom = fitZoom(); S.fit = true; rebuild(); updateUI();
    setTimeout(() => scrollToPage(cur), 50);
  }
  // nút trên thanh công cụ (cạnh phóng to / thu nhỏ)
  function addButtons() {
    const zoom = $('.zoom'); if (!zoom || $('.lay-bar')) return;
    const bar = document.createElement('div'); bar.className = 'lay-bar';
    bar.innerHTML = `<button class="lay-btn" data-k="two"><span class="ti ti-columns-2"></span></button><span class="lay-sep"></span>` +
      Object.entries(COLS).map(([k, c]) => `<button class="lay-btn" data-k="${k}"><span class="ti ti-${c.icon}"></span></button>`).join('') +
      `<button class="lay-btn" data-k="reset" title="Trả bố cục về mặc định"><span class="ti ti-restore"></span></button>`;
    zoom.before(bar);
    bar.querySelectorAll('.lay-btn').forEach(b => (b.onclick = () => {
      const k = b.dataset.k;
      if (k === 'two') return setTwoUp(!S.twoUp);
      if (k === 'reset') { const two = S.twoUp; P = {}; save(); apply(); changed(); if (two) setTwoUp(false); toast('Đã trả bố cục về mặc định'); return; }
      toggle(k);
    }));
  }
  // vùng xem trang đổi rộng (ẩn / kéo cột, đổi cỡ cửa sổ): đang ở mức "vừa khung" thì tự vừa lại
  // cột ảnh thu nhỏ đổi rộng: vẽ lại ảnh thu nhỏ theo cỡ mới
  function watch() {
    if (!window.ResizeObserver) return;
    let lastV = 0, tv, lastT = 0, tt;
    new ResizeObserver(es => {
      const w = Math.round(es[0].contentRect.width); if (!w || Math.abs(w - lastV) < 8) return; lastV = w;
      // (bỏ qua thay đổi do chính lần vừa khung trước gây ra, vd thanh cuộn hiện / ẩn — tránh lặp đi lặp lại)
      clearTimeout(tv); tv = setTimeout(() => { if (S.fit && S.pages.length && typeof fitNow === 'function' && Date.now() - (S.fitAt || 0) > 700) { S.fitAt = Date.now(); fitNow(); } }, 180);
    }).observe($('#viewer'));
    const tc = $('#thumbcol');
    if (tc) new ResizeObserver(es => {
      const w = Math.round(es[0].contentRect.width); if (!w || Math.abs(w - lastT) < 6) return; const first = !lastT; lastT = w;
      if (first) return; clearTimeout(tt); tt = setTimeout(() => { if (S.pages.length) buildThumbs(); }, 200);
    }).observe(tc);
  }
  function init() {
    S.twoUp = !!P.two;
    addGrips(); addButtons(); apply(); watch();
    if (S.twoUp && S.pages.length) { S.zoom = fitZoom(); S.fit = true; rebuild(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  return { setTwoUp, toggle, apply };
})();
window.PdfLayout = PdfLayout;
