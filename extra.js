/* PDF Editor — thêm:
   6.  OCR cả file → khi lưu, mỗi trang scan có lớp chữ ẩn (tìm Ctrl+F, bôi đen copy được)
   7.  Đo khoảng cách theo mm trên bản vẽ (có tỉ lệ / hiệu chỉnh theo kích thước thật)
   11. Gợi ý chữ đúng cho từ OCR nghi đọc sai (tô đỏ)
   12. Sửa cả đoạn nhiều dòng trên bản scan (chữ tự xuống dòng, căn đều như bản gốc)
   Dùng chung hàm của app.js (S, ocrPage, ocrLineCrop, ocrFit, ocrSuspicious…). */
const PdfExtra = (() => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ================= 6. OCR cả file ================= */
  async function ocrAll() {
    if (!S.pages.length) return toast('Hãy mở file PDF trước');
    const todo = [];
    busy(true, 'Đang kiểm tra các trang…');
    try {
      for (const pg of S.pages) {
        if (!pg.src) continue;
        if (pg.ocr && pg.ocr.length) continue; // đã nhận dạng
        const v = S.views.get(pg.id); if (!v) continue;
        let n = 0; try { const T = await pageTextItems(v); n = T.items.reduce((a, x) => a + (x.it.str || '').trim().length, 0); } catch (e) {}
        if (n < 30) todo.push(pg); // trang gần như không có chữ thật → là ảnh scan
      }
    } finally { busy(false); }
    if (!todo.length) return toast('Các trang đã có chữ (hoặc đã nhận dạng) — không cần OCR thêm', 3500);
    if (todo.length > 3 && !confirm(`Nhận dạng chữ ${todo.length} trang scan? Mỗi trang mất khoảng 5–15 giây.`)) return;
    let done = 0;
    for (const pg of todo) {
      try { await ocrPage(pg); done++; } catch (e) { console.warn('OCR trang', e); }
      busy(true, `Nhận dạng chữ: xong ${done}/${todo.length} trang…`);
    }
    busy(false); updateUI();
    toast(`Đã nhận dạng ${done} trang. Bấm Lưu — file PDF sẽ tìm được chữ (Ctrl+F) và bôi đen copy được`, 6000);
  }
  // lúc xuất: chữ ẩn cho các dòng OCR chưa sửa (đúng vị trí, co giãn ngang cho khớp độ dài dòng)
  function hiddenTextObjs(pg) {
    const out = [];
    for (const l of pg.ocr || []) {
      if (l.done || !l.text || !l.text.trim()) continue;
      const h = l.y1 - l.y0, fs = Math.max(3, h * 0.82);
      const t = new fabric.IText(l.text, { left: l.x0, top: l.y0 - fs * 0.08, originX: 'left', originY: 'top', fontFamily: 'Arial', fontSize: fs, fill: '#000000', ocrInvisible: true, objectCaching: false });
      if (t.width > 0) t.set({ scaleX: Math.max(0.2, Math.min(5, (l.x1 - l.x0) / t.width)) });
      out.push(t);
    }
    return out;
  }

  /* ================= 7. đo khoảng cách ================= */
  const MM = 25.4 / 72;
  let meas = null; // { v, a, b, el, box, fixed }
  const fmt = (n, d = 1) => n.toLocaleString('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const scaleOf = pg => pg.mscale || 1; // mm thật / mm trên giấy
  function ensureLayer(v) {
    if (meas && meas.el && meas.v === v && meas.el.isConnected) return meas.el;
    clearMeasure();
    const el = document.createElement('div'); el.className = 'meas-layer'; v.el.appendChild(el);
    return el;
  }
  function clearMeasure() { if (meas && meas.el) meas.el.remove(); meas = null; }
  function snap(a, p, e) {
    let dx = p.x - a.x, dy = p.y - a.y;
    if (e && e.shiftKey) { const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), r = Math.hypot(dx, dy); dx = r * Math.cos(ang); dy = r * Math.sin(ang); }
    return { x: a.x + dx, y: a.y + dy };
  }
  function draw() {
    if (!meas) return;
    const { v, a, b, el } = meas, z = S.zoom, [W, H] = dispSize(v.page), sc = scaleOf(v.page);
    const L0 = Math.hypot(b.x - a.x, b.y - a.y) * MM, Lr = L0 * sc, dxr = Math.abs(b.x - a.x) * MM * sc, dyr = Math.abs(b.y - a.y) * MM * sc;
    const ang = Math.atan2(b.y - a.y, b.x - a.x), nx = -Math.sin(ang) * 5, ny = Math.cos(ang) * 5;
    el.style.width = W * z + 'px'; el.style.height = H * z + 'px';
    const X = p => p * z;
    el.innerHTML = `<svg width="${W * z}" height="${H * z}"><g stroke="#d93025" stroke-width="1.5" fill="none">
      <line x1="${X(a.x)}" y1="${X(a.y)}" x2="${X(b.x)}" y2="${X(b.y)}"/>
      <line x1="${X(a.x) - nx}" y1="${X(a.y) - ny}" x2="${X(a.x) + nx}" y2="${X(a.y) + ny}"/><line x1="${X(b.x) - nx}" y1="${X(b.y) - ny}" x2="${X(b.x) + nx}" y2="${X(b.y) + ny}"/>
      </g><circle cx="${X(a.x)}" cy="${X(a.y)}" r="2.5" fill="#d93025"/><circle cx="${X(b.x)}" cy="${X(b.y)}" r="2.5" fill="#d93025"/></svg>
      <div class="meas-tag" style="left:${X((a.x + b.x) / 2)}px;top:${X((a.y + b.y) / 2)}px">
        <b>${fmt(Lr)} mm</b><span>ngang ${fmt(dxr)} · đứng ${fmt(dyr)}${sc !== 1 ? ` · tỉ lệ 1:${fmt(sc, 2)}` : ''}</span>
        ${meas.fixed ? `<div class="meas-btns"><button data-k="real" title="Đoạn vừa đo thật ra dài bao nhiêu mm? → tự tính tỉ lệ bản vẽ">Đặt kích thước thật…</button><button data-k="ratio" title="Nhập tỉ lệ bản vẽ, vd 1:5">Tỉ lệ 1:${fmt(sc, 2)}</button><button data-k="keep" title="Vẽ đường đo + số đo lên bản vẽ (lưu vào file)">Ghi lên bản vẽ</button><button data-k="x" title="Bỏ (Esc)">×</button></div>` : ''}
      </div>`;
    const tag = el.querySelector('.meas-tag');
    if (meas.fixed) {
      tag.addEventListener('mousedown', e => e.stopPropagation());
      tag.querySelectorAll('[data-k]').forEach(btn => (btn.onclick = () => action(btn.dataset.k, L0)));
    }
  }
  function action(k, L0) {
    const pg = meas.v.page;
    if (k === 'x') return clearMeasure();
    if (k === 'real') {
      const s = prompt(`Đoạn vừa đo trên giấy dài ${fmt(L0, 2)} mm.\nKích thước THẬT của đoạn này là bao nhiêu mm? (vd 400)`);
      const r = parseFloat(String(s || '').replace(',', '.')); if (!(r > 0)) return;
      for (const p of S.pages) p.mscale = r / L0; // áp cho cả file (các trang bản vẽ thường cùng tỉ lệ)
      commit(); draw(); toast(`Đã đặt tỉ lệ 1:${fmt(r / L0, 2)} cho cả file — các lần đo sau tính theo kích thước thật`, 4000); return;
    }
    if (k === 'ratio') {
      const s = prompt('Tỉ lệ bản vẽ 1:N — nhập N (vd 1, 2, 5, 10, 20). Nhập 1 = đo đúng kích thước trên giấy.', String(+(scaleOf(pg)).toFixed(3)));
      const r = parseFloat(String(s || '').replace(',', '.')); if (!(r > 0)) return;
      for (const p of S.pages) p.mscale = r; commit(); draw(); return;
    }
    if (k === 'keep') {
      const { v, a, b } = meas, Lr = Math.hypot(b.x - a.x, b.y - a.y) * MM * scaleOf(pg);
      const ang = Math.atan2(b.y - a.y, b.x - a.x), nx = -Math.sin(ang) * 3, ny = Math.cos(ang) * 3;
      const ln = (x1, y1, x2, y2) => new fabric.Line([x1, y1, x2, y2], { kind: 'line', stroke: '#d32f2f', strokeWidth: 0.7, strokeLineCap: 'round' });
      let deg = ang * 180 / Math.PI; if (deg > 90) deg -= 180; if (deg < -90) deg += 180;
      const t = new fabric.IText(`${fmt(Lr)}`, { left: (a.x + b.x) / 2 + nx * 1.6, top: (a.y + b.y) / 2 + ny * 1.6, originX: 'center', originY: 'bottom', angle: deg, fontFamily: 'Arial', fontSize: 9, fill: '#d32f2f', kind: 'text' });
      v.loading = true; [ln(a.x, a.y, b.x, b.y), ln(a.x - nx, a.y - ny, a.x + nx, a.y + ny), ln(b.x - nx, b.y - ny, b.x + nx, b.y + ny), t].forEach(o => v.fc.add(o)); v.loading = false;
      v.fc.requestRenderAll(); syncView(v); clearMeasure(); toast('Đã ghi số đo lên bản vẽ (chọn bằng "Chọn đối tượng" để sửa / xoá)', 3000);
    }
  }
  function measureDown(v, p, e) { const el = ensureLayer(v); meas = { v, a: p, b: p, el, fixed: false }; draw(); }
  function measureMove(v, p, e) { if (!meas || meas.fixed || meas.v !== v) return; meas.b = snap(meas.a, p, e.e); draw(); }
  function measureUp(v, p, e) {
    if (!meas || meas.fixed || meas.v !== v) return;
    meas.b = snap(meas.a, p, e && e.e);
    if (Math.hypot(meas.b.x - meas.a.x, meas.b.y - meas.a.y) * S.zoom < 4) return clearMeasure();
    meas.fixed = true; draw();
  }

  /* ================= 11. gợi ý chữ đúng ================= */
  // âm tiết tiếng Việt hay gặp (văn bản hành chính, hợp đồng, kỹ thuật) — xếp đại khái theo độ phổ biến
  const COMMON = ('và của là có được cho không các người một những với trong này đã để theo khi đến từ thì về ra nhiều phải như làm cũng năm sẽ đó bên hàng hợp đồng ' +
    'thanh toán giá ngày tháng số tiền đơn vị công ty sản phẩm chất lượng giao nhận mua bán điều khoản trách nhiệm quyền lợi hai thời gian địa chỉ điện thoại ' +
    'tài khoản ngân chi nhánh tại thuế giá trị gia tăng hóa hoá đơn kế tổng cộng việt nam xuất nhập khẩu kho vận chuyển bốc xếp chịu mỗi đầu cuối trước sau ' +
    'thể hiện phiếu xác bản gốc sao y đóng dấu ký tên giám đốc đại diện chức vụ kỹ thuật thiết kế bản vẽ kích thước chiều dài rộng cao dày mm gỗ cao su keo ' +
    'sơn màu lắp ráp tháo chi tiết vật liệu khung chân mặt bàn ghế tủ kệ giường cửa ngăn kéo vít ốc bu lông đinh bản lề tay nắm thông tin ghi chú lưu ý ' +
    'yêu cầu đáp ứng tiêu chuẩn kiểm tra nghiệm thu bảo hành sửa chữa thay thế đổi trả phạt vi phạm bồi thường thiệt hại tranh chấp giải quyết hiệu lực kể ' +
    'từ hết hạn gia hạn chấm dứt thanh lý biên lập thành bộ mỗi giữ có giá trị pháp lý như nhau căn cứ luật dân sự thương mại quốc hội nước cộng hòa xã ' +
    'hội chủ nghĩa độc lập tự do hạnh phúc ông bà anh chị em tôi chúng ta họ mình nó ai gì nào sao đâu bao nhiêu mấy đây kia ấy rồi nữa vẫn còn đang sắp ' +
    'chưa đều cùng riêng tất cả mọi hoặc hay nhưng mà nên vì nếu tuy dù để cho bởi do tới qua lên xuống vào lại trên dưới ngoài giữa cạnh gần xa ' +
    'nhỏ lớn mới cũ tốt xấu đúng sai đủ thiếu thừa nhanh chậm sớm muộn ngay luôn chỉ rất quá hơn nhất kém bằng khác giống thêm bớt tăng giảm ' +
    'đặt hàng mẫu lô container cảng biển phí cước bảo hiểm tạm ứng đợt phần trăm còn lại chuyển khoản tiền mặt đồng ngoại tệ đô la tỷ triệu nghìn trăm ' +
    'mươi mười một hai ba bốn năm sáu bảy tám chín không lẻ linh tư lăm mốt ' +
    'cung cấp chứng từ liên quan khối lượng nguồn lâm sản kê nguyên tắc phương thức hình thức nội dung mục đích phạm vi đối tượng áp dụng quy định ' +
    'trường hợp khác nhau sau đây gồm bao gồm kèm theo phụ lục danh sách bảng biểu mã hiệu tên loại quy cách đóng gói thùng tấm cây khối mét vuông ' +
    'kg tấn chiếc cái bộ đôi cặp hộp bao túi cuộn kiện pallet hàng hoá dịch vụ sản xuất gia công nhà máy xưởng văn phòng trụ sở khu công nghiệp ' +
    'phường xã quận huyện tỉnh thành phố đường phố số nhà lô tổ ấp thôn đồng nai bình dương hồ chí minh hà nội tây ninh biên hòa').split(/\s+/);
  const baseOf = w => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').normalize('NFC');
  let dict = null, dictKey = '';
  function buildDict() {
    const key = S.pages.map(p => p.id + ':' + ((p.ocr || []).length)).join('|');
    if (dict && key === dictKey) return dict;
    const freq = new Map();
    COMMON.forEach((w, i) => { if (w) freq.set(w, (freq.get(w) || 0) + Math.max(1, 30 - i / 20)); });
    for (const pg of S.pages) for (const l of pg.ocr || []) for (const w of l.words || []) {
      const t = (w.t || '').replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase();
      if (t && (w.c ?? 80) >= 88 && /^\p{L}+$/u.test(t) && vnSyllable(t)) freq.set(t, (freq.get(t) || 0) + 6); // từ đọc chắc chắn trong chính tài liệu
    }
    const byBase = new Map();
    for (const [w, f] of freq) { const b = baseOf(w); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push([w, f]); }
    dict = { freq, byBase }; dictKey = key;
    return dict;
  }
  const lev1 = (a, b) => { // khác nhau đúng 1 ký tự (thay / thêm / bớt)
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, d = 0;
    while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++d > 1) return false; if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; } }
    return d + (a.length - i) + (b.length - j) <= 1;
  };
  const caseLike = (src, w) => src === src.toUpperCase() && /\p{Lu}/u.test(src) ? w.toUpperCase() : /^\p{Lu}/u.test(src) ? w[0].toUpperCase() + w.slice(1) : w;
  function suggest(word) {
    const core = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''); if (!core || /\p{N}/u.test(core)) return [];
    const pre = word.slice(0, word.indexOf(core)), post = word.slice(word.indexOf(core) + core.length);
    const { byBase } = buildDict(), b = baseOf(core), lo = core.toLowerCase();
    let c = (byBase.get(b) || []).filter(([w]) => w !== lo);
    if (c.length < 2) for (const [bb, arr] of byBase) if (bb !== b && lev1(bb, b)) c = c.concat(arr);
    c.sort((x, y) => y[1] - x[1]);
    return [...new Set(c.map(([w]) => pre + caseLike(core, w) + post))].filter(w => w !== word).slice(0, 4);
  }
  let panel = null;
  function closePanel() { if (panel) { panel.remove(); panel = null; } }
  // gọi sau khi mở ô sửa 1 dòng OCR: bảng gợi ý chữ + nút "Sửa cả đoạn"
  async function afterOcrEdit(v, l, t) {
    closePanel();
    const bad = typeof OCR_FLAGS !== 'undefined' && !OCR_FLAGS ? [] : (l.words || []).filter(w => ocrSuspicious(w)); // đã tắt đánh dấu từ nghi sai
    try { await markLeads(v); } catch (e) { console.warn('markLeads', e); }
    if (!t.isEditing) return; // đã thôi sửa trong lúc chờ
    const para = findParagraph(v.page, l);
    if (!bad.length && para.length < 2) return;
    const z = S.zoom, el = document.createElement('div'); el.className = 'ocr-sugg';
    const rows = bad.map((w, i) => { const sg = suggest(w.t); return `<div class="os-row" data-i="${i}"><span class="os-w">${esc(w.t)}</span> → ${sg.length ? sg.map(s => `<button data-w="${esc(w.t)}" data-r="${esc(s)}">${esc(s)}</button>`).join('') : '<i>không có gợi ý — sửa tay</i>'}</div>`; }).join('');
    el.innerHTML = (bad.length ? `<div class="os-h">Có thể đọc sai — bấm chữ đúng để thay:</div>${rows}` : '') +
      (para.length >= 2 ? `<div class="os-p"><button data-para title="Gộp ${para.length} dòng của đoạn này thành 1 ô chữ: tự xuống dòng, căn đều như bản gốc">¶ Sửa cả đoạn (${para.length} dòng)</button></div>` : '');
    Object.assign(el.style, { left: Math.max(0, l.x0 * z) + 'px', top: (l.y1 + 4) * z + 'px' });
    v.el.appendChild(el); panel = el; panel.v = v; panel.t = t;
    el.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); }); // giữ nguyên ô chữ đang sửa
    el.querySelectorAll('[data-r]').forEach(b => (b.onclick = () => {
      const w = b.dataset.w, r = b.dataset.r, i = t.text.indexOf(w); if (i < 0) return toast('Không thấy từ "' + w + '" trong dòng nữa');
      t.removeChars(i, i + w.length); t.insertChars(r, null, i);
      const st = t.styles && t.styles[0]; if (st) for (let k = i; k < i + r.length; k++) if (st[k]) { delete st[k].textBackgroundColor; if (!Object.keys(st[k]).length) delete st[k]; }
      t.selectionStart = t.selectionEnd = i + r.length; t.dirty = true; t.canvas && t.canvas.requestRenderAll();
      b.closest('.os-row').remove(); if (!el.querySelector('.os-row') && !el.querySelector('[data-para]')) closePanel();
    }));
    const pb = el.querySelector('[data-para]'); if (pb) pb.onclick = () => { closePanel(); editParagraph(v, l, t); };
  }

  /* ================= 12. sửa cả đoạn ================= */
  const BUL = /^[-–+•*·]|^\d+[.)]\s|^[a-zđ][.)]\s/i;
  // dòng có dấu đầu dòng ("-", "+", "•") mà OCR bỏ mất: nhìn thẳng vào bản scan, ngay bên trái chữ đầu dòng có nét mực không
  async function markLeads(v) {
    const pg = v.page; if (!pg.ocr || pg.ocr.every(l => l.lead != null)) return;
    const sc = 1.5, p = await getJsPage(pg), vp = p.getViewport({ scale: sc, rotation: effRot(pg) });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: x, viewport: vp }).promise;
    for (const l of pg.ocr) {
      if (l.lead != null) continue;
      const h = l.y1 - l.y0, x0 = Math.max(0, (l.x0 - h * 2.2) * sc), x1 = Math.max(0, (l.x0 - h * 0.25) * sc), y0 = (l.y0 + h * 0.15) * sc, y1 = (l.y1 - h * 0.15) * sc;
      if (x1 - x0 < 2 || y1 - y0 < 2) { l.lead = false; continue; }
      const d = x.getImageData(x0, y0, x1 - x0, y1 - y0).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 360) n++;
      l.lead = n >= 4;
    }
  }
  function findParagraph(pg, l) {
    const L0 = (pg.ocr || []).filter(x => !x.done || x === l).slice().sort((a, b) => a.y0 - b.y0);
    const h = l.y1 - l.y0, ov = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    // lề phải của văn bản: dòng đầy thường chạm gần lề phải; dòng ngắn = hết đoạn (gạch đầu dòng "-" OCR hay bỏ mất nên phải dựa vào đây)
    const xs = (pg.ocr || []).map(x => x.x1).sort((a, b) => b - a), R = xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.1))] || l.x1;
    const full = a => R - a.x1 < Math.max(h * 2.5, (R - a.x0) * 0.06) && !/:\s*$/.test(a.text);
    const fits = (a, b) => { // b là dòng ngay dưới a trong cùng đoạn?
      const gap = b.y0 - a.y1, hb = b.y1 - b.y0;
      return full(a) && /\p{L}/u.test(b.text) && gap > -h * 0.3 && gap < h * 1.1 && hb > h * 0.5 && hb < h * 1.6 && ov(a, b) > 0.4 * Math.min(a.x1 - a.x0, b.x1 - b.x0) && !BUL.test(b.text.trim()) && !b.lead;
    };
    const block = [l];
    let cur = l;
    for (;;) { const nx = L0.filter(x => x !== cur && x.y0 > cur.y0 + h * 0.5 && !block.includes(x) && ov(cur, x) > 0).sort((a, b) => a.y0 - b.y0)[0]; if (!nx || nx.done || !fits(cur, nx)) break; block.push(nx); cur = nx; }
    cur = l;
    while (!BUL.test(cur.text.trim()) && !cur.lead) { const pv = L0.filter(x => x !== cur && x.y0 < cur.y0 - h * 0.5 && !block.includes(x) && ov(cur, x) > 0).sort((a, b) => b.y0 - a.y0)[0]; if (!pv || pv.done || !fits(pv, cur)) break; block.unshift(pv); cur = pv; }
    // các dòng trong đoạn phải cùng lề trái (dòng đầu được thụt vào)
    const left = Math.min(...block.slice(1).map(x => x.x0).concat(block.length === 1 ? [l.x0] : []));
    return block.filter((x, i) => i === 0 || Math.abs(x.x0 - left) < h * 1.5);
  }
  async function editParagraph(v, l, t0) {
    const pg = v.page; await markLeads(v).catch(() => {}); const block = findParagraph(pg, l); if (block.length < 2) return;
    busy(true, 'Đang đo kiểu chữ của đoạn…');
    try {
      // bỏ ô sửa 1 dòng vừa tạo
      if (t0) { if (t0.isEditing) t0.exitEditing(); const fc = v.fc; v.loading = true; fc.remove(t0); if (t0._cover) fc.remove(t0._cover); v.loading = false; }
      const longest = block.reduce((a, b) => (b.x1 - b.x0 > a.x1 - a.x0 ? b : a));
      const base = pg.ocrBase && pg.ocrBase.v === 3 ? pg.ocrBase : null;
      const crop = await ocrLineCrop(v, longest), F = ocrFit(v, longest, crop, base, false);
      const { fs, cs, font, bold, italic, meas: ms, st } = F;
      const x0 = Math.min(...block.map(b => b.x0)), x1 = Math.max(...block.map(b => b.x1));
      // căn đều 2 bên: các dòng (trừ dòng cuối) cùng chạm lề phải
      const full = block.slice(0, -1), justify = full.length >= 1 && full.filter(b => x1 - b.x1 < fs * 0.8).length >= Math.ceil(full.length * 0.7);
      const gaps = block.slice(1).map((b, i) => b.y0 - block[i].y0).sort((a, b) => a - b), step = gaps[gaps.length >> 1] || fs * 1.3;
      // dòng đầu thụt vào → thêm dấu cách ở đầu cho giống
      const sp = ms(' ').adv * fs, indent = block[0].x0 - x0 > fs ? Math.round((block[0].x0 - x0) / Math.max(1, sp)) : 0;
      const text = ' '.repeat(indent) + block.map(b => b.text.trim()).join(' ').replace(/\s+/g, ' ');
      const W0 = crop.W, mid = a => { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
      const baseline0 = (block[0] === longest && W0.length ? mid(W0.map(q => q.y0 + ms(q.t).asc * fs)) : block[0].y0 + ms(block[0].text).asc * fs);
      const width = x1 - x0 + 1;
      const tb = new fabric.Textbox(text, { left: x0, top: baseline0 - fs * BASE_K, width, originX: 'left', originY: 'top', fontFamily: font, fontSize: fs,
        fontWeight: bold ? 'bold' : 'normal', fontStyle: italic ? 'italic' : 'normal', charSpacing: cs, lineHeight: Math.max(0.8, step / (fs * 1.13)),
        textAlign: justify ? 'justify-left' : 'left', // justify-left: dòng cuối đoạn để thường (như bản gốc) fill: crop.hex(crop.ink), kind: 'text', splitByGrapheme: false,
        ocrBlur: Math.round(Math.min(0.15, (st.blur || 0) / crop.k * 0.4) * 100) / 100, objectCaching: false });
      // xuống dòng đúng chỗ như bản gốc: phông thay thế hơi hẹp / rộng hơn → chỉnh nhẹ khoảng cách chữ cho tới khi các dòng ngắt đúng từ
      const norm = s => s.replace(/\s+/g, ' ').trim(), want = block.map(b => norm(b.text));
      const same = () => { const ls = tb._textLines.map(x => norm(x.join(''))); return ls.length === want.length && ls.every((x, i) => x === want[i]); };
      if (!same()) {
        let ok = false;
        for (const d of [8, -8, 16, -16, 24, -24, 32, -32, 44, -44, 60, -60, 80]) { tb.set({ charSpacing: cs + d }); tb.initDimensions(); if (same()) { ok = true; break; } }
        if (!ok) { tb.set({ charSpacing: cs }); tb.initDimensions(); }
      }
      const v2 = S.views.get(pg.id) || v, fc = v2.fc;
      v2.loading = true;
      for (const b of block) {
        const hb = b.y1 - b.y0;
        fc.add(new fabric.Rect({ left: b.x0 - 1.5, top: b.y0 - 1.2, width: b.x1 - b.x0 + 3, height: hb + 2.4, fill: crop.hex(crop.paper), strokeWidth: 0, kind: 'whiteout', originX: 'left', originY: 'top' }));
        b.done = true;
      }
      fc.add(tb); v2.loading = false;
      ensureFontOption(font);
      setTool('select'); fc.setActiveObject(tb); tb.enterEditing(); tb.selectionStart = tb.selectionEnd = tb.text.length; tb._updateTextarea && tb._updateTextarea();
      fc.requestRenderAll(); drawOcrFlags(v2); syncView(v2); S.activeView = v2; refreshProps();
      toast(`Đang sửa cả đoạn (${block.length} dòng${justify ? ', căn đều 2 bên' : ''}) — chữ tự xuống dòng; kéo cạnh khung để đổi độ rộng`, 5000);
    } catch (e) { console.error(e); toast('Không gộp được đoạn này'); }
    finally { busy(false); }
  }

  /* ---------- nút "OCR cả file" ---------- */
  function initUI() {
    const ocr = $('#opOcr');
    if (ocr && !$('#opOcrAll')) {
      const b = document.createElement('button'); b.id = 'opOcrAll'; b.style.gridColumn = 'span 2';
      b.title = 'Nhận dạng chữ mọi trang scan trong file → khi lưu, PDF tìm được chữ (Ctrl+F) và bôi đen copy được';
      b.innerHTML = '<i class="ico k-coral"><span class="ti ti-file-search"></span></i>OCR cả file (tìm được chữ)';
      b.onclick = ocrAll; ocr.after(b);
    }
  }
  // (nút "OCR cả file" đã bỏ theo yêu cầu — hàm ocrAll vẫn giữ để dùng lại khi cần)
  return { ocrAll, hiddenTextObjs, measureDown, measureMove, measureUp, clearMeasure, suggest, afterOcrEdit, closePanel, findParagraph, editParagraph, markLeads };
})();
window.PdfExtra = PdfExtra;
