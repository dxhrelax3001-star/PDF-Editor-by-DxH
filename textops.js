'use strict';
/* Đọc content stream của trang PDF (pdf-lib), tìm từng ký tự nằm trong vùng cần sửa:
   - analyze: trả về thông tin phông / cỡ / màu của các ký tự đó
   - strip:   xoá thật các ký tự đó khỏi trang (thay bằng khoảng dịch tương đương để chữ khác không bị xô lệch)
   Vùng (regions) tính trong hệ toạ độ user space của trang PDF: {x0,y0,x1,y1}. */
const TextOps = (() => {
  const P = PDFLib;
  const N = s => P.PDFName.of(s);
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
  const latin1 = (b, s, e) => { let r = ''; for (let i = s; i < e; i++) r += String.fromCharCode(b[i]); return r; };

  /* ---------- tách lệnh trong content stream ---------- */
  function parse(b) {
    const ops = []; const n = b.length; let i = 0, stack = [], stackStart = 0;
    const skipWS = () => { for (;;) { while (i < n && WS.has(b[i])) i++; if (i < n && b[i] === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } break; } };
    const hexv = c => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);
    function readLiteral() {
      i++; let depth = 1; const out = [];
      while (i < n) {
        const c = b[i++];
        if (c === 92) {
          const d = b[i++];
          if (d === 110) out.push(10); else if (d === 114) out.push(13); else if (d === 116) out.push(9);
          else if (d === 98) out.push(8); else if (d === 102) out.push(12);
          else if (d === 13) { if (b[i] === 10) i++; } else if (d === 10) { /* nối dòng */ }
          else if (d >= 48 && d <= 55) { let v = d - 48; for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48); out.push(v & 255); }
          else out.push(d);
        } else if (c === 40) { depth++; out.push(c); }
        else if (c === 41) { if (--depth === 0) break; out.push(c); }
        else out.push(c);
      }
      return { str: Uint8Array.from(out) };
    }
    function readHex() {
      i++; const out = []; let hi = -1;
      while (i < n && b[i] !== 62) { const v = hexv(b[i++]); if (v < 0) continue; if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; } }
      i++; if (hi >= 0) out.push(hi * 16);
      return { str: Uint8Array.from(out) };
    }
    function readValue() {
      const c = b[i];
      if (c === 40) return readLiteral();
      if (c === 60) {
        if (b[i + 1] === 60) { i += 2; const d = {}; for (;;) { skipWS(); if (i >= n) break; if (b[i] === 62 && b[i + 1] === 62) { i += 2; break; } const k = readValue(); skipWS(); const v = readValue(); if (k && k.name) d[k.name] = v; } return { dict: d }; }
        return readHex();
      }
      if (c === 91) { i++; const arr = []; for (;;) { skipWS(); if (i >= n) break; if (b[i] === 93) { i++; break; } arr.push(readValue()); } return arr; }
      if (c === 47) { i++; const s = i; while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++; return { name: latin1(b, s, i).replace(/#([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))) }; }
      const s = i; while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      if (i === s) { i++; return { kw: String.fromCharCode(c) }; }
      const t = latin1(b, s, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return +t;
      if (t === 'true') return true; if (t === 'false') return false; if (t === 'null') return null;
      return { kw: t };
    }
    for (;;) {
      skipWS(); if (i >= n) break;
      const s = i; const v = readValue();
      if (v && typeof v === 'object' && !Array.isArray(v) && 'kw' in v) {
        const start = stack.length ? stackStart : s;
        if (v.kw === 'BI') { // ảnh nội tuyến: bỏ qua phần nhị phân
          for (;;) { skipWS(); if (i >= n) break; const t = readValue(); if (t && t.kw === 'ID') break; }
          i++;
          let j = i;
          for (; j < n - 1; j++) if (b[j] === 69 && b[j + 1] === 73 && WS.has(b[j - 1]) && (j + 2 >= n || WS.has(b[j + 2]) || DELIM.has(b[j + 2]))) break;
          i = Math.min(n, j + 2);
          ops.push({ op: 'BI', args: [], start, end: i }); stack = []; continue;
        }
        ops.push({ op: v.kw, args: stack, start, end: i }); stack = [];
      } else { if (!stack.length) stackStart = s; stack.push(v); }
    }
    return ops;
  }

  /* ---------- ma trận ---------- */
  const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];
  const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];

  /* ---------- phông: độ rộng ký tự, tên, đậm/nghiêng ---------- */
  const num = o => (o instanceof P.PDFNumber ? o.asNumber() : typeof o === 'number' ? o : undefined);
  const nameOf = o => (o instanceof P.PDFName ? o.toString().slice(1).replace(/#([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))) : '');
  const arr = o => (o instanceof P.PDFArray ? o.asArray().map((_, k) => o.lookup(k)) : []);
  // đậm / nghiêng đọc từ chính phông TrueType nhúng: head.macStyle (bit0 đậm, bit1 nghiêng), OS/2 (usWeightClass, fsSelection)
  function fontStyleFromProgram(desc) {
    try {
      const st = desc.lookup(N('FontFile2')); if (!(st instanceof P.PDFStream)) return null;
      const d = st instanceof P.PDFRawStream ? P.decodePDFRawStream(st).decode() : st.getContents();
      const u16 = o => (d[o] << 8) | d[o + 1], u32 = o => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
      const v = u32(0); if (v !== 0x00010000 && v !== 0x74727565) return null;
      let mac = null, wt = null, sel = null; const nt = u16(4);
      for (let i = 0; i < nt; i++) {
        const r = 12 + i * 16, tag = String.fromCharCode(d[r], d[r + 1], d[r + 2], d[r + 3]), off = u32(r + 8);
        if (tag === 'head' && off + 46 <= d.length) mac = u16(off + 44);
        if (tag === 'OS/2' && off + 64 <= d.length) { wt = u16(off + 4); sel = u16(off + 62); }
      }
      if (mac == null && wt == null) return null;
      return { bold: (wt != null && wt >= 600 && wt <= 1000) || (sel != null && !!(sel & 0x20)) || (mac != null && !!(mac & 1)), italic: (sel != null && !!(sel & 1)) || (mac != null && !!(mac & 2)) };
    } catch (e) { return null; }
  }
  function fontInfo(fd) {
    const info = { type0: false, widths: new Map(), dflt: 500, scale: 1, base: '', bold: false, italic: false, std: null };
    if (!(fd instanceof P.PDFDict)) return info;
    const sub = nameOf(fd.lookup(N('Subtype')));
    info.base = nameOf(fd.lookup(N('BaseFont'))).replace(/^[A-Z]{6}\+/, '');
    let desc = fd.lookup(N('FontDescriptor'));
    if (sub === 'Type0') {
      info.type0 = true;
      const df = arr(fd.lookup(N('DescendantFonts')))[0];
      if (df instanceof P.PDFDict) {
        desc = df.lookup(N('FontDescriptor')) || desc;
        info.dflt = num(df.lookup(N('DW'))) ?? 1000;
        const W = arr(df.lookup(N('W')));
        for (let k = 0; k < W.length;) {
          const c = num(W[k]); const nx = W[k + 1];
          if (nx instanceof P.PDFArray) { arr(nx).forEach((w, j) => info.widths.set(c + j, num(w))); k += 2; }
          else { const c2 = num(nx), w = num(W[k + 2]); for (let q = c; q <= c2 && q - c < 65536; q++) info.widths.set(q, w); k += 3; }
        }
      }
    } else {
      const fc = num(fd.lookup(N('FirstChar'))) ?? 0;
      const ws = arr(fd.lookup(N('Widths')));
      ws.forEach((w, j) => info.widths.set(fc + j, num(w)));
      if (sub === 'Type3') { const fm = arr(fd.lookup(N('FontMatrix'))); info.scale = (num(fm[0]) || 0.001) * 1000; }
      if (!ws.length) { try { info.std = P.StandardFontEmbedder.for(info.base.replace(/,/g, '-')); } catch (e) { info.std = null; } }
    }
    if (desc instanceof P.PDFDict) {
      const mw = num(desc.lookup(N('MissingWidth'))); if (mw && !info.type0) info.dflt = mw;
      const flags = num(desc.lookup(N('Flags'))) || 0, fw = num(desc.lookup(N('FontWeight'))) || 0, ia = num(desc.lookup(N('ItalicAngle'))) || 0;
      // ưu tiên dữ liệu thật trong phông nhúng (vài phần mềm ghi FontWeight sai, vd Kingsoft: 1562, 195)
      const prog = fontStyleFromProgram(desc);
      if (prog) { info.bold = prog.bold; info.italic = prog.italic || !!ia; }
      else {
        if (flags & 64 || ia) info.italic = true;
        if (flags & 262144 || (fw >= 600 && fw <= 1000)) info.bold = true;
      }
    }
    if (/bold|black|heavy|semibold|demi/i.test(info.base)) info.bold = true;
    if (/italic|oblique|it$/i.test(info.base.split(/[-,]/).slice(1).join('-')) || /italic|oblique/i.test(info.base)) info.italic = true;
    return info;
  }
  function width(fi, code) {
    if (fi.widths.has(code)) return fi.widths.get(code) * fi.scale;
    if (fi.std) { try { return fi.std.widthOfTextAtSize(String.fromCharCode(code), 1000); } catch (e) {} }
    return fi.dflt * fi.scale;
  }

  /* ---------- nội dung trang ---------- */
  function contentBytes(doc, page) {
    const c = page.node.Contents(); if (!c) return new Uint8Array(0);
    const streams = c instanceof P.PDFArray ? c.asArray().map(r => doc.context.lookup(r)) : [c];
    const parts = streams.map(s => {
      if (s instanceof P.PDFRawStream) return P.decodePDFRawStream(s).decode();
      if (s && s.getUnencodedContents) return s.getUnencodedContents();
      return new Uint8Array(0);
    });
    const total = parts.reduce((a, p) => a + p.length + 1, 0), out = new Uint8Array(total); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
    return out;
  }
  const fmt = v => (Math.round(v * 1000) / 1000).toString();
  const hex = b => '<' + [...b].map(x => x.toString(16).padStart(2, '0')).join('') + '>';

  function streamBytes(s) {
    if (s instanceof P.PDFRawStream) return P.decodePDFRawStream(s).decode();
    if (s && s.getUnencodedContents) return s.getUnencodedContents();
    return new Uint8Array(0);
  }
  function applyEdits(bytes, edits) {
    edits = edits.slice().sort((x, y) => x.start - y.start);
    const chunks = []; let pos = 0, total = 0;
    for (const e of edits) { chunks.push(bytes.subarray(pos, e.start)); chunks.push(Uint8Array.from(e.text, ch => ch.charCodeAt(0))); pos = e.end; }
    chunks.push(bytes.subarray(pos));
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  // khung bao (user space) của ảnh vẽ bằng ma trận M (ảnh luôn là hình vuông đơn vị 0..1)
  function unitBBox(M) {
    const cs = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(M, x, y));
    return { x0: Math.min(...cs.map(c => c[0])), y0: Math.min(...cs.map(c => c[1])), x1: Math.max(...cs.map(c => c[0])), y1: Math.max(...cs.map(c => c[1])) };
  }

  const pdfText = o => { try { return o && o.decodeText ? o.decodeText() : (o instanceof P.PDFName ? nameOf(o) : ''); } catch (e) { return ''; } };
  // tên các lớp (OCG) mà một /OC (OCG hoặc OCMD) tham chiếu
  function ocgNames(o) {
    if (!(o instanceof P.PDFDict)) return [];
    if (nameOf(o.lookup(N('Type'))) === 'OCMD') {
      const g = o.lookup(N('OCGs'));
      const list = g instanceof P.PDFArray ? arr(g) : g ? [g] : [];
      return list.flatMap(x => ocgNames(x));
    }
    const n = pdfText(o.lookup(N('Name')));
    return n ? [n] : [];
  }

  /* Duyệt một content stream (trang hoặc Form XObject).
     opt.regions: vùng cần xoá — chữ {x0,y0,x1,y1}, ảnh {img:true,...}, nét vẽ {vec:true,...,n}
     opt.strip: sửa luôn Form XObject con; opt.rm: {watermark, layers:[tên lớp]} xoá hình mờ / lớp
     opt.col: {paths:[], wm:0, layers:Map} — thu thập nét vẽ, đếm hình mờ / lớp */
  function exec(doc, bytes, res, ctm0, fill0, opt, depth) {
    const regions = opt.regions || [], rm = opt.rm || {}, rmLayers = new Set(rm.layers || []), col = opt.col;
    const ops = parse(bytes);
    const dict = (k) => (res instanceof P.PDFDict ? res.lookup(N(k)) : null);
    const fontsDict = dict('Font'), xobjs = dict('XObject'), props = dict('Properties'), extg = dict('ExtGState');
    const fcache = new Map();
    const getFont = name => {
      if (!fcache.has(name)) fcache.set(name, fontInfo(fontsDict instanceof P.PDFDict ? fontsDict.lookup(N(name)) : null));
      return fcache.get(name);
    };
    let gs = { ctm: ctm0.slice(), fill: fill0.slice(), stroke: [0, 0, 0], fa: 1, sa: 1, lw: 1, cap: 0, join: 0, dash: [], Tc: 0, Tw: 0, Th: 1, TL: 0, font: null, Tfs: 0, rise: 0, mode: 0 };
    const stack = []; let Tm = [1, 0, 0, 1, 0, 0], Tlm = [1, 0, 0, 1, 0, 0];
    const edits = [], hits = [];
    const marks = []; let suppress = 0; // khối BDC..EMC đang bị xoá
    let path = null;
    const inRegion = (x, y) => regions.findIndex(r => !r.img && !r.vec && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    const imgMatch = bb => regions.findIndex(r => r.img && Math.abs(r.x0 - bb.x0) < 1.5 && Math.abs(r.y0 - bb.y0) < 1.5 && Math.abs(r.x1 - bb.x1) < 1.5 && Math.abs(r.y1 - bb.y1) < 1.5);
    const vecMatch = (bb, n) => regions.findIndex(r => r.vec && r.n === n && Math.abs(r.x0 - bb.x0) < 0.6 && Math.abs(r.y0 - bb.y0) < 0.6 && Math.abs(r.x1 - bb.x1) < 0.6 && Math.abs(r.y1 - bb.y1) < 0.6);
    // ảnh được sửa tại chỗ (region.ref = ảnh mới đã nhúng): thay lệnh vẽ ảnh cũ bằng ảnh mới, giữ đúng vị trí và thứ tự lớp
    const imgReplace = ri => {
      const r = regions[ri]; if (!r.ref || !opt.strip || !(res instanceof P.PDFDict)) return ' ';
      let xd = res.lookup(N('XObject'));
      if (!(xd instanceof P.PDFDict)) { xd = doc.context.obj({}); res.set(N('XObject'), xd); }
      const nm = 'EdIm' + r.ref.objectNumber; xd.set(N(nm), r.ref);
      return ` /${nm} Do `;
    };
    const cmyk = (c, m, y, k) => [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    const toRGB = a => { const v = a.filter(x => typeof x === 'number'); return v.length === 1 ? [v[0], v[0], v[0]] : v.length === 3 ? v : v.length === 4 ? cmyk(...v) : null; };
    const setFill = a => { const c = toRGB(a); if (c) gs.fill = c; };
    const setStroke = a => { const c = toRGB(a); if (c) gs.stroke = c; };
    const td = (x, y) => { Tlm = mul([1, 0, 0, 1, x, y], Tlm); Tm = Tlm.slice(); };
    const scaleOf = M => Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) || 1;

    function show(op, items, prefix) {
      if (!gs.font) return;
      const fi = getFont(gs.font), bpc = fi.type0 ? 2 : 1;
      const out = []; let kept = [], removed = 0;
      const flush = () => { if (kept.length) { out.push(Uint8Array.from(kept)); kept = []; } };
      const pushNum = v => { if (typeof out[out.length - 1] === 'number') out[out.length - 1] += v; else out.push(v); };
      const scale = gs.Tfs * gs.Th;
      for (const it of items) {
        if (typeof it === 'number') { flush(); pushNum(it); Tm = mul([1, 0, 0, 1, -it / 1000 * scale, 0], Tm); continue; }
        if (!it || !it.str) continue;
        const s = it.str;
        for (let k = 0; k < s.length; k += bpc) {
          const code = bpc === 2 ? (s[k] << 8) | (s[k + 1] || 0) : s[k];
          const w = width(fi, code);
          const adv = (w / 1000 * gs.Tfs + gs.Tc + (bpc === 1 && code === 32 ? gs.Tw : 0)) * gs.Th;
          const M = mul(Tm, gs.ctm);
          const [ux, uy] = apply(M, adv / 2, gs.Tfs * 0.3 + gs.rise);
          const ri = regions.length && !suppress ? inRegion(ux, uy) : -1;
          if (ri >= 0) {
            removed++; flush();
            if (scale) pushNum(-adv / scale * 1000);
            const [sx, sy] = apply(M, 0, gs.rise), [ex, ey] = apply(M, adv, gs.rise);
            hits.push({ font: fi.base, bold: fi.bold, italic: fi.italic, size: Math.abs(gs.Tfs) * Math.hypot(M[2], M[3]), color: gs.fill.slice(), x0: sx, y0: sy, x1: ex, y1: ey, code, space: bpc === 1 && code === 32, ri,
              // chế độ vẽ chữ (Tr): 1 = chỉ viền, 2 = tô + viền ("đậm giả"); nét viền theo đơn vị trang
              mode: gs.mode, lw: gs.lw * Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])), strokeColor: gs.stroke.slice() });
          } else for (let q = 0; q < bpc; q++) kept.push(s[k + q] ?? 0);
          Tm = mul([1, 0, 0, 1, adv, 0], Tm);
        }
      }
      flush();
      if (removed) edits.push({ start: op.start, end: op.end, text: ` ${prefix}[${out.map(v => (typeof v === 'number' ? fmt(v) : hex(v))).join(' ')}] TJ ` });
    }
    function doXObject(op, name) {
      if (!(xobjs instanceof P.PDFDict)) return;
      const ref = xobjs.get(N(name)); const xo = ref instanceof P.PDFRef ? doc.context.lookup(ref) : ref;
      if (!xo || !xo.dict) return;
      const oc = ocgNames(xo.dict.lookup(N('OC')));
      if (col && !suppress) oc.forEach(n => col.layers.set(n, (col.layers.get(n) || 0) + 1));
      if (oc.some(n => rmLayers.has(n))) { if (!suppress) edits.push({ start: op.start, end: op.end, text: ' ' }); return; }
      if (suppress) return;
      const st = nameOf(xo.dict.lookup(N('Subtype')));
      if (st === 'Image') {
        const ri = imgMatch(unitBBox(gs.ctm));
        if (ri >= 0) { hits.push({ img: true, ri }); edits.push({ start: op.start, end: op.end, text: imgReplace(ri) }); }
      } else if (st === 'Form' && depth < 6) {
        const m = arr(xo.dict.lookup(N('Matrix'))).map(num);
        const M = m.length === 6 && m.every(x => typeof x === 'number') ? m : [1, 0, 0, 1, 0, 0];
        const fres = xo.dict.lookup(N('Resources')) || res;
        let fbytes; try { fbytes = streamBytes(xo); } catch (e) { return; }
        const sub = exec(doc, fbytes, fres, mul(M, gs.ctm), gs.fill, opt, depth + 1);
        hits.push(...sub.hits);
        if (opt.strip && sub.edits.length && ref instanceof P.PDFRef) {
          const ns = doc.context.flateStream(applyEdits(fbytes, sub.edits));
          for (const [k, v] of xo.dict.entries()) { const kn = k.toString(); if (kn !== '/Length' && kn !== '/Filter' && kn !== '/DecodeParms') ns.dict.set(k, v); }
          doc.context.assign(ref, ns);
        }
      }
    }
    // khối nội dung đánh dấu: hình mờ chuẩn (/Artifact /Subtype /Watermark) và lớp (/OC)
    function beginMarked(op) {
      const tag = op.args[0] && op.args[0].name, p = op.args[1];
      let pd = null, inl = null;
      if (p && p.name && props instanceof P.PDFDict) pd = props.lookup(N(p.name));
      else if (p && p.dict) inl = p.dict;
      let isWM = false, layers = [];
      if (tag === 'Artifact') {
        const sub = inl ? (inl.Subtype && inl.Subtype.name) : pd instanceof P.PDFDict ? nameOf(pd.lookup(N('Subtype'))) : '';
        isWM = sub === 'Watermark';
      } else if (tag === 'OC' && pd) layers = ocgNames(pd);
      if (col && !suppress) { if (isWM) col.wm++; layers.forEach(n => col.layers.set(n, (col.layers.get(n) || 0) + 1)); }
      const remove = (isWM && rm.watermark) || layers.some(n => rmLayers.has(n));
      marks.push({ start: op.start, remove });
      if (remove) suppress++;
    }
    function endMarked(op) {
      const m = marks.pop(); if (!m || !m.remove) return;
      suppress--;
      if (suppress) return;
      for (let i = edits.length - 1; i >= 0; i--) if (edits[i].start >= m.start) edits.splice(i, 1);
      edits.push({ start: m.start, end: op.end, text: ' ' });
    }
    // nét vẽ (đường kẻ, khung, bảng, hình)
    const addPt = (x, y) => apply(gs.ctm, x, y);
    function pathOp(op) {
      if (!path) path = { subs: [], start: op.start, clip: false };
      const a = op.args, subs = path.subs, cur = subs[subs.length - 1];
      const ensure = () => { if (!subs.length) subs.push({ segs: [['M', 0, 0]], closed: false }); return subs[subs.length - 1]; };
      switch (op.op) {
        case 'm': subs.push({ segs: [['M', ...addPt(+a[0], +a[1])]], closed: false }); break;
        case 'l': ensure().segs.push(['L', ...addPt(+a[0], +a[1])]); break;
        case 'c': ensure().segs.push(['C', ...addPt(+a[0], +a[1]), ...addPt(+a[2], +a[3]), ...addPt(+a[4], +a[5])]); break;
        case 'v': { const s = ensure(), last = s.segs[s.segs.length - 1]; s.segs.push(['C', last[last.length - 2], last[last.length - 1], ...addPt(+a[0], +a[1]), ...addPt(+a[2], +a[3])]); break; }
        case 'y': { const e = addPt(+a[2], +a[3]); ensure().segs.push(['C', ...addPt(+a[0], +a[1]), ...e, ...e]); break; }
        case 'h': if (cur) cur.closed = true; break;
        case 're': {
          const x = +a[0], y = +a[1], w = +a[2], h = +a[3];
          subs.push({ segs: [['M', ...addPt(x, y)], ['L', ...addPt(x + w, y)], ['L', ...addPt(x + w, y + h)], ['L', ...addPt(x, y + h)]], closed: true });
          break;
        }
      }
    }
    function paint(op) {
      const pth = path; path = null;
      if (!pth || op.op === 'n' || suppress) return;
      const o = op.op;
      if ((o === 's' || o === 'b' || o === 'b*') && pth.subs.length) pth.subs[pth.subs.length - 1].closed = true;
      const stroke = /^[SsBb]/.test(o), fill = /^[fFBb]/.test(o);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
      for (const s of pth.subs) for (const g of s.segs) { n++; for (let i = 1; i < g.length; i += 2) { x0 = Math.min(x0, g[i]); x1 = Math.max(x1, g[i]); y0 = Math.min(y0, g[i + 1]); y1 = Math.max(y1, g[i + 1]); } }
      if (!n || !isFinite(x0)) return;
      const bb = { x0, y0, x1, y1 };
      const sc = scaleOf(gs.ctm);
      if (col) col.paths.push({ subs: pth.subs, stroke, fill, evenOdd: o.endsWith('*'), sc: gs.stroke.slice(), fc: gs.fill.slice(), sa: gs.sa, fa: gs.fa,
        lw: gs.lw * sc, cap: gs.cap, join: gs.join, dash: gs.dash.map(d => d * sc), bb, n });
      const ri = regions.length ? vecMatch(bb, n) : -1;
      if (ri >= 0) {
        hits.push({ vec: true, ri });
        edits.push({ start: pth.start, end: op.end, text: pth.clip ? ' ' + latin1(bytes, pth.start, op.start) + ' n ' : ' ' });
      }
    }
    function setExtGState(name) {
      const g = extg instanceof P.PDFDict ? extg.lookup(N(name)) : null; if (!(g instanceof P.PDFDict)) return;
      const v = k => num(g.lookup(N(k)));
      if (v('LW') !== undefined) gs.lw = v('LW'); if (v('LC') !== undefined) gs.cap = v('LC'); if (v('LJ') !== undefined) gs.join = v('LJ');
      if (v('CA') !== undefined) gs.sa = v('CA'); if (v('ca') !== undefined) gs.fa = v('ca');
    }

    for (const op of ops) {
      const a = op.args;
      switch (op.op) {
        case 'q': stack.push({ ...gs, ctm: gs.ctm.slice(), fill: gs.fill.slice(), stroke: gs.stroke.slice(), dash: gs.dash.slice() }); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': if (a.length === 6) gs.ctm = mul(a, gs.ctm); break;
        case 'g': case 'rg': case 'k': case 'sc': case 'scn': setFill(a); break;
        case 'G': case 'RG': case 'K': case 'SC': case 'SCN': setStroke(a); break;
        case 'cs': gs.fill = [0, 0, 0]; break;
        case 'CS': gs.stroke = [0, 0, 0]; break;
        case 'w': gs.lw = +a[0] || 0; break;
        case 'J': gs.cap = +a[0] || 0; break;
        case 'j': gs.join = +a[0] || 0; break;
        case 'd': gs.dash = Array.isArray(a[0]) ? a[0].filter(x => typeof x === 'number') : []; break;
        case 'gs': if (a[0] && a[0].name) setExtGState(a[0].name); break;
        case 'm': case 'l': case 'c': case 'v': case 'y': case 'h': case 're': pathOp(op); break;
        case 'W': case 'W*': if (path) path.clip = true; break;
        case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n': paint(op); break;
        case 'BDC': beginMarked(op); break;
        case 'BMC': marks.push({ start: op.start, remove: false }); break;
        case 'EMC': endMarked(op); break;
        case 'BT': Tm = [1, 0, 0, 1, 0, 0]; Tlm = [1, 0, 0, 1, 0, 0]; break;
        case 'Tf': gs.font = a[0] && a[0].name; gs.Tfs = +a[1] || 0; break;
        case 'Tc': gs.Tc = +a[0] || 0; break;
        case 'Tw': gs.Tw = +a[0] || 0; break;
        case 'Tz': gs.Th = (+a[0] || 0) / 100; break;
        case 'TL': gs.TL = +a[0] || 0; break;
        case 'Ts': gs.rise = +a[0] || 0; break;
        case 'Tr': gs.mode = +a[0] || 0; break;
        case 'Td': td(+a[0] || 0, +a[1] || 0); break;
        case 'TD': gs.TL = -(+a[1] || 0); td(+a[0] || 0, +a[1] || 0); break;
        case 'Tm': if (a.length === 6) { Tlm = a.slice(); Tm = a.slice(); } break;
        case 'T*': td(0, -gs.TL); break;
        case 'Tj': show(op, [a[0]], ''); break;
        case 'TJ': show(op, Array.isArray(a[0]) ? a[0] : [], ''); break;
        case "'": td(0, -gs.TL); show(op, [a[0]], 'T* '); break;
        case '"': gs.Tw = +a[0] || 0; gs.Tc = +a[1] || 0; td(0, -gs.TL); show(op, [a[2]], `${fmt(gs.Tw)} Tw ${fmt(gs.Tc)} Tc T* `); break;
        case 'Do': if (a[0] && a[0].name) doXObject(op, a[0].name); break;
        case 'BI': { if (suppress) break; const ri = imgMatch(unitBBox(gs.ctm)); if (ri >= 0) { hits.push({ img: true, ri }); edits.push({ start: op.start, end: op.end, text: imgReplace(ri) }); } break; }
      }
    }
    return { edits, hits };
  }
  function run(doc, page, opt) {
    const bytes = contentBytes(doc, page);
    const r = exec(doc, bytes, page.node.Resources(), [1, 0, 0, 1, 0, 0], [0, 0, 0], opt, 0);
    return { bytes, edits: r.edits, hits: r.hits };
  }
  const rmActive = rm => !!(rm && (rm.watermark || (rm.layers && rm.layers.length)));
  function watermarkAnnots(page, remove) {
    const an = page.node.Annots(); if (!(an instanceof P.PDFArray)) return 0;
    const keep = [], refs = an.asArray(); let n = 0;
    for (let i = 0; i < refs.length; i++) { const d = an.lookup(i); if (d instanceof P.PDFDict && nameOf(d.lookup(N('Subtype'))) === 'Watermark') n++; else keep.push(refs[i]); }
    if (remove && n) page.node.set(N('Annots'), page.doc.context.obj(keep));
    return n;
  }

  /* Phân tích (không sửa) — lấy phông/cỡ/màu của chữ, hoặc kiểm tra ảnh / nét vẽ có gỡ được không */
  function analyze(doc, page, regions, rm) { return run(doc, page, { regions, rm }).hits; }
  /* Danh sách nét vẽ trên trang (bỏ qua phần đã xoá theo rm) */
  function vectors(doc, page, rm) { const col = { paths: [], wm: 0, layers: new Map() }; run(doc, page, { rm, col }); return col.paths; }
  /* Đếm hình mờ chuẩn, chú thích Watermark, các lớp */
  function scan(doc, page) {
    const col = { paths: [], wm: 0, layers: new Map() }; run(doc, page, { col });
    return { wm: col.wm, wmAnnots: watermarkAnnots(page, false), layers: col.layers };
  }
  /* Xoá thật các ký tự / ảnh / nét vẽ trong vùng, hình mờ, lớp khỏi trang (kể cả trong Form XObject) */
  function strip(doc, page, regions, rm) {
    regions = regions || [];
    // vùng {clip:true}: cắt bỏ (không vẽ) mọi thứ trong khung — phần nét vẽ / ảnh nằm vắt qua khung cũng bị cắt sạch
    const clips = regions.filter(r => r.clip); regions = regions.filter(r => !r.clip);
    if (!regions.length && !clips.length && !rmActive(rm)) return 0;
    const { bytes, edits, hits } = run(doc, page, { regions, rm, strip: true });
    if (edits.length || clips.length) {
      let out = edits.length ? applyEdits(bytes, edits) : bytes;
      if (clips.length) {
        const f = x => (Math.round(x * 1000) / 1000).toString();
        const pre = clips.map(c => `q -100000 -100000 200000 200000 re ${f(c.x0)} ${f(c.y0)} ${f(c.x1 - c.x0)} ${f(c.y1 - c.y0)} re W* n\n`).join('');
        const enc = s => Uint8Array.from(s, ch => ch.charCodeAt(0)), a = enc(pre), b = enc('\n' + 'Q\n'.repeat(clips.length));
        const all = new Uint8Array(a.length + out.length + b.length); all.set(a, 0); all.set(out, a.length); all.set(b, a.length + out.length); out = all;
      }
      const ref = doc.context.register(doc.context.flateStream(out));
      page.node.set(N('Contents'), ref);
    }
    if (rm && rm.watermark) watermarkAnnots(page, true);
    return hits.length + edits.length;
  }

  /* Tìm chỗ tách "nền" (ảnh / mảng tô phủ >= 50% trang vẽ đầu tiên) với phần nội dung còn lại trong content stream của trang.
     Trả về { bytes, offset, ctm }: offset = vị trí byte ở cấp ngoài cùng (q/Q cân bằng, ngoài BT..ET) ngay sau phần nền;
     ctm = ma trận tích luỹ tại đó. offset = 0 nếu trang không có nền hoặc nền không tách riêng được. */
  function bgSplit(doc, page) {
    const bytes = contentBytes(doc, page), ops = parse(bytes);
    const mb = page.getCropBox(), area = mb.width * mb.height;
    const res = page.node.Resources(), xobjs = res instanceof P.PDFDict ? res.lookup(N('XObject')) : null;
    let ctm = [1, 0, 0, 1, 0, 0], depth = 0, inText = false, bb = null;
    const st = [];
    let lastBg = null;
    const big = b => b && (b.x1 - b.x0) * (b.y1 - b.y0) >= area * 0.5;
    const grow = (x, y) => { const [u, w] = apply(ctm, x, y); if (!bb) bb = { x0: u, y0: w, x1: u, y1: w }; else { bb.x0 = Math.min(bb.x0, u); bb.x1 = Math.max(bb.x1, u); bb.y0 = Math.min(bb.y0, w); bb.y1 = Math.max(bb.y1, w); } };
    // trả về true nếu là nét vẽ "nền", false nếu là nội dung thường, null nếu không vẽ gì
    const paintKind = op => {
      const o = op.op, a = op.args;
      if (o === 'Tj' || o === 'TJ' || o === "'" || o === '"' || o === 'sh') return false;
      if (o === 'BI') return big(unitBBox(ctm));
      if (o === 'Do') {
        const ref = xobjs instanceof P.PDFDict && a[0] && a[0].name ? xobjs.get(N(a[0].name)) : null;
        const xo = ref instanceof P.PDFRef ? doc.context.lookup(ref) : ref;
        if (!xo || !xo.dict) return null;
        return nameOf(xo.dict.lookup(N('Subtype'))) === 'Image' ? big(unitBBox(ctm)) : false;
      }
      if (/^(f|F|f\*|B|B\*|b|b\*)$/.test(o)) { const r = big(bb); bb = null; return r; }
      if (/^(S|s)$/.test(o)) { bb = null; return false; }
      if (o === 'n') { bb = null; return null; }
      return null;
    };
    for (const op of ops) {
      const o = op.op, a = op.args;
      if (o === 'q') { st.push(ctm); depth++; continue; }
      if (o === 'Q') { ctm = st.pop() || [1, 0, 0, 1, 0, 0]; depth = Math.max(0, depth - 1); continue; }
      if (o === 'cm' && a.length === 6) { ctm = mul(a, ctm); continue; }
      if (o === 'BT') { inText = true; continue; }
      if (o === 'ET') { inText = false; continue; }
      if (o === 'm' || o === 'l') { grow(+a[0], +a[1]); continue; }
      if (o === 'c') { grow(+a[0], +a[1]); grow(+a[2], +a[3]); grow(+a[4], +a[5]); continue; }
      if (o === 'v' || o === 'y') { grow(+a[0], +a[1]); grow(+a[2], +a[3]); continue; }
      if (o === 're') { const x = +a[0], y = +a[1], w = +a[2], h = +a[3]; grow(x, y); grow(x + w, y); grow(x, y + h); grow(x + w, y + h); continue; }
      // nền = ảnh / mảng tô phủ >= 50% trang; lấy cái vẽ SAU CÙNG (nét vẽ trước nó đằng nào cũng bị nó che)
      if (paintKind(op) === true && !inText) lastBg = { offset: op.end, ctm: ctm.slice(), stack: st.map(m => m.slice()) };
    }
    if (!lastBg) return { bytes, offset: 0, ctm: [1, 0, 0, 1, 0, 0], stack: [] };
    return { bytes, ...lastBg };
  }
  /* lệnh mở lại đúng các mức q và ma trận tại chỗ tách (để vẽ riêng phần sau chỗ tách) */
  function reopenPrefix(sp) {
    const levels = [...sp.stack, sp.ctm], f = M => M.map(n => +n.toFixed(6)).join(' ') + ' cm';
    const inv = m => { const [a, b, c, d, e, g] = m, det = a * d - b * c; return [d / det, -b / det, -c / det, a / det, (c * g - d * e) / det, (b * e - a * g) / det]; };
    let s = f(levels[0]) + '\n';
    for (let i = 1; i < levels.length; i++) s += 'q ' + f(mul(levels[i], inv(levels[i - 1]))) + '\n';
    return s;
  }
  // thay nội dung trang bằng 2 phần [nền, phần còn lại]; trả về [ref1, ref2]
  function splitContents(doc, page, sp) {
    const r1 = doc.context.register(doc.context.flateStream(sp.bytes.subarray(0, sp.offset)));
    const r2 = doc.context.register(doc.context.flateStream(sp.bytes.subarray(sp.offset)));
    page.node.set(N('Contents'), doc.context.obj([r1, r2]));
    return [r1, r2];
  }

  return { parse, analyze, strip, vectors, scan, rmActive, bgSplit, splitContents, reopenPrefix, mul, apply };
})();
