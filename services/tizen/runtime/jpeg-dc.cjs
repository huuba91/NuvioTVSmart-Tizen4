"use strict";

// Reduced-size JPEG decode for the ambilight, runs on the TV (Node 4: plain ES5, no Buffer.alloc).
//
// The capture service (samsung.tizen.dcapture, comp_type 1) hands over a ~10 KB JPEG of 480x270 in about
// half the time it needs for the ~100 KB PNG. The colour analysis only samples a coarse grid anyway, so
// instead of a full decode this reads just the DC coefficient of every 8x8 block (its mean colour): one
// pixel per block, 60x34 for 480x270. Huffman-decoding the AC coefficients is still needed to find the next
// block, but no inverse DCT, dequantising of AC values, or per-pixel colour conversion is done.
//
// Supports baseline / extended sequential 8-bit JPEG with one interleaved scan (what libjpeg writes by
// default), any chroma subsampling, restart intervals and greyscale. Anything else (progressive, multiple
// scans, 12-bit, arithmetic coding) throws, and the caller falls back to PNG.

function buildHuffman(counts, symbols) {
  var mincode = [], maxcode = [], valptr = [], code = 0, k = 0, l;
  for (l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += counts[l - 1];
    k += counts[l - 1];
    maxcode[l] = counts[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  return { mincode: mincode, maxcode: maxcode, valptr: valptr, symbols: symbols };
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// Returns { w, h, bpp, data } like decodePng, with bpp 3 (RGB) or 1 (grey); w/h are ceil(width/8), ceil(height/8).
function decodeJpegDc(data) {
  var len = data.length, pos = 2, i, j;
  if (len < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error("not a JPEG");

  var quant = {}, dcTables = {}, acTables = {}, frame = null, restartInterval = 0, scanStart = -1, scanComps = null;

  while (pos + 4 <= len && scanStart < 0) {
    if (data[pos] !== 0xff) { pos++; continue; }
    var marker = data[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    pos += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    var segLen = (data[pos] << 8) | data[pos + 1], end = pos + segLen, p = pos + 2;
    if (segLen < 2 || end > len) throw new Error("truncated JPEG segment");
    if (marker === 0xdb) { // DQT: only the DC entry (first in zigzag order) is needed
      while (p < end) {
        var pq = data[p] >> 4, tq = data[p] & 15;
        quant[tq] = pq ? (data[p + 1] << 8) | data[p + 2] : data[p + 1];
        p += 1 + (pq ? 128 : 64);
      }
    } else if (marker === 0xc4) { // DHT
      while (p < end) {
        var tc = data[p] >> 4, th = data[p] & 15, counts = [], total = 0;
        for (i = 0; i < 16; i++) { counts.push(data[p + 1 + i]); total += data[p + 1 + i]; }
        var symbols = [];
        for (i = 0; i < total; i++) symbols.push(data[p + 17 + i]);
        (tc ? acTables : dcTables)[th] = buildHuffman(counts, symbols);
        p += 17 + total;
      }
    } else if (marker === 0xc0 || marker === 0xc1) { // SOF0 baseline, SOF1 extended sequential
      if (data[p] !== 8) throw new Error("unsupported JPEG precision " + data[p]);
      frame = { h: (data[p + 1] << 8) | data[p + 2], w: (data[p + 3] << 8) | data[p + 4], comps: [] };
      var n = data[p + 5];
      for (i = 0; i < n; i++) {
        frame.comps.push({ id: data[p + 6 + i * 3], h: data[p + 7 + i * 3] >> 4, v: data[p + 7 + i * 3] & 15, tq: data[p + 8 + i * 3] });
      }
    } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error("unsupported JPEG type (SOF" + (marker - 0xc0) + ")");
    } else if (marker === 0xdd) { // DRI
      restartInterval = (data[p] << 8) | data[p + 1];
    } else if (marker === 0xda) { // SOS
      var ns = data[p];
      scanComps = [];
      for (i = 0; i < ns; i++) scanComps.push({ id: data[p + 1 + i * 2], dc: data[p + 2 + i * 2] >> 4, ac: data[p + 2 + i * 2] & 15 });
      scanStart = end;
    }
    pos = end;
  }
  if (!frame || scanStart < 0) throw new Error("JPEG without frame or scan");
  if (!frame.w || !frame.h) throw new Error("JPEG size missing");
  if (scanComps.length !== frame.comps.length) throw new Error("JPEG with several scans");
  if (frame.comps.length !== 1 && frame.comps.length !== 3) throw new Error("unsupported JPEG components " + frame.comps.length);

  var comps = frame.comps, maxH = 1, maxV = 1;
  for (i = 0; i < comps.length; i++) {
    var c = comps[i], sc = null;
    for (j = 0; j < scanComps.length; j++) if (scanComps[j].id === c.id) sc = scanComps[j];
    if (!sc) throw new Error("JPEG scan lacks component " + c.id);
    c.dcTable = dcTables[sc.dc]; c.acTable = acTables[sc.ac];
    if (!c.dcTable || !c.acTable) throw new Error("JPEG Huffman table missing");
    if (quant[c.tq] === undefined) throw new Error("JPEG quantisation table missing");
    if (comps.length === 1) { c.h = 1; c.v = 1; } // one component: the MCU is a single block
    if (!c.h || !c.v) throw new Error("bad JPEG sampling");
    if (c.h > maxH) maxH = c.h;
    if (c.v > maxV) maxV = c.v;
  }
  var mcusX = Math.ceil(frame.w / (8 * maxH)), mcusY = Math.ceil(frame.h / (8 * maxV));
  for (i = 0; i < comps.length; i++) {
    comps[i].blocksW = mcusX * comps[i].h;
    comps[i].dc = new Array(comps[i].blocksW * mcusY * comps[i].v);
    comps[i].pred = 0;
  }

  // ---- entropy-coded data ----
  var bitBuf = 0, bitCnt = 0, rp = scanStart;
  function readBit() {
    if (bitCnt === 0) {
      if (rp >= len) throw new Error("truncated JPEG data");
      var b = data[rp++];
      if (b === 0xff) {
        var b2 = data[rp];
        if (b2 === 0) rp++;
        else if (b2 >= 0xd0 && b2 <= 0xd7) { rp--; b = 0; } // a restart marker where bits were expected: feed zeros
        else throw new Error("unexpected JPEG marker in data");
      }
      bitBuf = b;
      bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  }
  function receive(n) {
    var v = 0;
    while (n-- > 0) v = (v << 1) | readBit();
    return v;
  }
  function huff(t) {
    var code = 0;
    for (var l = 1; l <= 16; l++) {
      code = (code << 1) | readBit();
      if (t.maxcode[l] !== -1 && code <= t.maxcode[l]) {
        var s = t.symbols[t.valptr[l] + code - t.mincode[l]];
        if (s === undefined) break;
        return s;
      }
    }
    throw new Error("bad JPEG Huffman code");
  }
  function restart() {
    bitCnt = 0;
    while (rp + 1 < len && !(data[rp] === 0xff && data[rp + 1] >= 0xd0 && data[rp + 1] <= 0xd7)) rp++;
    rp += 2;
    for (var q = 0; q < comps.length; q++) comps[q].pred = 0;
  }
  function block(c, index) {
    var t = huff(c.dcTable), diff = 0;
    if (t) {
      diff = receive(t);
      if (diff < (1 << (t - 1))) diff += 1 - (1 << t);
    }
    c.pred += diff;
    c.dc[index] = c.pred;
    var k = 1, rs, s, r;
    while (k < 64) { // skip the AC coefficients
      rs = huff(c.acTable);
      s = rs & 15; r = rs >> 4;
      if (s === 0) {
        if (r === 15) { k += 16; continue; }
        break;
      }
      k += r + 1;
      receive(s);
    }
  }

  var mcu, mx, my, ci, by, bx, c2, count = mcusX * mcusY;
  for (mcu = 0; mcu < count; mcu++) {
    if (restartInterval && mcu > 0 && mcu % restartInterval === 0) restart();
    mx = mcu % mcusX; my = (mcu - mx) / mcusX;
    for (ci = 0; ci < comps.length; ci++) {
      c2 = comps[ci];
      for (by = 0; by < c2.v; by++) {
        for (bx = 0; bx < c2.h; bx++) {
          block(c2, (my * c2.v + by) * c2.blocksW + mx * c2.h + bx);
        }
      }
    }
  }

  // ---- one pixel per 8x8 block of the luma plane ----
  // Subsampled chroma is interpolated between neighbouring chroma blocks (like libjpeg's fancy upsampling)
  // so a block next to a hard colour edge does not take the wrong side's chroma.
  var outW = Math.ceil(frame.w / 8), outH = Math.ceil(frame.h / 8), bpp = comps.length === 3 ? 3 : 1;
  var out = new Uint8Array(outW * outH * bpp), x, y, o = 0, yc = comps[0], Y, Cb, Cr;
  function chroma(c, px, py) {
    var rx = maxH / c.h, ry = maxV / c.v;
    var fx = (px + 0.5) / rx - 0.5, fy = (py + 0.5) / ry - 0.5;
    var cw = Math.max(1, Math.ceil(outW / rx)), ch = Math.max(1, Math.ceil(outH / ry));
    var x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    var xa = Math.min(cw - 1, Math.max(0, x0)), xb = Math.min(cw - 1, Math.max(0, x0 + 1));
    var ya = Math.min(ch - 1, Math.max(0, y0)), yb = Math.min(ch - 1, Math.max(0, y0 + 1));
    var q = quant[c.tq] / 8;
    var top = c.dc[ya * c.blocksW + xa] * (1 - tx) + c.dc[ya * c.blocksW + xb] * tx;
    var bottom = c.dc[yb * c.blocksW + xa] * (1 - tx) + c.dc[yb * c.blocksW + xb] * tx;
    return (top * (1 - ty) + bottom * ty) * q;
  }
  for (y = 0; y < outH; y++) {
    for (x = 0; x < outW; x++) {
      Y = yc.dc[y * yc.blocksW + x] * quant[yc.tq] / 8 + 128;
      if (bpp === 1) { out[o++] = clamp(Y); continue; }
      Cb = chroma(comps[1], x, y);
      Cr = chroma(comps[2], x, y);
      out[o++] = clamp(Y + 1.402 * Cr);
      out[o++] = clamp(Y - 0.344136 * Cb - 0.714136 * Cr);
      out[o++] = clamp(Y + 1.772 * Cb);
    }
  }
  return { w: outW, h: outH, bpp: bpp, data: out };
}

// Structure of a JPEG for diagnostics: which markers, the frame type and sampling, and how many scans and
// restart markers it holds. Used to find out why a file from the TV cannot be decoded.
function describeJpeg(data) {
  var out = { bytes: data.length, markers: [], frame: null, scans: 0, restartMarkers: 0, dri: 0, notes: [] };
  var pos = 2, i;
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) { out.notes.push("no SOI"); return out; }
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) { pos++; continue; }
    var marker = data[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    pos += 2;
    if (marker === 0xd8 || marker === 0x01 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) { out.markers.push("EOI"); break; }
    var len = (data[pos] << 8) | data[pos + 1], p = pos + 2;
    var name = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc ? "SOF" + (marker - 0xc0)
      : marker === 0xc4 ? "DHT" : marker === 0xdb ? "DQT" : marker === 0xda ? "SOS" : marker === 0xdd ? "DRI"
      : marker >= 0xe0 && marker <= 0xef ? "APP" + (marker - 0xe0) : marker === 0xfe ? "COM" : "0x" + marker.toString(16);
    if (out.markers.length < 40) out.markers.push(name + "(" + len + ")");
    if (name.indexOf("SOF") === 0) {
      var comps = [];
      for (i = 0; i < data[p + 5]; i++) comps.push({ id: data[p + 6 + i * 3], h: data[p + 7 + i * 3] >> 4, v: data[p + 7 + i * 3] & 15, tq: data[p + 8 + i * 3] });
      out.frame = { type: name, precision: data[p], h: (data[p + 1] << 8) | data[p + 2], w: (data[p + 3] << 8) | data[p + 4], comps: comps };
    } else if (name === "DRI") {
      out.dri = (data[p] << 8) | data[p + 1];
    } else if (name === "APP14") {
      out.notes.push("Adobe marker (colour transform " + data[p + 11] + ")");
    }
    if (name === "SOS") {
      out.scans++;
      out.scanComponents = data[p];
      // entropy-coded data follows: count what is in it, then look for another SOS
      var q = pos + len;
      while (q + 1 < data.length) {
        if (data[q] === 0xff && data[q + 1] >= 0xd0 && data[q + 1] <= 0xd7) out.restartMarkers++;
        if (data[q] === 0xff && data[q + 1] === 0xda) { out.scans++; }
        if (data[q] === 0xff && data[q + 1] === 0xd9) break;
        q++;
      }
      break;
    }
    pos += len;
  }
  return out;
}

module.exports = { decodeJpegDc: decodeJpegDc, describeJpeg: describeJpeg };
