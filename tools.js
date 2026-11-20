/* PDF Editor — 12 công cụ thêm ở cột "Trang":
   Trang   : Đánh số trang · Tách file · Cắt lề / đổi cỡ trang · Chèn trang từ file
   Nội dung: Thêm hình mờ · Đầu / chân trang · Tìm & thay thế · Che thông tin
   File    : Nén file · Đặt mật khẩu · Mục lục (bookmark) · Xuất Word / Excel
   Dùng chung hàm của app.js (S, buildPdf, rebuild, commit…). Mọi xử lý chạy trên trình duyệt. */
const PdfTools = (() => {
  const N = n => L.PDFName.of(n);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const needDoc = () => { if (!S.pages.length) { toast('Hãy mở file PDF trước'); return false; } return true; };
  const loadScript = (src, test) => test() ? Promise.resolve() : new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('Không tải được thư viện (cần Internet)')); document.head.appendChild(s); });
  const zipLib = () => loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', () => !!window.JSZip).then(() => window.JSZip);
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';

  /* ---------- hộp thoại chung ---------- */
  function dialog(title, html, okLabel, onOk, width = 460) {
    const m = document.createElement('div'); m.className = 'modal tool-modal';
    m.innerHTML = `<div class="card" style="width:min(${width}px,94vw)"><h3>${title}</h3><div class="tool-body">${html}</div>
      <div class="row" style="margin-top:14px"><span class="spacer"></span><button class="ghost" data-x>Đóng</button>${okLabel ? `<button class="primary" data-ok>${okLabel}</button>` : ''}</div></div>`;
    document.body.appendChild(m);
    const close = () => m.remove();
    m.querySelector('[data-x]').onclick = close;
    m.addEventListener('mousedown', e => { if (e.target === m) close(); });
    const ok = m.querySelector('[data-ok]');
    if (ok) ok.onclick = async () => { ok.disabled = true; try { if ((await onOk(m)) !== false) close(); } catch (e) { console.error(e); alert('Lỗi: ' + (e.message || e)); } finally { ok.disabled = false; } };
    return m;
  }
  const val = (m, sel) => { const e = m.querySelector(sel); return e.type === 'checkbox' ? e.checked : e.value; };
  const scopeHtml = () => `<div class="tf"><label>Áp dụng cho</label><select data-scope><option value="all">Tất cả ${S.pages.length} trang</option><option value="sel">Trang đang chọn (${targetPages().length})</option><option value="range">Các trang…</option></select><input data-range placeholder="vd 2-5, 8" style="display:none;width:110px"></div>`;
  const hookScope = m => { const s = m.querySelector('[data-scope]'), r = m.querySelector('[data-range]'); s.onchange = () => { r.style.display = s.value === 'range' ? '' : 'none'; }; };
  const scopePages = m => {
    const s = val(m, '[data-scope]');
    if (s === 'sel') return targetPages();
    if (s === 'range') { const idx = parseRanges(val(m, '[data-range]'), S.pages.length); if (!idx || !idx.length) { alert('Khoảng trang không hợp lệ'); return null; } return idx.map(i => S.pages[i]); }
    return S.pages.slice();
  };
  const fontOptions = def => (FONTS.fams.length ? FONTS.fams : ['Arial', 'Times New Roman', 'Courier New']).map(f => `<option${f === def ? ' selected' : ''}>${esc(f)}</option>`).join('');

  /* ---------- đóng chữ / ảnh lên nhiều trang (đánh số, đầu-chân trang, hình mờ) ---------- */
  // mỗi lần áp dụng thay hết các đối tượng cũ cùng "tag" để chạy lại không bị chồng
  async function stamp(tag, pages, make) {
    const total = S.pages.length;
    for (const pg of S.pages) {
      pg.objs = (pg.objs || []).filter(o => o.tag !== tag);
      if (!pages.includes(pg)) continue;
      const objs = await make(pg, S.pages.indexOf(pg), total);
      for (const o of objs || []) { o.tag = tag; pg.objs.push(o); }
    }
    rebuild(); commit();
  }
  function textObj(text, x, y, opt) {
    const t = new fabric.IText(text, { left: x, top: y, originX: opt.ox || 'left', originY: opt.oy || 'top', fontFamily: opt.font || 'Arial', fontSize: +opt.size || 10,
      fill: opt.color || '#000000', fontWeight: opt.bold ? 'bold' : 'normal', opacity: opt.opacity ?? 1, angle: opt.angle || 0, kind: 'text' });
    if (opt.under) t.under = true;
    return t.toObject(PROPS);
  }
  const POS = { tl: ['left', 'top'], tc: ['center', 'top'], tr: ['right', 'top'], bl: ['left', 'bottom'], bc: ['center', 'bottom'], br: ['right', 'bottom'] };
  function slotXY(pg, slot, size, margin) {
    const [W, H] = dispSize(pg), [h, v] = POS[slot];
    return { x: h === 'left' ? margin : h === 'center' ? W / 2 : W - margin, y: v === 'top' ? margin : H - margin - size * 1.2, ox: h };
  }
  const fill = (s, n, N, pgName) => s.replace(/\{n\}/g, n).replace(/\{N\}/g, N).replace(/\{date\}/g, new Date().toLocaleDateString('vi-VN')).replace(/\{file\}/g, pgName);

  // 1. Đánh số trang
  function pageNumbers() {
    if (!needDoc()) return;
    dialog('📑 Số trang', `
      <div class="tf"><label>Vị trí</label><select data-pos><option value="bc">Dưới — giữa</option><option value="br">Dưới — phải</option><option value="bl">Dưới — trái</option><option value="tc">Trên — giữa</option><option value="tr">Trên — phải</option><option value="tl">Trên — trái</option></select></div>
      <div class="tf"><label>Kiểu</label><select data-fmt><option value="Trang {n}/{N}">Trang 1/22</option><option value="{n}">1</option><option value="- {n} -">- 1 -</option><option value="Trang {n}">Trang 1</option><option value="Page {n} of {N}">Page 1 of 22</option></select></div>
      <div class="tf"><label>Bắt đầu từ số</label><input data-start type="number" value="1" style="width:70px"><label class="chk"><input data-skip type="checkbox"> Bỏ trang đầu (bìa)</label></div>
      <div class="tf"><label>Phông / cỡ</label><select data-font>${fontOptions('Arial')}</select><input data-size type="number" value="10" min="5" max="40" style="width:60px"><input data-color type="color" value="#333333"></div>
      ${scopeHtml()}
      <p class="muted">Số trang là chữ thêm vào (sửa / xoá được). Chạy lại sẽ thay số cũ.</p>`, 'Đánh số', async m => {
      const pages = scopePages(m); if (!pages) return false;
      const pos = val(m, '[data-pos]'), fmt = val(m, '[data-fmt]'), start = +val(m, '[data-start]') || 1, skip = val(m, '[data-skip]');
      const opt = { font: val(m, '[data-font]'), size: +val(m, '[data-size]') || 10, color: val(m, '[data-color]') };
      await ensureFaceLoaded(opt.font);
      const list = skip ? pages.filter(p => p !== S.pages[0]) : pages, total = list.length + start - 1;
      await stamp('pagenum', list, pg => { const k = list.indexOf(pg), { x, y, ox } = slotXY(pg, pos, opt.size, 24); return [textObj(fill(fmt, k + start, total, S.fileName), x, y, { ...opt, ox })]; });
      toast(`Đã đánh số ${list.length} trang`);
    });
  }

  // 6. Đầu trang / chân trang
  function headerFooter() {
    if (!needDoc()) return;
    const slot = (k, ph) => `<input data-s="${k}" placeholder="${ph}">`;
    dialog('☰ Đầu trang / chân trang', `
      <p class="muted">Gõ chữ vào ô nào thì chữ hiện ở vị trí đó trên mọi trang. Mã tự thay: <b>{n}</b> số trang, <b>{N}</b> tổng trang, <b>{date}</b> ngày, <b>{file}</b> tên file.</p>
      <div class="hf-grid"><b>Đầu trang</b>${slot('tl', 'Trái')}${slot('tc', 'Giữa')}${slot('tr', 'Phải')}
        <b>Chân trang</b>${slot('bl', 'Trái')}${slot('bc', 'Giữa')}${slot('br', 'Phải')}</div>
      <div class="tf"><label>Phông / cỡ</label><select data-font>${fontOptions('Arial')}</select><input data-size type="number" value="9" min="5" max="30" style="width:60px"><input data-color type="color" value="#555555"></div>
      <div class="tf"><label>Cách mép (pt)</label><input data-margin type="number" value="20" style="width:70px"></div>
      ${scopeHtml()}`, 'Áp dụng', async m => {
      const pages = scopePages(m); if (!pages) return false;
      const opt = { font: val(m, '[data-font]'), size: +val(m, '[data-size]') || 9, color: val(m, '[data-color]') }, margin = +val(m, '[data-margin]') || 20;
      const slots = Object.keys(POS).map(k => [k, m.querySelector(`[data-s="${k}"]`).value.trim()]).filter(x => x[1]);
      if (!slots.length) { alert('Chưa gõ nội dung'); return false; }
      await ensureFaceLoaded(opt.font);
      await stamp('hf', pages, (pg, i, total) => slots.map(([k, s]) => { const { x, y, ox } = slotXY(pg, k, opt.size, margin); return textObj(fill(s, i + 1, total, S.fileName.replace(/\.pdf$/i, '')), x, y, { ...opt, ox }); }));
      toast('Đã thêm đầu / chân trang');
    }, 520);
  }

  // 5. Thêm hình mờ (chữ hoặc ảnh / logo)
  function addWatermark() {
    if (!needDoc()) return;
    const m = dialog('💧 Đóng dấu', `
      <div class="tf"><label>Loại</label><label class="chk"><input type="radio" name="wk" value="text" checked> Chữ</label><label class="chk"><input type="radio" name="wk" value="img"> Ảnh / logo</label></div>
      <div data-k="text"><div class="tf"><label>Chữ</label><input data-text value="BẢN NHÁP" style="flex:1"></div>
        <div class="tf"><label>Phông / cỡ</label><select data-font>${fontOptions('Arial')}</select><input data-size type="number" value="72" style="width:60px"><input data-color type="color" value="#d93025"><label class="chk"><input data-bold type="checkbox" checked> Đậm</label></div></div>
      <div data-k="img" style="display:none"><div class="tf"><label>Ảnh</label><input data-file type="file" accept="image/*"></div><div class="tf"><label>Độ rộng (% trang)</label><input data-w type="number" value="50" style="width:70px"></div></div>
      <div class="tf"><label>Độ mờ</label><input data-op type="range" min="0.05" max="1" step="0.05" value="0.2"><span data-opv>20%</span></div>
      <div class="tf"><label>Góc xoay</label><select data-angle><option value="-45">Chéo ↗ (45°)</option><option value="0">Nằm ngang</option><option value="45">Chéo ↘</option><option value="-90">Dọc</option></select></div>
      <div class="tf"><label class="chk"><input data-under type="checkbox"> Nằm dưới nội dung (không che chữ)</label></div>
      ${scopeHtml()}`, 'Đóng dấu', async m => {
      const pages = scopePages(m); if (!pages) return false;
      const kind = m.querySelector('input[name=wk]:checked').value, op = +val(m, '[data-op]'), angle = +val(m, '[data-angle]'), under = val(m, '[data-under]');
      if (kind === 'text') {
        const opt = { font: val(m, '[data-font]'), size: +val(m, '[data-size]') || 72, color: val(m, '[data-color]'), bold: val(m, '[data-bold]'), opacity: op, angle, under, ox: 'center', oy: 'center' };
        await ensureFaceLoaded(opt.font);
        await stamp('wm', pages, pg => { const [W, H] = dispSize(pg); return [textObj(val(m, '[data-text]'), W / 2, H / 2, opt)]; });
      } else {
        const f = m.querySelector('[data-file]').files[0]; if (!f) { alert('Chọn ảnh trước'); return false; }
        const url = await readAsDataURL(f), img = await loadImg(url), wp = (+val(m, '[data-w]') || 50) / 100;
        await stamp('wm', pages, pg => { const [W, H] = dispSize(pg), s = W * wp / img.width;
          return [{ type: 'image', version: '5.3.0', originX: 'center', originY: 'center', left: W / 2, top: H / 2, width: img.width, height: img.height, scaleX: s, scaleY: s, angle, opacity: op, src: url, kind: 'image', under }]; });
      }
      toast(`Đã đóng hình mờ lên ${pages.length} trang — chạy lại để thay, chọn rồi Delete để xoá từng trang`, 3500);
    }, 500);
    m.querySelectorAll('input[name=wk]').forEach(r => r.onchange = () => m.querySelectorAll('[data-k]').forEach(d => { d.style.display = d.dataset.k === r.value ? '' : 'none'; }));
    m.querySelector('[data-op]').oninput = e => { m.querySelector('[data-opv]').textContent = Math.round(e.target.value * 100) + '%'; };
    hookScope(m);
  }

  // 2. Tách file
  function splitFile() {
    if (!needDoc()) return;
    const m = dialog('✂ Tách file', `
      <div class="tf"><label class="chk"><input type="radio" name="sp" value="each" checked> Mỗi trang 1 file (${S.pages.length} file)</label></div>
      <div class="tf"><label class="chk"><input type="radio" name="sp" value="n"> Mỗi file</label><input data-n type="number" value="2" min="1" style="width:60px"> trang</div>
      <div class="tf"><label class="chk"><input type="radio" name="sp" value="ranges"> Theo khoảng</label><input data-r placeholder="vd: 1-3; 4-10; 11" style="flex:1"></div>
      <p class="muted">Mỗi khoảng cách nhau bằng dấu chấm phẩy (;). Các file được nén chung thành 1 file .zip.</p>`, 'Tách & tải về', async m => {
      const mode = m.querySelector('input[name=sp]:checked').value, n = S.pages.length; let groups = [];
      if (mode === 'each') groups = S.pages.map((p, i) => [i]);
      else if (mode === 'n') { const k = Math.max(1, +val(m, '[data-n]') || 1); for (let i = 0; i < n; i += k) groups.push([...Array(Math.min(k, n - i)).keys()].map(j => i + j)); }
      else { groups = val(m, '[data-r]').split(';').map(s => parseRanges(s, n)).filter(g => g && g.length); if (!groups.length) { alert('Khoảng trang không hợp lệ'); return false; } }
      finishEditing(); busy(true, 'Đang tách…');
      try {
        const JSZip = await zipLib(), zip = new JSZip(), base = baseName();
        for (let k = 0; k < groups.length; k++) {
          $('#busyMsg').textContent = `Đang tạo file ${k + 1}/${groups.length}…`;
          zip.file(`${base}-${String(k + 1).padStart(2, '0')}-trang-${rangeText(groups[k]).replace(/[ ,]+/g, '_')}.pdf`, await buildPdf(groups[k].map(i => S.pages[i]), { final: true }));
        }
        downloadBlob(await zip.generateAsync({ type: 'blob' }), `${base}-tach.zip`);
        toast(`Đã tách thành ${groups.length} file (tải về dạng .zip)`, 3000);
      } finally { busy(false); }
    });
  }

  // 4. Chèn trang từ file khác (ngay sau trang đang xem)
  function insertFromFile() {
    if (!needDoc()) return;
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf,.pdf,image/*'; inp.multiple = true;
    inp.onchange = async () => {
      const files = [...inp.files]; if (!files.length) return;
      busy(true, 'Đang chèn…');
      try {
        const pages = await filesToPages(files); if (!pages.length) return;
        const at = S.cur + 1; S.pages.splice(at, 0, ...pages); rebuild(); commit(); scrollToPage(at);
        toast(`Đã chèn ${pages.length} trang sau trang ${at}`);
      } finally { busy(false); }
    };
    inp.click();
  }

  // 3. Cắt lề / đổi cỡ trang — "nướng" trang (gồm cả đối tượng đã thêm) thành trang PDF mới
  const SIZES = { A4: [595.28, 841.89], A3: [841.89, 1190.55], A5: [419.53, 595.28], Letter: [612, 792], Legal: [612, 1008] };
  function cropResize() {
    if (!needDoc()) return;
    const m = dialog('⛶ Cắt lề / đổi cỡ trang', `
      <div class="tf"><label class="chk"><input type="radio" name="cm" value="auto" checked> Tự cắt lề trắng, chừa lại</label><input data-am type="number" value="5" style="width:60px"> mm</div>
      <div class="tf"><label class="chk"><input type="radio" name="cm" value="manual"> Cắt lề (mm): trên</label><input data-t type="number" value="10" style="width:52px"> dưới <input data-b type="number" value="10" style="width:52px"> trái <input data-l type="number" value="10" style="width:52px"> phải <input data-r type="number" value="10" style="width:52px"></div>
      <div class="tf"><label class="chk"><input type="radio" name="cm" value="size"> Đổi cỡ trang</label><select data-size>${Object.keys(SIZES).map(k => `<option>${k}</option>`).join('')}</select><select data-ori><option value="auto">Theo trang gốc</option><option value="p">Dọc</option><option value="l">Ngang</option></select> lề <input data-sm type="number" value="0" style="width:52px"> mm</div>
      ${scopeHtml()}
      <p class="muted">Trang được dựng lại: chữ đã thêm trên trang trở thành nội dung PDF (vẫn sửa được bằng "Sửa nội dung"). Bấm Hoàn tác (Ctrl+Z) để trở lại.</p>`, 'Áp dụng', async m => {
      const pages = scopePages(m); if (!pages) return false;
      const mode = m.querySelector('input[name=cm]:checked').value, mm = x => (+x || 0) * 72 / 25.4;
      finishEditing(); busy(true, 'Đang dựng lại trang…');
      try {
        const src = await L.PDFDocument.load(await buildPdf(pages)), js = await pdfjsLib.getDocument({ data: await src.save() }).promise;
        const out = await L.PDFDocument.create();
        for (let i = 0; i < pages.length; i++) {
          const p = await js.getPage(i + 1), vp = p.getViewport({ scale: 1 }), w = vp.width, h = vp.height;
          let box = { x: 0, y: 0, w, h }, Wn, Hn, s = 1, offX, offY;
          if (mode === 'auto') {
            const sc = 1.5, c = document.createElement('canvas'); c.width = Math.ceil(w * sc); c.height = Math.ceil(h * sc);
            const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
            await p.render({ canvasContext: cx, viewport: p.getViewport({ scale: sc }) }).promise;
            const d = cx.getImageData(0, 0, c.width, c.height).data; let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
            for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const k = (y * c.width + x) * 4; if (d[k] + d[k + 1] + d[k + 2] < 735) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
            if (x1 >= 0) { const a = mm(val(m, '[data-am]')); box = { x: Math.max(0, x0 / sc - a), y: Math.max(0, y0 / sc - a) }; box.w = Math.min(w, (x1 + 1) / sc + a) - box.x; box.h = Math.min(h, (y1 + 1) / sc + a) - box.y; }
          } else if (mode === 'manual') {
            const t = mm(val(m, '[data-t]')), b = mm(val(m, '[data-b]')), l = mm(val(m, '[data-l]')), r = mm(val(m, '[data-r]'));
            box = { x: l, y: t, w: Math.max(20, w - l - r), h: Math.max(20, h - t - b) };
          }
          if (mode === 'size') {
            let [a, b] = SIZES[val(m, '[data-size]')]; const ori = val(m, '[data-ori]');
            if (ori === 'l' || (ori === 'auto' && w > h)) [a, b] = [b, a];
            const mg = mm(val(m, '[data-sm]')); Wn = a; Hn = b; s = Math.min((Wn - 2 * mg) / w, (Hn - 2 * mg) / h); offX = (Wn - s * w) / 2; offY = (Hn - s * h) / 2;
          } else { Wn = box.w; Hn = box.h; offX = -box.x; offY = -box.y; }
          // trang hiển thị (đã tính góc xoay) → trang mới đứng thẳng: M = [s,0,0,-s,offX,Hn-offY] · (ma trận hiển thị của pdf.js)
          const [A, B, C, D, E, F] = vp.transform, np = out.addPage([Wn, Hn]), emb = await out.embedPage(src.getPage(i));
          np.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(s * A, -s * B, s * C, -s * D, s * E + offX, -s * F + Hn - offY));
          np.drawPage(emb, { x: 0, y: 0 });
          np.pushOperators(L.popGraphicsState());
        }
        const fresh = await addPdfSource(await out.save(), S.fileName);
        pages.forEach((pg, i) => { const k = S.pages.indexOf(pg); if (k >= 0) S.pages[k] = fresh[i]; });
        rebuild(); commit(); toast(`Đã cập nhật ${pages.length} trang`);
      } finally { busy(false); }
    }, 560);
    hookScope(m);
  }

  // 7. Tìm & thay thế chữ (giữ phông, cỡ, màu như chữ gốc — dùng đúng cơ chế "Sửa nội dung")
  function findReplace() {
    if (!needDoc()) return;
    const m = dialog('🔎 Tìm & thay thế', `
      <div class="tf"><label>Tìm</label><input data-q style="flex:1"></div>
      <div class="tf"><label>Thay bằng</label><input data-r style="flex:1"></div>
      <div class="tf"><label class="chk"><input data-case type="checkbox"> Phân biệt hoa / thường</label></div>
      <div class="tf"><button class="ghost" data-count>Đếm số chỗ</button><span data-res class="muted"></span></div>
      <p class="muted">Thay trên chữ gốc của PDF và chữ đã thêm. Chữ trong ảnh scan cần OCR trước.</p>`, 'Thay tất cả', async m => {
      const q = val(m, '[data-q]'); if (!q) { alert('Nhập chữ cần tìm'); return false; }
      const n = await replaceAll(q, val(m, '[data-r]'), val(m, '[data-case]'));
      toast(n ? `Đã thay ${n} chỗ` : 'Không tìm thấy', 3000);
    }, 480);
    m.querySelector('[data-count]').onclick = async () => { const q = val(m, '[data-q]'); if (!q) return; const r = await countAll(q, val(m, '[data-case]')); m.querySelector('[data-res]').textContent = `Tìm thấy ${r.n} chỗ trên ${r.pages} trang`; };
    setTimeout(() => m.querySelector('[data-q]').focus(), 50);
  }
  const findIn = (s, q, cs) => (cs ? s : s.toLowerCase()).indexOf(cs ? q : q.toLowerCase());
  const countIn = (s, q, cs) => { let n = 0, i = 0, a = cs ? s : s.toLowerCase(), b = cs ? q : q.toLowerCase(); while ((i = a.indexOf(b, i)) >= 0) { n++; i += b.length; } return n; };
  async function countAll(q, cs) {
    let n = 0, pages = 0; busy(true, 'Đang tìm…');
    try {
      for (const pg of S.pages) {
        let k = 0; const v = S.views.get(pg.id);
        if (pg.src && v) { const T = await pageTextItems(v); for (const a of T.items) k += countIn(a.it.str, q, cs); }
        for (const o of pg.objs || []) if (o.text) k += countIn(o.text, q, cs);
        if (k) { n += k; pages++; }
      }
    } finally { busy(false); }
    return { n, pages };
  }
  function replaceInText(t, q, r, cs) {
    let n = 0, from = t.text.length;
    for (;;) { const s = cs ? t.text : t.text.toLowerCase(), i = s.lastIndexOf(cs ? q : q.toLowerCase(), from); if (i < 0) break;
      t.removeChars(i, i + q.length); if (r) t.insertChars(r, null, i); n++; from = i - 1; if (from < 0) break; }
    return n;
  }
  async function replaceAll(q, r, cs) {
    finishEditing(); let n = 0; busy(true, 'Đang thay…');
    try {
      for (const pg of S.pages) {
        const v0 = S.views.get(pg.id); if (!v0) continue; await ready(v0);
        // chữ đã thêm / đã sửa (đối tượng)
        const v = S.views.get(pg.id); if (v.fc) { for (const t of v.fc.getObjects().filter(o => o.text != null)) n += replaceInText(t, q, r, cs); v.fc.requestRenderAll(); syncView(v); }
        if (!pg.src) continue;
        const seen = new Set();
        for (let guard = 0; guard < 300; guard++) {
          const vv = S.views.get(pg.id), T = await pageTextItems(vv);
          const a = T.items.find(a => findIn(a.it.str, q, cs) >= 0 && !seen.has(Math.round(a.ox) + ',' + Math.round(a.oy)));
          if (!a) break;
          seen.add(Math.round(a.ox) + ',' + Math.round(a.oy));
          const i = findIn(a.it.str, q, cs), len = a.it.str.length || 1;
          const [x, y] = toDisp(a, a.w * (i + 0.5) / len, -a.fh * 0.3);
          $('#busyMsg').textContent = `Đang thay… trang ${S.pages.indexOf(pg) + 1} (${n})`;
          await editTextAt(vv, { x, y });
          const v2 = S.views.get(pg.id), t = v2.fc && v2.fc.getActiveObject();
          if (t && t.text != null) { if (t.isEditing) t.exitEditing(); n += replaceInText(t, q, r, cs); v2.fc.discardActiveObject(); v2.fc.requestRenderAll(); syncView(v2); }
        }
      }
      commit();
    } finally { busy(false); }
    return n;
  }

  // 8. Che thông tin (Redact): xoá hẳn chữ / phần ảnh trong khung rồi phủ đen
  function redactMode() {
    if (!needDoc()) return;
    setTool('redact');
    toast('Che thông tin: kéo khung lên phần cần che — chữ và ảnh trong khung bị XOÁ HẲN khỏi file rồi phủ đen. Esc để thôi.', 6000);
  }
  async function redact(v, box) {
    if (box.w < 3 || box.h < 3) return;
    const pg = v.page;
    busy(true, 'Đang che…');
    try {
      if (pg.src) {
        // chữ gốc: thêm vùng xoá (toạ độ PDF)
        const p = await getJsPage(pg), vp = p.getViewport({ scale: 1, rotation: effRot(pg) });
        const cs = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => vp.convertToPdfPoint(x, y));
        pg.del = (pg.del || []).concat([{ x0: Math.min(...cs.map(c => c[0])), y0: Math.min(...cs.map(c => c[1])), x1: Math.max(...cs.map(c => c[0])), y1: Math.max(...cs.map(c => c[1])) }]);
        if (pg.ocr) pg.ocr = pg.ocr.filter(l => !(l.x0 < box.x + box.w && l.x1 > box.x && l.y0 < box.y + box.h && l.y1 > box.y));
      }
      // chữ / ảnh đã thêm nằm trong khung
      const inBox = o => { const b = o.getBoundingRect(true, true); return b.left < box.x + box.w && b.left + b.width > box.x && b.top < box.y + box.h && b.top + b.height > box.y; };
      v.loading = true; v.fc.getObjects().filter(o => o.text != null && inBox(o)).forEach(o => v.fc.remove(o)); v.loading = false;
      // ảnh gốc của PDF chồng lên khung: tẩy đúng phần giao nhau
      if (pg.src) {
        const I = await pageImageItems(v);
        for (const im of (I.list || []).slice()) {
          const P2 = [im.P1[0] + im.P3[0] - im.P0[0], im.P1[1] + im.P3[1] - im.P0[1]], ps = [im.P0, im.P1, im.P3, P2];
          const b = { x0: Math.min(...ps.map(q => q[0])), y0: Math.min(...ps.map(q => q[1])), x1: Math.max(...ps.map(q => q[0])), y1: Math.max(...ps.map(q => q[1])) };
          const x0 = Math.max(box.x, b.x0), y0 = Math.max(box.y, b.y0), x1 = Math.min(box.x + box.w, b.x1), y1 = Math.min(box.y + box.h, b.y1);
          if (x1 - x0 > 1 && y1 - y0 > 1) await eraseAt(S.views.get(pg.id), x0, y0, x1 - x0, y1 - y0);
        }
      }
      const vv = S.views.get(pg.id);
      vv.loading = true; vv.fc.add(new fabric.Rect({ left: box.x, top: box.y, width: box.w, height: box.h, fill: '#000000', strokeWidth: 0, kind: 'rect', tag: 'redact', originX: 'left', originY: 'top' })); vv.loading = false;
      syncView(vv); commit();
      vv.tc = null; vv.titems = null; vv.titemsVal = null; vv.imgs = null; vv.imgsVal = null; vv.vecs = null; vv.vecsVal = null;
      await refreshPdfLayer(vv);
      toast('Đã che — nội dung bên dưới đã bị xoá khỏi file khi lưu', 3000);
    } finally { busy(false); }
  }

  // 9. Nén giảm dung lượng: nén lại ảnh (JPEG), thu nhỏ ảnh quá lớn, gộp đối tượng
  function compress() {
    if (!needDoc()) return;
    dialog('🗜 Nén giảm dung lượng', `
      <div class="tf"><label class="chk"><input type="radio" name="cq" value="0.82,2400"> Nhẹ — ảnh gần như nguyên bản</label></div>
      <div class="tf"><label class="chk"><input type="radio" name="cq" value="0.7,1700" checked> Vừa — khuyên dùng (gửi email)</label></div>
      <div class="tf"><label class="chk"><input type="radio" name="cq" value="0.5,1200"> Mạnh — file nhỏ nhất, ảnh kém nét hơn</label></div>
      <p class="muted">Tải về bản đã nén (tên có đuôi "-nen"); file đang mở không đổi. Chữ và nét vẽ vẫn sắc nét.</p>`, 'Nén & tải về', async m => {
      const [q, maxPx] = m.querySelector('input[name=cq]:checked').value.split(',').map(Number);
      finishEditing(); busy(true, 'Đang nén…');
      try {
        const before = await buildPdf(undefined, { final: true }), after = await compressBytes(before, q, maxPx);
        const best = after.length < before.length ? after : before;
        downloadBlob(new Blob([best], { type: 'application/pdf' }), `${baseName()}-nen.pdf`);
        alert(`Dung lượng: ${fmtSize(before.length)} → ${fmtSize(best.length)} (giảm ${Math.max(0, Math.round((1 - best.length / before.length) * 100))}%)`);
      } finally { busy(false); }
    });
  }
  // gộp đối tượng trùng lặp (phông, ảnh… mỗi trang chép 1 bản giống hệt nhau) → giữ 1 bản, các chỗ khác trỏ về bản đó
  async function dedupe(ctx) {
    const skip = new Set(['/Page', '/Pages', '/Catalog']);
    for (let round = 0; round < 4; round++) {
      const seen = new Map(), map = new Map();
      for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        let key;
        if (obj instanceof L.PDFRawStream) {
          const h = new Uint8Array(await crypto.subtle.digest('SHA-1', obj.contents));
          const d = obj.dict.clone(ctx); d.delete(N('Length')); key = 'S' + d.toString() + hex(h);
        } else if (obj instanceof L.PDFDict) { if (skip.has(String(obj.get(N('Type'))))) continue; key = 'D' + obj.toString(); }
        else continue;
        if (seen.has(key)) map.set(ref.toString(), seen.get(key)); else seen.set(key, ref);
      }
      if (!map.size) break;
      const fix = o => {
        if (o instanceof L.PDFDict) { for (const [k, v] of o.entries()) { if (v instanceof L.PDFRef && map.has(v.toString())) o.set(k, map.get(v.toString())); else fix(v); } }
        else if (o instanceof L.PDFArray) { for (let i = 0; i < o.size(); i++) { const v = o.get(i); if (v instanceof L.PDFRef && map.has(v.toString())) o.set(i, map.get(v.toString())); else fix(v); } }
        else if (o instanceof L.PDFStream) fix(o.dict);
      };
      for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj);
      for (const k of Object.keys(ctx.trailerInfo)) { const v = ctx.trailerInfo[k]; if (v instanceof L.PDFRef && map.has(v.toString())) ctx.trailerInfo[k] = map.get(v.toString()); }
      for (const [, obj] of ctx.enumerateIndirectObjects()) void obj;
      for (const r of map.keys()) { const [n, g] = r.split(' '); ctx.delete(L.PDFRef.of(+n, +g)); }
    }
  }
  async function compressBytes(bytes, q, maxPx) {
    const doc = await L.PDFDocument.load(bytes, { updateMetadata: false }), ctx = doc.context;
    await dedupe(ctx);
    const num = o => (o && o.asNumber ? o.asNumber() : 0);
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof L.PDFRawStream)) continue;
      const d = obj.dict; if (String(d.get(N('Subtype'))) !== '/Image' || d.get(N('ImageMask')) || d.get(N('Decode'))) continue;
      const w = num(d.lookup(N('Width'))), h = num(d.lookup(N('Height'))), bpc = num(d.lookup(N('BitsPerComponent')));
      if (!w || !h || obj.contents.length < 30000) continue;
      const filt = d.lookup(N('Filter')), fname = filt instanceof L.PDFArray ? (filt.size() === 1 ? String(filt.get(0)) : 'multi') : String(filt || '');
      let cs = d.lookup(N('ColorSpace')), comps = 0;
      if (cs instanceof L.PDFName) comps = { '/DeviceRGB': 3, '/DeviceGray': 1 }[String(cs)] || 0;
      else if (cs instanceof L.PDFArray && String(cs.get(0)) === '/ICCBased') { const st = cs.lookup(1); comps = [1, 3].includes(num(st && st.dict.lookup(N('N')))) ? num(st.dict.lookup(N('N'))) : 0; }
      if (!comps) continue;
      let src;
      try {
        if (fname === '/DCTDecode') src = await createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
        else if ((fname === '/FlateDecode' || fname === '') && bpc === 8) {
          const parms = d.lookup(N('DecodeParms')); if (parms && num(parms.lookup && parms.lookup(N('Predictor'))) > 1) continue;
          const raw = L.decodePDFRawStream(obj).decode(); if (raw.length < w * h * comps) continue;
          const id = new ImageData(w, h); for (let i = 0, j = 0; i < w * h; i++, j += comps) { const k = i * 4; id.data[k] = raw[j]; id.data[k + 1] = raw[j + (comps === 3 ? 1 : 0)]; id.data[k + 2] = raw[j + (comps === 3 ? 2 : 0)]; id.data[k + 3] = 255; }
          src = await createImageBitmap(id);
        } else continue;
      } catch (e) { continue; }
      const s = Math.min(1, maxPx / Math.max(w, h)), nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
      const c = document.createElement('canvas'); c.width = nw; c.height = nh; const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, nw, nh); cx.drawImage(src, 0, 0, nw, nh);
      const jb = new Uint8Array(await (await new Promise(ok => c.toBlob(ok, 'image/jpeg', q))).arrayBuffer());
      if (jb.length > obj.contents.length * 0.9) continue;
      d.set(N('Filter'), N('DCTDecode')); d.delete(N('DecodeParms')); d.set(N('Width'), ctx.obj(nw)); d.set(N('Height'), ctx.obj(nh)); d.set(N('BitsPerComponent'), ctx.obj(8)); d.set(N('ColorSpace'), N('DeviceRGB'));
      ctx.assign(ref, L.PDFRawStream.of(d, jb));
    }
    return doc.save({ useObjectStreams: true });
  }

  // 10. Đặt mật khẩu — mã hoá chuẩn PDF (RC4 128-bit, Standard security handler R3), mở được bằng mọi trình đọc PDF
  function md5(bytes) {
    const K = new Uint32Array(64), r = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
    const n = bytes.length, len = ((n + 8) >> 6) + 1 << 6, m = new Uint8Array(len); m.set(bytes); m[n] = 0x80;
    const bits = n * 8; for (let i = 0; i < 4; i++) m[len - 8 + i] = (bits >>> (8 * i)) & 255; m[len - 4] = Math.floor(n / 2 ** 29) & 255;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let o = 0; o < len; o += 64) {
      const M = new Uint32Array(16); for (let i = 0; i < 16; i++) M[i] = m[o + i * 4] | (m[o + i * 4 + 1] << 8) | (m[o + i * 4 + 2] << 16) | (m[o + i * 4 + 3] << 24);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g; if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const tmp = D; D = C; C = B; const x = (A + F + K[i] + M[g]) >>> 0, s = r[(i >> 4) * 4 + (i % 4)]; B = (B + ((x << s) | (x >>> (32 - s)))) >>> 0; A = tmp;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16); [a0, b0, c0, d0].forEach((v, k) => { for (let i = 0; i < 4; i++) out[k * 4 + i] = (v >>> (8 * i)) & 255; });
    return out;
  }
  function rc4(key, data) {
    const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; out[k] = data[k] ^ s[(s[i] + s[j]) & 255]; }
    return out;
  }
  const PAD = Uint8Array.from([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);
  const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const padPw = pw => { const b = Uint8Array.from([...pw].map(c => c.charCodeAt(0) & 255)).slice(0, 32); return cat(b, PAD.slice(0, 32 - b.length)); };
  const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  async function encryptBytes(bytes, userPw, ownerPw, perms) {
    const doc = await L.PDFDocument.load(bytes, { updateMetadata: false }), ctx = doc.context;
    const id0 = crypto.getRandomValues(new Uint8Array(16)), P = perms | 0;
    let k = md5(padPw(ownerPw)); for (let i = 0; i < 50; i++) k = md5(k);
    let O = rc4(k, padPw(userPw)); for (let i = 1; i <= 19; i++) O = rc4(k.map(x => x ^ i), O);
    const pb = Uint8Array.from([P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >> 24) & 255]);
    let key = md5(cat(padPw(userPw), O, pb, id0)); for (let i = 0; i < 50; i++) key = md5(key);
    let U = rc4(key, md5(cat(PAD, id0))); for (let i = 1; i <= 19; i++) U = rc4(key.map(x => x ^ i), U); U = cat(U, new Uint8Array(16));
    const objKey = ref => md5(cat(key, Uint8Array.from([ref.objectNumber & 255, (ref.objectNumber >> 8) & 255, (ref.objectNumber >> 16) & 255, ref.generationNumber & 255, (ref.generationNumber >> 8) & 255])));
    const encStr = (o, kk) => L.PDFHexString.of(hex(rc4(kk, o.asBytes())));
    const walk = (o, kk) => {
      if (o instanceof L.PDFDict) { for (const [n, v] of o.entries()) { if (v instanceof L.PDFString || v instanceof L.PDFHexString) o.set(n, encStr(v, kk)); else walk(v, kk); } }
      else if (o instanceof L.PDFArray) { for (let i = 0; i < o.size(); i++) { const v = o.get(i); if (v instanceof L.PDFString || v instanceof L.PDFHexString) o.set(i, encStr(v, kk)); else walk(v, kk); } }
    };
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      const kk = objKey(ref);
      if (obj instanceof L.PDFRawStream) { walk(obj.dict, kk); ctx.assign(ref, L.PDFRawStream.of(obj.dict, rc4(kk, obj.contents))); }
      else if (obj instanceof L.PDFStream) { const raw = obj.getContents ? obj.getContents() : null; if (raw) { walk(obj.dict, kk); ctx.assign(ref, L.PDFRawStream.of(obj.dict, rc4(kk, raw))); } }
      else if (obj instanceof L.PDFString || obj instanceof L.PDFHexString) ctx.assign(ref, encStr(obj, kk));
      else walk(obj, kk);
    }
    const enc = ctx.register(ctx.obj({ Filter: 'Standard', V: 2, R: 3, Length: 128, P, O: L.PDFHexString.of(hex(O)), U: L.PDFHexString.of(hex(U)) }));
    ctx.trailerInfo.Encrypt = enc;
    ctx.trailerInfo.ID = ctx.obj([L.PDFHexString.of(hex(id0)), L.PDFHexString.of(hex(id0))]);
    return doc.save({ useObjectStreams: false });
  }
  function password() {
    if (!needDoc()) return;
    dialog('🔒 Mật khẩu', `
      <div class="tf"><label>Mật khẩu mở file</label><input data-p1 type="password" autocomplete="new-password"></div>
      <div class="tf"><label>Nhập lại</label><input data-p2 type="password" autocomplete="new-password"></div>
      <div class="tf"><label class="chk"><input data-noprint type="checkbox"> Chặn in</label><label class="chk"><input data-nocopy type="checkbox"> Chặn sao chép chữ</label><label class="chk"><input data-noedit type="checkbox"> Chặn sửa</label></div>
      <p class="muted">Tải về bản đã khoá (tên có đuôi "-khoa"); file đang mở không đổi. Mật khẩu dùng chữ không dấu, số, ký hiệu. <b>Quên mật khẩu thì không mở lại được.</b></p>`, 'Khoá & tải về', async m => {
      const p1 = val(m, '[data-p1]'), p2 = val(m, '[data-p2]');
      if (!p1) { alert('Nhập mật khẩu'); return false; }
      if (p1 !== p2) { alert('Hai lần nhập không giống nhau'); return false; }
      if (/[^\x20-\x7e]/.test(p1)) { alert('Mật khẩu chỉ dùng chữ không dấu, số và ký hiệu'); return false; }
      let P = -4; if (val(m, '[data-noprint]')) P &= ~(4 | 2048); if (val(m, '[data-nocopy]')) P &= ~(16 | 512); if (val(m, '[data-noedit]')) P &= ~(8 | 32 | 256 | 1024);
      const owner = hex(crypto.getRandomValues(new Uint8Array(12)));
      finishEditing(); busy(true, 'Đang khoá…');
      try {
        const bytes = await encryptBytes(await buildPdf(undefined, { final: true }), p1, owner, P);
        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${baseName()}-khoa.pdf`);
        toast('Đã tải bản có mật khẩu', 3000);
      } finally { busy(false); }
    });
  }

  // 11. Mục lục (bookmark)
  async function importOutline() {
    try {
      const pg0 = S.pages.find(p => p.src); if (!pg0) return;
      const js = S.sources[pg0.src].js, ol = await js.getOutline(); if (!ol || !ol.length) return;
      const out = [];
      const walk = async (items, level) => {
        for (const it of items) {
          let dest = it.dest; if (typeof dest === 'string') dest = await js.getDestination(dest);
          let pageId = null;
          if (Array.isArray(dest) && dest[0]) { try { const idx = typeof dest[0] === 'object' ? await js.getPageIndex(dest[0]) : dest[0]; const pg = S.pages.find(p => p.src === pg0.src && p.index === idx); pageId = pg ? pg.id : null; } catch (e) {} }
          out.push({ title: (level ? '— '.repeat(level) : '') + (it.title || ''), pageId });
          if (it.items && it.items.length) await walk(it.items, level + 1);
        }
      };
      await walk(ol, 0);
      S.outline = out.filter(o => o.pageId);
    } catch (e) { console.warn('outline', e); }
  }
  function outlineEditor() {
    if (!needDoc()) return;
    const rows = (S.outline || []).map(o => ({ title: o.title, n: S.pages.findIndex(p => p.id === o.pageId) + 1 })).filter(r => r.n > 0);
    const m = dialog('🔖 Mục lục (bookmark)', `
      <p class="muted">Mục lục hiện ở cột bên trái khi mở file bằng Adobe, Edge, Chrome… bấm vào để nhảy tới trang. Lưu file (Ctrl+S / Tải xuống) để ghi vào file.</p>
      <div class="ol-list" data-list></div>
      <div class="row" style="gap:6px;flex-wrap:wrap"><button class="ghost" data-add>＋ Thêm mục (trang đang xem)</button><button class="ghost" data-each>Mỗi trang 1 mục</button><button class="ghost" data-clear>Xoá hết</button></div>`, 'Lưu mục lục', m => {
      const list = [...m.querySelectorAll('.ol-row')].map(r => ({ title: r.querySelector('[data-t]').value.trim(), n: +r.querySelector('[data-n]').value }))
        .filter(r => r.title && r.n >= 1 && r.n <= S.pages.length);
      S.outline = list.map(r => ({ title: r.title, pageId: S.pages[r.n - 1].id })); S.dirty = true; updateUI();
      toast(`Đã đặt ${list.length} mục — bấm Lưu để ghi vào file`, 3000);
    }, 520);
    const box = m.querySelector('[data-list]');
    const add = (title, n) => { const r = document.createElement('div'); r.className = 'ol-row'; r.innerHTML = `<input data-t value="${esc(title)}" placeholder="Tiêu đề"><span>trang</span><input data-n type="number" min="1" max="${S.pages.length}" value="${n}"><button class="mini" title="Xoá">✕</button>`; r.querySelector('button').onclick = () => r.remove(); box.appendChild(r); };
    rows.forEach(r => add(r.title, r.n));
    m.querySelector('[data-add]').onclick = () => add(`Mục ${box.children.length + 1}`, S.cur + 1);
    m.querySelector('[data-each]').onclick = () => { box.innerHTML = ''; S.pages.forEach((p, i) => add(`Trang ${i + 1}`, i + 1)); };
    m.querySelector('[data-clear]').onclick = () => { box.innerHTML = ''; };
  }
  async function beforeSave(out, list) {
    // mỗi trang được chép riêng nên phông / ảnh dùng chung bị lặp lại → gộp lại (file nhỏ như bản gốc)
    try { await dedupe(out.context); } catch (e) { console.warn('dedupe', e); }
    const items = (S.outline || []).map(o => ({ title: o.title, k: list.findIndex(p => p.id === o.pageId) })).filter(o => o.k >= 0 && o.title);
    if (!items.length) return;
    const ctx = out.context, pages = out.getPages(), root = ctx.nextRef(), refs = items.map(() => ctx.nextRef());
    items.forEach((it, i) => {
      const d = { Title: L.PDFHexString.fromText(it.title), Parent: root, Dest: ctx.obj([pages[it.k].ref, 'XYZ', null, null, null]) };
      if (i > 0) d.Prev = refs[i - 1]; if (i < refs.length - 1) d.Next = refs[i + 1];
      ctx.assign(refs[i], ctx.obj(d));
    });
    ctx.assign(root, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
    out.catalog.set(N('Outlines'), root); out.catalog.set(N('PageMode'), N('UseOutlines'));
  }

  // 12. Xuất Word / Excel — lấy chữ (kể cả chữ đã sửa / đã thêm) theo dòng; Excel tách cột theo khoảng trống
  async function pageLines(pg) {
    const segs = [];
    if (pg.src) {
      const p = await getJsPage(pg), vp = p.getViewport({ scale: 1, rotation: effRot(pg) }), tc = await p.getTextContent();
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]), fs = Math.hypot(it.transform[2], it.transform[3]) || 10;
        let bold = false; try { bold = /bold|black|heavy/i.test(p.commonObjs.get(it.fontName).name || ''); } catch (e) {}
        segs.push({ x, y, w: it.width, fs, str: it.str, bold });
      }
    }
    for (const o of pg.objs || []) if (o.text && o.tag !== 'wm') {
      const fs = (o.fontSize || 12) * (o.scaleY || 1), x = o.originX === 'center' ? o.left - (o.width || 0) / 2 : o.originX === 'right' ? o.left - (o.width || 0) : o.left;
      o.text.split('\n').forEach((s, i) => segs.push({ x, y: (o.originY === 'center' ? o.top - fs / 2 : o.top) + fs * (0.9 + i * 1.16), w: (o.width || s.length * fs * 0.5), fs, str: s, bold: o.fontWeight === 'bold' }));
    }
    segs.sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const s of segs) { const L0 = lines[lines.length - 1]; if (L0 && Math.abs(L0.y - s.y) < Math.min(L0.fs, s.fs) * 0.5) L0.segs.push(s); else lines.push({ y: s.y, fs: s.fs, segs: [s] }); }
    for (const ln of lines) ln.segs.sort((a, b) => a.x - b.x);
    return lines;
  }
  const xml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  async function toDocx(pages) {
    const JSZip = await zipLib(), zip = new JSZip(); let body = '';
    for (let k = 0; k < pages.length; k++) {
      $('#busyMsg').textContent = `Đang đọc trang ${k + 1}/${pages.length}…`;
      const lines = await pageLines(pages[k]); let lastY = null;
      for (const ln of lines) {
        const gap = lastY != null ? ln.y - lastY : 0; lastY = ln.y;
        const before = gap > ln.fs * 2 ? Math.min(600, Math.round((gap - ln.fs * 1.3) * 20)) : 0;
        let runs = '', px = null;
        for (const s of ln.segs) {
          const sep = px != null && s.x - px > s.fs * 1.5 ? '<w:r><w:tab/></w:r>' : px != null && s.x - px > s.fs * 0.15 ? `<w:r><w:t xml:space="preserve"> </w:t></w:r>` : '';
          runs += sep + `<w:r><w:rPr>${s.bold ? '<w:b/>' : ''}<w:sz w:val="${Math.max(8, Math.round(s.fs * 2))}"/></w:rPr><w:t xml:space="preserve">${xml(s.str)}</w:t></w:r>`; px = s.x + s.w;
        }
        body += `<w:p><w:pPr><w:spacing w:before="${before}" w:after="0"/></w:pPr>${runs}</w:p>`;
      }
      if (k < pages.length - 1) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    }
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`);
    return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }
  const colName = i => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  async function toXlsx(pages) {
    const JSZip = await zipLib(), zip = new JSZip(), sheets = [];
    for (let k = 0; k < pages.length; k++) {
      $('#busyMsg').textContent = `Đang đọc trang ${k + 1}/${pages.length}…`;
      const lines = await pageLines(pages[k]);
      // gộp chữ sát nhau thành ô; ô cách nhau xa (> 1.2 cỡ chữ) là 2 cột
      const rows = lines.map(ln => { const cells = []; let cur = null; for (const s of ln.segs) { if (cur && s.x - (cur.x + cur.w) < s.fs * 1.2) { cur.str += (s.x - (cur.x + cur.w) > s.fs * 0.15 ? ' ' : '') + s.str; cur.w = s.x + s.w - cur.x; } else { cur = { x: s.x, w: s.w, str: s.str, bold: s.bold }; cells.push(cur); } } return cells; });
      const xs = rows.flat().map(c => c.x).sort((a, b) => a - b), anchors = [];
      for (const x of xs) if (!anchors.length || x - anchors[anchors.length - 1] > 14) anchors.push(x);
      let data = '';
      rows.forEach((cells, ri) => {
        const used = new Set(); let cx = '';
        for (const c of cells) {
          let ci = 0; for (let j = 0; j < anchors.length; j++) if (anchors[j] <= c.x + 7) ci = j; while (used.has(ci)) ci++; used.add(ci);
          const ref = colName(ci) + (ri + 1), t = c.str.trim(), numv = /^-?\d+([.,]\d+)?$/.test(t) && !/^0\d/.test(t) ? t.replace(',', '.') : null;
          cx += numv != null ? `<c r="${ref}"><v>${numv}</v></c>` : `<c r="${ref}" t="inlineStr"${c.bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(t)}</t></is></c>`;
        }
        data += `<row r="${ri + 1}">${cx}</row>`;
      });
      sheets.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`);
    }
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="Trang ${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
    zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>');
    sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, s));
    return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function exportOffice() {
    if (!needDoc()) return;
    const m = dialog('📄 Xuất Word / Excel', `
      <div class="tf"><label class="chk"><input type="radio" name="of" value="docx" checked> Word (.docx) — văn bản theo từng dòng</label></div>
      <div class="tf"><label class="chk"><input type="radio" name="of" value="xlsx"> Excel (.xlsx) — bảng, mỗi trang 1 sheet</label></div>
      ${scopeHtml()}
      <p class="muted">Lấy chữ của PDF (cả chữ đã sửa / thêm). Ảnh và hình vẽ không chuyển. File scan cần OCR trước.</p>`, 'Xuất & tải về', async m => {
      const pages = scopePages(m); if (!pages) return false;
      const fmt = m.querySelector('input[name=of]:checked').value;
      finishEditing(); busy(true, 'Đang chuyển…');
      try { downloadBlob(fmt === 'docx' ? await toDocx(pages) : await toXlsx(pages), `${baseName()}.${fmt}`); toast('Đã xuất ' + (fmt === 'docx' ? 'Word' : 'Excel'), 2500); }
      finally { busy(false); }
    });
    hookScope(m);
  }

  /* ---------- nút ở cột "Trang" ---------- */
  function initUI() {
    const ops = $('.page-ops'); if (!ops || ops.dataset.tools) return; ops.dataset.tools = '1';
    const groups = [
      // [nhãn, gợi ý, hàm, icon Tabler, màu ô] — icon kiểu "ô màu" như thanh công cụ
      ['Trang', [['Số trang', 'Thêm số trang ở đầu / chân trang', pageNumbers, 'list-numbers', 'blue'], ['Tách file', 'Chia PDF thành nhiều file (.zip)', splitFile, 'cut', 'blue'],
        ['Cỡ trang', 'Cắt lề trắng hoặc đổi sang A4, A3, Letter…', cropResize, 'crop', 'teal'], ['Chèn file', 'Chèn trang từ file PDF / ảnh khác vào sau trang đang xem', insertFromFile, 'file-import', 'teal']]],
      ['Nội dung', [['Đóng dấu', 'Đóng chữ mờ (BẢN NHÁP…) hoặc logo mờ lên các trang', addWatermark, 'rubber-stamp', 'purple'], ['Đầu / chân', 'Thêm dòng chữ cố định lên đầu / chân mọi trang', headerFooter, 'layout-navbar', 'purple'],
        ['Tìm & thay', 'Thay chữ hàng loạt, giữ phông / cỡ / màu', findReplace, 'replace', 'amber'], ['Che tin', 'Kéo khung để xoá hẳn và bôi đen thông tin nhạy cảm', redactMode, 'eye-off', 'red']]],
      ['File', [['Nén file', 'Giảm dung lượng (nén ảnh)', compress, 'file-zip', 'green'], ['Mật khẩu', 'Khoá file bằng mật khẩu khi mở', password, 'lock', 'green'],
        ['Mục lục', 'Tạo / sửa mục lục (bookmark) của file', outlineEditor, 'bookmarks', 'coral'], ['Word/Excel', 'Xuất ra .docx hoặc .xlsx', exportOffice, 'file-type-docx', 'coral'],
        ['So sánh', 'So sánh 2 bản PDF, tô màu chỗ khác nhau (bản vẽ trước / sau khi sửa…)', () => window.PdfCompare && PdfCompare.open(), 'arrows-diff', 'teal']]],
    ];
    for (const [title, btns] of groups) {
      const h = document.createElement('div'); h.className = 'ops-title'; h.textContent = title; ops.appendChild(h);
      for (const [label, tip, fn, icon, color] of btns) {
        const b = document.createElement('button'); b.title = tip; b.onclick = fn;
        b.innerHTML = `<i class="ico k-${color}"><span class="ti ti-${icon}"></span></i>`; b.appendChild(document.createTextNode(label));
        ops.appendChild(b);
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI); else initUI();

  return { redact, importOutline, beforeSave, compressBytes, encryptBytes, toDocx, toXlsx, pageLines,
    pageNumbers, splitFile, cropResize, insertFromFile, addWatermark, headerFooter, findReplace, redactMode, compress, password, outlineEditor, exportOffice, replaceAll, countAll };
})();
window.PdfTools = PdfTools;
