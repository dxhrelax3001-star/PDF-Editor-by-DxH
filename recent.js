/* PDF Editor — 13. Mở lại file gần đây · 14. Tự lưu bản nháp
   - File gần đây: nhớ "tay cầm" file (File System Access API) trong IndexedDB của trình duyệt → bấm là mở lại đúng file trên máy / ổ mạng
     (trình duyệt hỏi cho phép đọc lại file lần đầu mỗi phiên). Chỉ lưu trên máy này, không gửi đi đâu.
   - Bản nháp: vài giây sau mỗi thay đổi, lưu các tài liệu đang sửa dở (chưa lưu) vào IndexedDB; mất điện / lỡ đóng tab thì mở lại web sẽ hỏi khôi phục.
   Dùng chung hàm của app.js (S, openFiles, filesToPages, rebuild, resetHistory…). */
const PdfRecent = (() => {
  const MAX = 10;
  /* ---------- IndexedDB ---------- */
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((ok, no) => {
    const r = indexedDB.open('pdf-editor', 1);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['recent', 'drafts', 'srcs']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  }));
  const tx = async (store, mode, fn) => { const d = await db(); return new Promise((ok, no) => { const t = d.transaction(store, mode), s = t.objectStore(store); let res; Promise.resolve(fn(s)).then(v => { res = v; }); t.oncomplete = () => ok(res); t.onerror = () => no(t.error); t.onabort = () => no(t.error); }); };
  const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const get = (store, key) => tx(store, 'readonly', s => req(s.get(key)));
  const put = (store, key, val) => tx(store, 'readwrite', s => { s.put(val, key); });
  const del = (store, key) => tx(store, 'readwrite', s => { s.delete(key); });
  const all = store => tx(store, 'readonly', async s => { const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]); return keys.map((k, i) => ({ key: k, val: vals[i] })); });

  /* ---------- 13. file gần đây ---------- */
  const canPick = () => !!window.showOpenFilePicker;
  async function list() { try { return ((await get('recent', 'list')) || []); } catch (e) { return []; } }
  async function add(handles) {
    handles = (handles || []).filter(h => h && h.kind === 'file'); if (!handles.length) return;
    try {
      let L0 = await list();
      for (const h of handles) {
        const keep = [];
        for (const e of L0) { let same = false; try { same = await e.handle.isSameEntry(h); } catch (x) {} if (!same) keep.push(e); }
        L0 = [{ name: h.name, handle: h, time: Date.now() }, ...keep];
      }
      await put('recent', 'list', L0.slice(0, MAX)); renderEmpty();
    } catch (e) { console.warn('recent.add', e); }
  }
  async function remove(i) { const L0 = await list(); L0.splice(i, 1); await put('recent', 'list', L0); renderEmpty(); }
  // nút Mở / Ctrl+O: hộp chọn file có "tay cầm" (để mở lại được), không có thì dùng ô chọn file thường
  async function open() {
    if (!canPick()) return $('#fileOpen').click();
    let hs;
    try { hs = await showOpenFilePicker({ multiple: true, types: [{ description: 'PDF hoặc ảnh', accept: { 'application/pdf': ['.pdf'], 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] } }] }); }
    catch (e) { if (e.name !== 'AbortError') { console.warn(e); $('#fileOpen').click(); } return; }
    const files = await Promise.all(hs.map(h => h.getFile()));
    await openFiles(files, true); add(hs);
  }
  async function openRecent(i) {
    const L0 = await list(), e = L0[i]; if (!e) return;
    try {
      let p = await e.handle.queryPermission({ mode: 'read' });
      if (p !== 'granted') p = await e.handle.requestPermission({ mode: 'read' });
      if (p !== 'granted') return toast('Chưa được phép đọc lại file này');
      const f = await e.handle.getFile();
      await openFiles([f], true); add([e.handle]);
    } catch (err) {
      console.warn(err);
      if (confirm(`Không mở được "${e.name}" (file đã bị xoá, đổi tên hoặc chuyển chỗ?).\n\nBỏ khỏi danh sách file gần đây?`)) remove(i);
    }
  }
  const ago = t => {
    const d = new Date(t), now = new Date(), hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'hôm nay ' + hm;
    const y = new Date(now); y.setDate(now.getDate() - 1); if (d.toDateString() === y.toDateString()) return 'hôm qua ' + hm;
    return d.toLocaleDateString('vi-VN') + ' ' + hm;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function listHtml(L0) {
    return L0.map((e, i) => `<div class="rc-item" data-i="${i}" title="Mở lại ${esc(e.name)}"><span class="ti ti-file-type-pdf"></span><span class="rc-nm">${esc(e.name)}</span><span class="rc-t">${ago(e.time)}</span><button class="rc-x" data-x="${i}" title="Bỏ khỏi danh sách">×</button></div>`).join('');
  }
  function hookList(box) {
    box.onclick = e => { const x = e.target.closest('[data-x]'); if (x) { e.stopPropagation(); remove(+x.dataset.x); return; } const it = e.target.closest('.rc-item'); if (it) { closeMenu(); openRecent(+it.dataset.i); } };
  }
  // danh sách trên màn hình trống
  async function renderEmpty() {
    const host = $('#recentBox'); if (!host) return;
    const L0 = canPick() ? await list() : [];
    host.hidden = !L0.length; if (!L0.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<h4>File gần đây</h4><div class="rc-list">${listHtml(L0)}</div>`;
    hookList(host.querySelector('.rc-list'));
  }
  // menu thả xuống ở nút "Gần đây" trên thanh trên cùng
  let menu = null;
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  async function toggleMenu(btn) {
    if (menu) return closeMenu();
    const L0 = await list();
    menu = document.createElement('div'); menu.className = 'rc-menu';
    menu.innerHTML = L0.length ? `<div class="rc-list">${listHtml(L0)}</div><div class="rc-foot"><button class="ghost" data-clear>Xoá danh sách</button></div>`
      : `<p class="muted" style="margin:8px 10px">${canPick() ? 'Chưa có file nào. Mở file bằng nút "Mở" là file được nhớ ở đây.' : 'Trình duyệt này không hỗ trợ mở lại file — hãy dùng Chrome hoặc Edge.'}</p>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect(); Object.assign(menu.style, { top: r.bottom + 4 + 'px', left: Math.max(8, Math.min(innerWidth - 360, r.left)) + 'px' });
    const lst = menu.querySelector('.rc-list'); if (lst) hookList(lst);
    const c = menu.querySelector('[data-clear]'); if (c) c.onclick = async () => { await put('recent', 'list', []); closeMenu(); renderEmpty(); };
    setTimeout(() => document.addEventListener('mousedown', function h(e) { if (menu && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', h); } }), 0);
  }
  // kéo thả file vào cửa sổ: cũng nhớ vào danh sách (lấy tay cầm ngay trong sự kiện drop)
  window.addEventListener('drop', e => {
    const items = [...(e.dataTransfer && e.dataTransfer.items || [])].filter(it => it.kind === 'file' && it.getAsFileSystemHandle);
    if (!items.length) return;
    Promise.all(items.map(it => it.getAsFileSystemHandle().catch(() => null))).then(hs => add(hs.filter(h => h && /\.(pdf|png|jpe?g|webp|gif|bmp)$/i.test(h.name))));
  }, true);

  /* ---------- 14. bản nháp tự lưu ---------- */
  let winId = null; try { winId = sessionStorage.getItem('pdfWin'); if (!winId) { winId = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); sessionStorage.setItem('pdfWin', winId); } } catch (e) { winId = 'w' + Date.now().toString(36); }
  let armed = false, wrote = false, timer = null, lastKey = '';
  const savedSrc = new Set();
  // tài liệu đang sửa dở: tab hiện tại lấy từ S, các tab khác từ S.docs
  function dirtyDocs() {
    const out = [];
    S.docs.forEach((d, i) => {
      const cur = i === S.docIdx, pages = cur ? S.pages : d.pages, dirty = cur ? S.dirty : d.dirty;
      if (dirty && pages && pages.length) out.push({ fileName: cur ? S.fileName : d.fileName, pages, zoom: cur ? S.zoom : d.zoom, cur: cur ? S.cur : d.cur });
    });
    return out;
  }
  function touch() { if (!armed) return; clearTimeout(timer); timer = setTimeout(saveDraft, 2500); }
  async function saveDraft() {
    try {
      const docs = dirtyDocs();
      if (!docs.length) { if (wrote) { await del('drafts', winId); wrote = false; lastKey = ''; await gcSrcs(); } return; }
      const pagesJson = docs.map(d => JSON.stringify(d.pages));
      const key = pagesJson.join('|') + docs.map(d => d.fileName).join('|');
      if (key === lastKey) return;
      const srcIds = [...new Set(docs.flatMap(d => d.pages.map(p => p.src).filter(Boolean)))];
      for (const id of srcIds) if (!savedSrc.has(id) && S.sources[id]) { await put('srcs', id, { bytes: S.sources[id].bytes, name: S.sources[id].name }); savedSrc.add(id); }
      const imgIds = new Set(docs.flatMap(d => d.pages.flatMap(p => (p.imgEdits || []).map(e => e.id))));
      const imgs = {}; for (const id of imgIds) { const u = S.imgStore.get(id); if (u) imgs[id] = u; }
      await put('drafts', winId, { time: Date.now(), docs: docs.map((d, i) => ({ fileName: d.fileName, pages: pagesJson[i], zoom: d.zoom, cur: d.cur })), srcIds, imgs });
      wrote = true; lastKey = key;
    } catch (e) { console.warn('saveDraft', e); }
  }
  // xoá dữ liệu file nguồn không còn bản nháp nào dùng
  async function gcSrcs() {
    try {
      const used = new Set((await all('drafts')).flatMap(d => d.val.srcIds || []));
      for (const { key } of await all('srcs')) if (!used.has(key)) { await del('srcs', key); savedSrc.delete(key); }
    } catch (e) { console.warn(e); }
  }
  async function restore(drafts) {
    busy(true, 'Đang khôi phục bản nháp…');
    try {
      for (const { val: d } of drafts) {
        for (const id of d.srcIds || []) {
          if (S.sources[id]) continue;
          const s = await get('srcs', id); if (!s) continue;
          const js = await pdfjsLib.getDocument({ data: s.bytes.slice() }).promise.catch(async e => {
            if (e && e.name === 'PasswordException') { const pw = prompt(`"${s.name}" có mật khẩu. Nhập mật khẩu để khôi phục:`); if (pw == null) throw e; return pdfjsLib.getDocument({ data: s.bytes.slice(), password: pw }).promise; }
            throw e;
          });
          S.sources[id] = { bytes: s.bytes, js, lib: null, name: s.name };
        }
        for (const [id, u] of Object.entries(d.imgs || {})) S.imgStore.set(id, u);
        for (const doc of d.docs) {
          const pages = JSON.parse(doc.pages).filter(p => !p.src || S.sources[p.src]);
          if (!pages.length) continue;
          if (S.pages.length) addDocTab();
          S.pages = pages; S.handle = null; S.sel = new Set(); S.cur = Math.min(doc.cur || 0, pages.length - 1);
          S.fileName = doc.fileName; S.zoom = doc.zoom || fitZoom(); S.outline = null;
          rebuild(); resetHistory(); S.dirty = true; updateUI();
        }
      }
      for (const { key } of drafts) if (key !== winId) await del('drafts', key);
      toast('Đã khôi phục — nhớ bấm Lưu để lưu lại thành file', 4500);
    } catch (e) { console.error(e); alert('Không khôi phục được bản nháp: ' + (e.message || e)); }
    finally { busy(false); }
  }
  async function checkDrafts() {
    let drafts = [];
    try { drafts = (await all('drafts')).filter(d => d.val && d.val.docs && d.val.docs.length).sort((a, b) => b.val.time - a.val.time); } catch (e) { console.warn(e); }
    if (!drafts.length) { armed = true; return; }
    const names = drafts.flatMap(d => d.val.docs.map(x => x.fileName)), when = new Date(drafts[0].val.time).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    const bar = document.createElement('div'); bar.className = 'draft-bar';
    bar.innerHTML = `<span class="ti ti-history"></span><span>Có bản đang sửa dở chưa lưu (lúc ${when}): <b></b></span><span class="spacer"></span><button class="primary" data-r>Khôi phục</button><button class="ghost" data-d>Bỏ</button>`;
    bar.querySelector('b').textContent = names.slice(0, 3).join(', ') + (names.length > 3 ? ` và ${names.length - 3} file khác` : '');
    document.body.appendChild(bar);
    const done = () => { bar.remove(); armed = true; touch(); };
    bar.querySelector('[data-r]').onclick = async () => { bar.remove(); await restore(drafts); armed = true; touch(); };
    bar.querySelector('[data-d]').onclick = async () => { if (!confirm('Bỏ hẳn bản đang sửa dở? Không lấy lại được.')) return; for (const { key } of drafts) await del('drafts', key); await gcSrcs(); done(); };
  }

  /* ---------- gắn vào giao diện ---------- */
  function init() {
    const bo = $('#btnOpen');
    if (bo && !$('#btnRecent')) {
      const b = document.createElement('button'); b.id = 'btnRecent'; b.className = 'ghost'; b.title = 'Mở lại file gần đây';
      b.innerHTML = '<i class="ico k-amber"><span class="ti ti-history"></span></i>Gần đây';
      b.onclick = () => toggleMenu(b);
      bo.after(b);
    }
    renderEmpty();
    checkDrafts();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  return { open, add, list, openRecent, touch, saveDraft, restore };
})();
window.PdfRecent = PdfRecent;
