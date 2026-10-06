/* global module, require, __dirname */
"use strict";

// Ambilight for the Tizen 4 build (UE49NU7100): the TV's own capture service
// takes a small PNG of the real screen (video plane included, any codec or
// resolution), ambilight-colour.cjs turns it into a dominant colour for the left
// edge, the right edge and the whole picture (same engine as the PC sync), and
// this module drives Tuya bulbs over the local protocol 3.3 directly from the
// TV. Measured on the target: two overlapped captures give ~9 pictures/s at
// ~43% CPU; canvas/WebGL readback of the video is blank on this firmware.
// Between pictures the colour keeps gliding at 20 updates/s, so fades look
// smooth without capturing more often.
//
// The bulb list (names, ids, addresses, local keys) is packaged next to the
// service as ambilight-bulbs.json by scripts/make-ambilight-bulbs.py. Keys never
// leave this process: the HTTP routes only expose ids, names and positions.
//
// Routes (served through the EngineFS listener on 2710):
//   GET /ambilight/bulbs                         configured bulbs, no keys
//   GET /ambilight/start?assign=id:pos:max,..&level=N start or update a session
//       &strip=<ip|on>&stripStart=0-7&stripDir=cw|ccw&stripBright=N  also drive the 8-segment surround
//       strip (ambilight-strip.cjs) over DDP; stripStart is where the strip's controller end sits,
//       0 = top-left, then clockwise (tl t tr r br b bl l)
//   GET /ambilight/level?value=N                 change the overall brightness live
//   GET /ambilight/ping                          keep the session alive
//   GET /ambilight/stop                          stop and restore the bulbs
//   GET /ambilight/state                         diagnostics (incl. capture timing, CPU, eco mode)
//   GET /ambilight/eco?mode=on|off               slow captures down on still pictures (default on)
//   GET /ambilight/capture-sweep?w=64&h=36&modes=0,1,2,3,4&comps=0,1,2,3   try dcapture modes/formats
//   GET /ambilight/jpeg-sample?quality=60            one JPEG capture: structure, decode result and timing
//   GET /ambilight/periodic-probe?ms=300&seconds=2   does StartPeriodicCapture write files, and where
//   GET /ambilight/capture-format?mode=png|jpeg&quality=60   capture as PNG (default) or small JPEG
//   GET /ambilight/introspect                    what samsung.tizen.dcapture offers (also written to /dev/shm)

var BULBS_FILE = "ambilight-bulbs.json";
var POSITIONS = ["left", "center", "right"];
// Devices that must never be driven, whatever the bulb file says.
var NEVER_CONTROL = [/groei/i];
var CAPTURE_DIR = "/dev/shm";
var CAPTURE_PREFIX = "nuvio-ambilight-";
var CAPTURE_SIZE = [64, 36]; // capture mode 2 returns at least 320x180
var CAPTURE_WORKERS = 3; // overlapped captures, no fade; 2 gave only ~2.8 pictures/s on the TV while a video played, so one more
var WATCHDOG_MS = 10000; // stop when the app stops pinging (player gone, app killed)
var MAX_FAILED_CAPTURES = 6;
// Eco pacing: the colours glide between pictures anyway, so a still or slowly changing picture does not
// need ~9 captures/s (each one spawns gdbus and inflates a PNG). Activity is the mean per-byte change
// between consecutive pictures (0-255); it jumps up at once on a cut and decays by DECAY per picture.
var ECO = { staticBelow: 0.6, calmBelow: 2.5, staticRate: 3, calmRate: 6, decay: 0.85 };
var ecoEnabled = true;
// dcapture comp_type: 0 = PNG (~100 KB, what the research used), 1 = JPEG (~10 KB, captured in roughly half the
// time). JPEG is read by jpeg-dc.cjs (one pixel per 8x8 block, 60x34). It is opt-in until measured on the
// TV (/ambilight/capture-format?mode=jpeg) and drops back to PNG by itself when it cannot be decoded.
var CAPTURE_FORMATS = { png: { comp: 0, ext: "png" }, jpeg: { comp: 1, ext: "jpg" } };
var captureFormat = "png";
var jpegQuality = 60;
var jpegFailures = 0;
var TICK_MS = 50; // colour updates per bulb between pictures: 20/s (the PC sync sends up to 30/s)
var FLIP_BACK_AFTER = 500; // anti-flicker: no straight return to the colour just left within this time

var jpegDc = require("./jpeg-dc.cjs");
var colourEngine = require("./ambilight-colour.cjs");
var stripOutput = require("./ambilight-strip.cjs");

function ema(old, value) {
  return old === null || old === undefined ? value : old * 0.8 + value * 0.2;
}

// Mean absolute difference of every ~5th pixel between two decoded pictures; 255 when they cannot be compared.
function pictureChange(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h || a.bpp !== b.bpp) return 255;
  var da = a.data, db = b.data, n = Math.min(da.length, db.length), step = a.bpp * 5, sum = 0, count = 0, i;
  for (i = 0; i + 2 < n; i += step) {
    sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
    count += 3;
  }
  return count ? sum / count : 255;
}

function modeForActivity(activity) {
  return activity < ECO.staticBelow ? "static" : activity < ECO.calmBelow ? "calm" : "active";
}

// CPU seconds used by this service and the gdbus children it has waited for (from /proc, Node 4 has no cpuUsage).
function cpuSeconds() {
  try {
    var fields = require("fs").readFileSync("/proc/self/stat", "utf8").replace(/^.*\) /, "").split(" ");
    // after the "(comm) " part: state is index 0, utime 11, stime 12, cutime 13, cstime 14 (clock ticks, 100/s)
    return (Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14])) / 100;
  } catch (_) {
    return null;
  }
}

function describeError(error) {
  return String(((error && (error.code || error.name)) || "") + " " + ((error && error.message) || error)).slice(0, 200);
}

// ---- bulb file -------------------------------------------------------------------------------------
function isExcluded(entry) {
  var name = String((entry && entry.name) || "");
  if (entry && entry.exclude) return true;
  for (var i = 0; i < NEVER_CONTROL.length; i++) if (NEVER_CONTROL[i].test(name)) return true;
  return false;
}

function normalizePosition(value, fallback) {
  var text = String(value || "").toLowerCase();
  if (text === "off") return "off";
  return POSITIONS.indexOf(text) >= 0 ? text : fallback;
}

// Colour data point formats (tinytuya's names): "rgb8" = rrggbb + hhhh + ss + vv (0-255), the
// classic layout; "hsv16" = hhhh + ssss + vvvv (0-1000), what bulbs with colour_data_v2 on DP 5
// expect. A bulb fed the wrong one shows colours but ignores the brightness.
function normalizeFormat(value) {
  var text = String(value || "").toLowerCase();
  return text === "rgb8" || text === "hsv16" ? text : "";
}

// Format from what the bulb itself reports for DP 5 (12 hex digits = hsv16, 14 = rgb8).
function formatFromDps(dps) {
  var value = dps && typeof dps["5"] === "string" ? dps["5"] : "";
  return value.length === 12 ? "hsv16" : value.length === 14 ? "rgb8" : "";
}

function normalizeBulbList(list) {
  var out = [], seen = {};
  (Array.isArray(list) ? list : []).forEach(function (entry) {
    if (!entry || typeof entry !== "object" || isExcluded(entry)) return;
    var id = String(entry.id || ""), key = String(entry.key || ""), ip = String(entry.ip || "");
    if (!id || key.length !== 16 || !ip || seen[id]) return;
    seen[id] = true;
    out.push({ id: id, name: String(entry.name || id), key: key, ip: ip, pos: normalizePosition(entry.pos, "center"),
      format: normalizeFormat(entry.format) });
  });
  return out;
}

function loadBulbs() {
  var fs = require("fs"), path = require("path");
  // The runtime folder sits one level below the service entry point.
  var candidates = [path.join(__dirname, "..", BULBS_FILE), path.join(__dirname, BULBS_FILE)];
  for (var i = 0; i < candidates.length; i++) {
    try {
      return normalizeBulbList(JSON.parse(fs.readFileSync(candidates[i], "utf8")));
    } catch (_) {
      // try the next location
    }
  }
  return [];
}

function normalizeMax(value) {
  var n = Math.round(Number(value));
  return isFinite(n) && n >= 1 ? Math.min(100, n) : 100;
}

// "id:pos:max,id:pos" -> { id: { pos, max } } (max: the bulb's own brightness cap, 1-100, default 100)
function parseAssignments(text) {
  var out = {};
  String(text || "").split(",").forEach(function (pair) {
    var parts = pair.split(":");
    if (parts.length < 2) return;
    var id = decodeURIComponent(parts[0]), pos = normalizePosition(parts[1], "");
    if (id && pos) out[id] = { pos: pos, max: normalizeMax(parts[2]) };
  });
  return out;
}

// "strip=on|ip" (+ stripStart, stripDir, stripBright) -> config for ambilight-strip.cjs, or null for no strip.
function parseStrip(query) {
  var flag = String((query && query.strip) || "");
  if (!flag || flag === "off" || flag === "0") return null;
  var start = Number(query.stripStart), bright = Number(query.stripBright);
  return {
    ip: stripOutput._internals.normalizeIp(flag) || stripOutput.DEFAULT_IP,
    start: isFinite(start) ? start : 0,
    clockwise: String(query.stripDir || "cw").toLowerCase() !== "ccw",
    bright: isFinite(bright) && bright > 0 ? Math.min(100, bright) : 0
  };
}

// ---- picture decoding ------------------------------------------------------------------------------
function decodePng(buffer) {
  var zlib = require("zlib");
  if (buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  var pos = 8, parts = [], w = 0, h = 0, depth = 0, colourType = 0, length, type, data;
  while (pos + 12 <= buffer.length) {
    length = buffer.readUInt32BE(pos);
    type = buffer.toString("ascii", pos + 4, pos + 8);
    data = buffer.slice(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; colourType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG");
    } else if (type === "IDAT") {
      parts.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  var bpp = colourType === 2 ? 3 : colourType === 6 ? 4 : colourType === 0 ? 1 : colourType === 4 ? 2 : 0;
  if (!bpp || depth !== 8) throw new Error("unsupported PNG type " + colourType + "/" + depth);
  var raw = zlib.inflateSync(Buffer.concat(parts));
  var stride = w * bpp, out = new Buffer(stride * h), x, y, filter, value, a, b, c, p, pa, pb, pc, line, prev;
  for (y = 0; y < h; y++) {
    filter = raw[y * (stride + 1)];
    line = y * stride; prev = line - stride;
    for (x = 0; x < stride; x++) {
      value = raw[y * (stride + 1) + 1 + x];
      a = x >= bpp ? out[line + x - bpp] : 0;
      b = y > 0 ? out[prev + x] : 0;
      c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        p = a + b - c; pa = Math.abs(p - a); pb = Math.abs(p - b); pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[line + x] = value & 255;
    }
  }
  return { w: w, h: h, bpp: bpp, data: out };
}

function hsvToRgb255(hsv) {
  var h = (((hsv[0] % 1) + 1) % 1) * 6, s = hsv[1], v = hsv[2], i = Math.floor(h), f = h - i;
  var p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  var rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255)];
}

// ---- Tuya local protocol 3.3 (AES-128-ECB with the bulb's local key, TCP 6668) ---------------------
var CRC_TABLE = (function () {
  var table = [], n, c, k;
  for (n = 0; n < 256; n++) {
    c = n;
    for (k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  var c = 0xffffffff, i;
  for (i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function aes(key, data, decrypt) {
  var crypto = require("crypto"), k = new Buffer(key, "binary"), iv = new Buffer(0);
  var cipher = decrypt ? crypto.createDecipheriv("aes-128-ecb", k, iv) : crypto.createCipheriv("aes-128-ecb", k, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function tuyaFrame(seq, command, payload) {
  var total = 16 + payload.length + 8, frame = new Buffer(total);
  frame.writeUInt32BE(0x000055aa, 0);
  frame.writeUInt32BE(seq >>> 0, 4);
  frame.writeUInt32BE(command, 8);
  frame.writeUInt32BE(payload.length + 8, 12);
  payload.copy(frame, 16);
  frame.writeUInt32BE(crc32(frame.slice(0, 16 + payload.length)), 16 + payload.length);
  frame.writeUInt32BE(0x0000aa55, total - 4);
  return frame;
}

function hex(value, digits) {
  var s = Math.max(0, Math.round(value)).toString(16);
  while (s.length < digits) s = "0" + s;
  return s;
}

function hsv16Hex(hsv) {
  return hex(Math.round(hsv[0] * 360) % 360, 4) + hex(Math.round(hsv[1] * 1000), 4) +
    hex(Math.max(10, Math.round(hsv[2] * 1000)), 4);
}

// Data point 5 in rgb8: rrggbb + hue (0-360, 4 hex) + saturation and value (0-255, 2 hex each).
function colourHex(c) {
  var r = c[0], g = c[1], b = c[2], max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0;
  if (max < 10) { r = g = b = max = 10; d = 0; } // never fully dark: the bulb would look switched off
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return hex(r, 2) + hex(g, 2) + hex(b, 2) + hex(h, 4) + hex(max ? (d * 255) / max : 0, 2) + hex(max, 2);
}

// Sending faster than a bulb answers makes it reset the connection (seen on the target: all three
// dropped after ~70 colours at 20 a second), and it also drops a connection that stays silent.
var MIN_SEND_MS = 100;     // at most 10 colours a second per bulb, the rate the first version proved...
var ACK_TIMEOUT_MS = 500;  // ...and none while the answer to the previous one is still outstanding
var HEARTBEAT_MS = 8000;   // keeps the connection open through a long still scene
var RECONNECT_MS = 2000;   // a dropped bulb is taken again after this pause, for as long as the session runs

function Bulb(config) {
  this.id = config.id; this.name = config.name; this.key = config.key; this.ip = config.ip;
  this.pos = config.pos; this.max = normalizeMax(config.max); this.format = normalizeFormat(config.format);
  this.mode = ""; this.lastHex = ""; this.prevHex = ""; this.hexTime = 0;
  this.seq = 1; this.socket = null; this.rx = new Buffer(0); this.connected = false;
  this.dps = null; this.original = null; this.sent = 0; this.errors = []; this.inColour = false;
  this.lastSend = 0; this.waiting = false; this.autoReconnect = false; this.reconnecting = false; this.reconnects = 0;
}

Bulb.prototype.connect = function (done) {
  var net = require("net"), self = this, called = false, socket;
  function fin(error) { if (called) return; called = true; done(error); }
  try {
    socket = net.connect({ host: this.ip, port: 6668 });
  } catch (error) {
    this.note(describeError(error)); fin(describeError(error)); return;
  }
  this.socket = socket;
  socket.setNoDelay(true);
  // A socket that has been replaced by a reconnect must not touch the bulb's state any more.
  socket.on("connect", function () {
    if (self.socket !== socket) return;
    self.connected = true; self.waiting = false; self.rx = new Buffer(0);
    fin(null);
  });
  socket.on("error", function (error) {
    if (self.socket === socket) { self.note(describeError(error)); self.connected = false; }
    fin(describeError(error));
  });
  socket.on("close", function () {
    if (self.socket !== socket) return;
    self.connected = false;
    if (self.autoReconnect) self.reconnectLater();
  });
  socket.on("data", function (chunk) {
    if (self.socket !== socket) return;
    self.waiting = false; // any answer means the bulb has dealt with the last message
    self.rx = Buffer.concat([self.rx, chunk]); self.parse();
  });
  setTimeout(function () {
    if (self.connected || self.socket !== socket) return;
    try { socket.destroy(); } catch (_) {}
    self.note("connect timeout");
    fin("timeout");
  }, 4000);
};

// Takes a dropped bulb again; it then re-enters colour mode with the next colour.
Bulb.prototype.reconnectLater = function () {
  var self = this;
  if (this.reconnecting) return;
  this.reconnecting = true;
  setTimeout(function () {
    self.reconnecting = false;
    if (!self.autoReconnect || self.connected) return;
    self.connect(function (error) {
      if (error) return; // the failed socket's close event schedules the next attempt
      if (!self.autoReconnect) { self.close(); return; }
      self.reconnects++;
      self.mode = ""; self.lastHex = ""; self.prevHex = "";
    });
  }, RECONNECT_MS);
};

// True when the bulb can take another message without falling behind.
Bulb.prototype.ready = function (now) {
  if (!this.connected || now - this.lastSend < MIN_SEND_MS) return false;
  return !this.waiting || now - this.lastSend > ACK_TIMEOUT_MS;
};

Bulb.prototype.heartbeat = function (now) {
  if (!this.connected || now - this.lastSend < HEARTBEAT_MS) return;
  if (this.write(9, { gwId: this.id, devId: this.id }, false)) { this.lastSend = now; this.waiting = true; }
};

Bulb.prototype.note = function (text) {
  if (this.errors.length < 6) this.errors.push(text);
};

Bulb.prototype.parse = function () {
  var length, total, data, message, key;
  while (this.rx.length >= 24) {
    if (this.rx.readUInt32BE(0) !== 0x000055aa) { this.rx = new Buffer(0); return; }
    length = this.rx.readUInt32BE(12); total = 16 + length;
    if (length > 4096) { this.rx = new Buffer(0); return; }
    if (this.rx.length < total) return;
    data = this.rx.slice(20, total - 8);
    this.rx = this.rx.slice(total);
    try {
      if (data.length >= 15 && data.slice(0, 3).toString() === "3.3") data = data.slice(15);
      if (!data.length || data.length % 16 !== 0) continue;
      message = JSON.parse(aes(this.key, data, true).toString("utf8"));
      if (message && message.dps) {
        if (!this.dps) this.dps = {};
        for (key in message.dps) if (Object.prototype.hasOwnProperty.call(message.dps, key)) this.dps[key] = message.dps[key];
      }
    } catch (error) {
      this.note("parse " + describeError(error));
    }
  }
};

Bulb.prototype.write = function (command, body, withHeader) {
  if (!this.connected) return false;
  try {
    var encrypted = aes(this.key, new Buffer(JSON.stringify(body), "utf8"), false);
    var header = new Buffer(15);
    header.fill(0);
    header.write("3.3", 0);
    this.socket.write(tuyaFrame(this.seq++, command, withHeader ? Buffer.concat([header, encrypted]) : encrypted));
    return true;
  } catch (error) {
    this.note("write " + describeError(error));
    return false;
  }
};

Bulb.prototype.query = function () {
  var t = String(Math.floor(Date.now() / 1000));
  return this.write(10, { gwId: this.id, devId: this.id, uid: this.id, t: t }, false);
};

// Some 3.3 bulbs answer the plain query with "json obj data unvalid"; they report their state when
// asked with a control message that names the data points with null values instead.
Bulb.prototype.queryByControl = function () {
  var t = String(Math.floor(Date.now() / 1000));
  return this.write(13, { devId: this.id, uid: this.id, t: t, dps: { 1: null, 2: null, 3: null, 4: null, 5: null } }, true);
};

Bulb.prototype.set = function (dps) {
  var ok = this.write(7, { devId: this.id, uid: this.id, t: String(Math.floor(Date.now() / 1000)), dps: dps }, true);
  if (ok) { this.sent++; this.lastSend = Date.now(); this.waiting = true; }
  return ok;
};

// state: { mode: "colour", hsv: [h, s, v] 0..1 } or { mode: "white" }; level: overall cap 0..100.
Bulb.prototype.show = function (state, level) {
  var f = (Math.max(0, Math.min(100, level)) / 100) * (this.max / 100), now = Date.now(), value;
  // Not ready: skip this step. Nothing is remembered as sent, so the next tick sends the newest colour.
  if (!this.ready(now)) return;
  var v2 = (this.format || formatFromDps(this.original || this.dps)) === "hsv16";
  if (state.mode === "white") {
    // the bulb's own white LEDs look far better than white mixed from colour; warmest, dimmest end
    var low = v2 ? 10 : 25, high = v2 ? 1000 : 255;
    value = Math.max(low, Math.round(low + (high - low) * colourEngine.WHITE_BRIGHTNESS * f));
    if (this.mode === "white" && this.lastHex === "w" + value) return;
    if (this.set({ 1: true, 2: "white", 3: value, 4: 0 })) {
      this.mode = "white"; this.inColour = true; this.lastHex = "w" + value; this.prevHex = "";
    }
    return;
  }
  var hsv = [state.hsv[0], state.hsv[1], state.hsv[2] * f];
  value = v2 ? hsv16Hex(hsv) : colourHex(hsvToRgb255(hsv));
  if (this.mode === "colour") {
    if (value === this.lastHex) return; // too small a change for the bulb to show
    // a near-still scene can hover between two of the bulb's steps: don't flip straight back
    if (value === this.prevHex && now - this.hexTime < FLIP_BACK_AFTER) return;
  }
  // entering colour mode also switches the bulb on; afterwards only the colour is sent
  if (this.set(this.mode === "colour" ? { 5: value } : { 1: true, 2: "colour", 5: value })) {
    this.inColour = true; this.mode = "colour";
    this.prevHex = this.lastHex; this.lastHex = value; this.hexTime = now;
  }
};

Bulb.prototype.restore = function () {
  if (!this.original || !this.inColour) return false;
  var dps = {}, keys = ["1", "2", "3", "4", "5"], any = false;
  keys.forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(this.original, k) && this.original[k] !== null) { dps[k] = this.original[k]; any = true; }
  }, this);
  return any ? this.set(dps) : false;
};

Bulb.prototype.close = function () {
  this.autoReconnect = false;
  try { if (this.socket) this.socket.destroy(); } catch (_) {}
  this.connected = false;
};

// Bulbs announce themselves on UDP 6667 (3.3, encrypted with a fixed key). Used only when a bulb
// cannot be reached at its packaged address, e.g. after the router handed out a new one.
var UDP_KEY = (function () {
  try { return require("crypto").createHash("md5").update("yGAdlopoPVldABfn").digest().toString("binary"); } catch (_) { return ""; }
})();

function parseAnnouncement(message) {
  if (message.length < 28 || message.readUInt32BE(0) !== 0x000055aa) return null;
  var payload = message.slice(20, message.length - 8), text;
  try {
    text = payload.length % 16 === 0 ? aes(UDP_KEY, payload, true).toString("utf8") : payload.toString("utf8");
    var info = JSON.parse(text);
    return info && info.gwId && info.ip ? { id: String(info.gwId), ip: String(info.ip) } : null;
  } catch (_) {
    return null;
  }
}

function discover(ms, done) {
  var dgram = require("dgram"), found = {}, sockets = [], finished = false;
  function fin() {
    if (finished) return; finished = true;
    sockets.forEach(function (s) { try { s.close(); } catch (_) {} });
    done(found);
  }
  [6666, 6667].forEach(function (port) {
    try {
      var socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      socket.on("message", function (message) {
        var info = parseAnnouncement(message);
        if (info) found[info.id] = info.ip;
      });
      socket.on("error", function () {});
      socket.bind(port);
      sockets.push(socket);
    } catch (_) {
      // a port the sandbox refuses only costs us that announcement type
    }
  });
  setTimeout(fin, ms);
}

// ---- capture through samsung.tizen.dcapture ------------------------------------------------------
function captureOnce(name, done) {
  var cp = require("child_process"), fs = require("fs");
  var formatName = captureFormat, format = CAPTURE_FORMATS[formatName];
  var file = CAPTURE_DIR + "/" + name + "." + format.ext, began = Date.now();
  cp.execFile(
    "gdbus",
    ["call", "--system", "--timeout", "4", "--dest", "samsung.tizen.dcapture", "--object-path", "/samsung/tizen/dcapture",
      "--method", "samsung.tizen.dcapture.RequestCaptureToFileSync",
      "0", "2", String(format.comp), String(CAPTURE_SIZE[0]), String(CAPTURE_SIZE[1]),
      formatName === "jpeg" ? String(jpegQuality) : "80", CAPTURE_DIR, name],
    { timeout: 5000 },
    function (error, stdout) {
      if (error) { done("capture " + describeError(error)); return; }
      var captured = Date.now(), image, reply = parseCaptureReply(stdout);
      try {
        // The file we asked for; if the service wrote it elsewhere (its reply names the real path), use that.
        if (reply && reply.path && !fs.existsSync(file)) file = reply.path;
        var bytes = fs.readFileSync(file);
        image = formatName === "jpeg" ? jpegDc.decodeJpegDc(bytes) : decodePng(bytes);
      } catch (problem) {
        done((formatName === "jpeg" ? "decode jpeg " : "decode ") + describeError(problem));
        return;
      }
      done(null, image, { captureMs: captured - began, decodeMs: Date.now() - captured });
    }
  );
}

// ---- session ---------------------------------------------------------------------------------------
var session = null;
var lastSession = null; // describe() of the session that ended last, so Settings can show it after playback

function publicBulb(b) {
  return { id: b.id, name: b.name, pos: b.pos };
}

function Session(bulbs, level, stripConfig) {
  this.bulbs = bulbs;
  this.strip = stripConfig ? new stripOutput.Strip(stripConfig) : null;
  this.level = level;
  this.running = false;
  this.stopped = false;
  this.lastPing = Date.now();
  this.shownBegun = 0;
  this.captures = 0;
  this.failures = 0;
  this.errors = [];
  this.startedAt = Date.now();
  this.watchdog = null;
  this.ticker = null;
  this.analyser = new colourEngine.Analyser();
  this.regions = { left: new colourEngine.Region(), center: new colourEngine.Region(), right: new colourEngine.Region() };
  this.lastPicture = 0;
  this.lastTick = 0;
  this.prevImage = null;
  this.activity = 255; // the first pictures count as moving
  this.mode = "active";
  this.timing = { captureMs: null, decodeMs: null, analyseMs: null };
  this.modeSeconds = { static: 0, calm: 0, active: 0 };
  this.cpuAtStart = cpuSeconds();
}

Session.prototype.note = function (text) {
  if (this.errors.length < 8) this.errors.push(text);
};

Session.prototype.begin = function () {
  var self = this, waiting = this.bulbs.length;
  this.watchdog = setInterval(function () {
    if (Date.now() - self.lastPing > WATCHDOG_MS) self.stop("watchdog");
  }, 1000);
  if (this.strip) this.strip.open();
  // Capturing (and with it the strip) starts at once. Bulbs join as they connect: one that is switched
  // off or unreachable must not hold the picture back, which it used to do for up to ~14 s.
  function startCapture() {
    if (self.stopped) return;
    self.running = true;
    self.lastTick = Date.now();
    self.ticker = setInterval(function () { self.tick(); }, TICK_MS);
    for (var w = 0; w < CAPTURE_WORKERS; w++) {
      (function (index) { setTimeout(function () { self.loop(index); }, index * 60); })(w);
    }
  }
  if (!waiting && !this.strip) { this.stop("no-bulbs"); return; }
  startCapture();
  var discovery = null;
  function rediscover(cb) {
    if (!discovery) {
      discovery = [];
      discover(6000, function (found) {
        var callbacks = discovery;
        discovery = found;
        callbacks.forEach(function (f) { f(found); });
      });
    }
    if (Array.isArray(discovery)) discovery.push(cb);
    else cb(discovery);
  }
  function connectBulb(b, attemptsLeft, triedDiscovery, ready) {
    b.connect(function (error) {
      if (self.stopped) { b.close(); ready(); return; }
      if (error && !triedDiscovery) {
        rediscover(function (found) {
          if (found[b.id] && found[b.id] !== b.ip) b.ip = found[b.id];
          connectBulb(b, attemptsLeft, true, ready);
        });
        return;
      }
      if (error && attemptsLeft > 0) {
        setTimeout(function () { connectBulb(b, attemptsLeft - 1, true, ready); }, 2000);
        return;
      }
      if (!error) {
        b.query();
        setTimeout(function () { if (!b.dps) b.queryByControl(); }, 800);
      }
      ready();
    });
  }
  this.bulbs.forEach(function (b) {
    connectBulb(b, 1, false, function () {
      // give its status reply a moment and remember how the bulb was set before the first colour goes out
      setTimeout(function () {
        if (self.stopped) return;
        if (b.dps) b.original = JSON.parse(JSON.stringify(b.dps));
        b.armed = true;
        b.autoReconnect = true;
        if (!b.connected) b.reconnectLater(); // not reachable at the start: keep trying
      }, 1500);
    });
  });
};

// Overlapped captures, each with its own file, so a new picture arrives more often than one call
// takes. A result that started before the one already shown is dropped.
Session.prototype.loop = function (worker) {
  var self = this;
  if (this.stopped) return;
  var begun = Date.now();
  captureOnce(CAPTURE_PREFIX + worker, function (error, image, timing) {
    if (self.stopped) return;
    if (error && captureFormat === "jpeg") {
      // Any failure while capturing JPEG (the service refuses it, or the file cannot be decoded) counts; three in a
      // row put the capture back on PNG, which the ambilight was validated with, instead of leaving the lights idle.
      jpegFailures++;
      self.note(error);
      if (jpegFailures >= 3) {
        captureFormat = "png";
        self.note("jpeg capture switched off after " + jpegFailures + " failures in a row");
      }
      setTimeout(function () { self.loop(worker); }, 50);
      return;
    }
    if (error) {
      self.failures++;
      self.note(error);
      if (self.failures >= MAX_FAILED_CAPTURES && self.captures === 0) { self.stop("capture-failed"); return; }
      setTimeout(function () { self.loop(worker); }, 300);
      return;
    }
    self.captures++;
    if (captureFormat === "jpeg") jpegFailures = 0;
    if (timing) {
      self.timing.captureMs = ema(self.timing.captureMs, timing.captureMs);
      self.timing.decodeMs = ema(self.timing.decodeMs, timing.decodeMs);
    }
    if (begun >= self.shownBegun) {
      self.shownBegun = begun;
      self.analyse(image);
    }
    var wait = self.paceDelay(Date.now() - begun);
    if (wait > 0) setTimeout(function () { self.loop(worker); }, wait);
    else self.loop(worker);
  });
};

// How long a worker rests before its next capture so that all workers together give the pictures per
// second wanted for the current activity. 0 = flat out (also whenever eco is off).
Session.prototype.paceDelay = function (elapsed) {
  if (!ecoEnabled) return 0;
  var rate = this.mode === "static" ? ECO.staticRate : this.mode === "calm" ? ECO.calmRate : 0;
  return rate ? Math.max(0, Math.round(CAPTURE_WORKERS / rate * 1000 - elapsed)) : 0;
};

// A new picture only moves the goal; tick() glides the bulbs towards it.
Session.prototype.analyse = function (image) {
  var now = Date.now(), dt = this.lastPicture ? Math.min(1, (now - this.lastPicture) / 1000) : 0.1;
  this.lastPicture = now;
  var change = pictureChange(this.prevImage, image);
  this.prevImage = image;
  this.activity = Math.max(change, this.activity * ECO.decay);
  this.mode = modeForActivity(this.activity);
  this.modeSeconds[this.mode] += dt;
  var summary = this.analyser.analyse(image, dt, !!this.strip), regions = this.regions;
  POSITIONS.forEach(function (pos) { regions[pos].setGoal(summary[pos]); });
  if (this.strip && summary.zones) {
    this.strip.setGoals(summary.zones);
    this.strip.record(this.strip.analyseMs, Date.now() - now); // whole picture analysis incl. the 8 zones
  }
  this.timing.analyseMs = ema(this.timing.analyseMs, Date.now() - now);
};

// Runs between pictures too, so every bulb fades through intermediate colours instead of stepping.
Session.prototype.tick = function () {
  var now = Date.now(), dt = Math.max(0.001, Math.min(0.25, (now - this.lastTick) / 1000)), states = {}, level = this.level;
  this.lastTick = now;
  var regions = this.regions;
  POSITIONS.forEach(function (pos) { states[pos] = regions[pos].step(dt); });
  this.bulbs.forEach(function (b) {
    if (b.armed && b.pos !== "off" && states[b.pos]) b.show(states[b.pos], level);
    b.heartbeat(now);
  });
  if (this.strip) this.strip.tick(dt, level);
};

Session.prototype.update = function (assignments, level, stripConfig) {
  if (isFinite(level)) this.level = level;
  if (stripConfig && this.strip) this.strip.configure(stripConfig);
  else if (stripConfig) { this.strip = new stripOutput.Strip(stripConfig); this.strip.open(); }
  else if (this.strip) { this.strip.close(); this.strip = null; }
  this.bulbs.forEach(function (b) {
    var a = assignments[b.id];
    if (a) { b.pos = a.pos; b.max = a.max; b.lastHex = ""; }
  });
};

Session.prototype.stop = function (reason) {
  if (this.stopped) return;
  this.stopped = true;
  this.running = false;
  this.endReason = reason;
  try {
    lastSession = this.describe();
    lastSession.endReason = reason;
    lastSession.seconds = Math.round((Date.now() - this.startedAt) / 1000);
    lastSession.endedAt = Date.now();
  } catch (_) { /* diagnostics only */ }
  clearInterval(this.watchdog);
  clearInterval(this.ticker);
  var fs = require("fs"), bulbs = this.bulbs;
  for (var w = 0; w < CAPTURE_WORKERS; w++) {
    try { fs.unlinkSync(CAPTURE_DIR + "/" + CAPTURE_PREFIX + w + ".png"); } catch (_) {}
    try { fs.unlinkSync(CAPTURE_DIR + "/" + CAPTURE_PREFIX + w + ".jpg"); } catch (_) {}
  }
  bulbs.forEach(function (b) { b.autoReconnect = false; b.restore(); });
  if (this.strip) this.strip.close();
  setTimeout(function () { bulbs.forEach(function (b) { b.close(); }); }, 1200);
  if (session === this) session = null;
};

Session.prototype.modePercent = function () {
  var m = this.modeSeconds, total = m.static + m.calm + m.active;
  if (!total) return { static: 0, calm: 0, active: 0 };
  return { static: Math.round(m.static / total * 100), calm: Math.round(m.calm / total * 100), active: Math.round(m.active / total * 100) };
};

// Service plus gdbus CPU since the session began, as a share of one core; null when /proc is unreadable.
Session.prototype.cpuPercent = function () {
  var used = cpuSeconds(), seconds = (Date.now() - this.startedAt) / 1000;
  if (used === null || this.cpuAtStart === null || seconds < 1) return null;
  return Math.round((used - this.cpuAtStart) / seconds * 1000) / 10;
};

Session.prototype.describe = function () {
  return {
    running: this.running,
    level: this.level,
    captures: this.captures,
    perSecond: this.captures ? Math.round((this.captures * 10000) / (Date.now() - this.startedAt)) / 10 : 0,
    capture: {
      size: CAPTURE_SIZE.join("x"),
      workers: CAPTURE_WORKERS,
      eco: ecoEnabled,
      format: captureFormat,
      jpegQuality: jpegQuality,
      jpegFailures: jpegFailures,
      picture: this.prevImage ? this.prevImage.w + "x" + this.prevImage.h : null,
      mode: this.mode,
      modePercent: this.modePercent(),
      activity: Math.round(this.activity * 100) / 100,
      captureMs: this.timing.captureMs === null ? null : Math.round(this.timing.captureMs),
      decodeMs: this.timing.decodeMs === null ? null : Math.round(this.timing.decodeMs),
      analyseMs: this.timing.analyseMs === null ? null : Math.round(this.timing.analyseMs),
      cpuPercent: this.cpuPercent()
    },
    errors: this.errors,
    strip: this.strip ? this.strip.describe() : null,
    bulbs: this.bulbs.map(function (b) {
      // no keys here; DP values are only on/mode/brightness/colour and help diagnose a bulb
      var reported = b.original || b.dps || {};
      return {
        id: b.id, name: b.name, pos: b.pos, max: b.max, connected: b.connected, sent: b.sent,
        reconnects: b.reconnects, errors: b.errors,
        format: b.format || formatFromDps(reported) || "rgb8 (assumed)", last: b.lastHex,
        reported: { 2: reported["2"], 3: reported["3"], 5: reported["5"] }
      };
    })
  };
};

function start(assignments, level, stripConfig) {
  if (session && !session.stopped) {
    session.lastPing = Date.now();
    session.update(assignments, level, stripConfig);
    return session;
  }
  // Only bulbs that follow a part of the screen are opened: an "off" bulb stays free for other apps.
  var bulbs = loadBulbs()
    .map(function (config) {
      var a = assignments[config.id] || { pos: config.pos, max: 100 };
      return new Bulb({ id: config.id, name: config.name, key: config.key, ip: config.ip, pos: a.pos, max: a.max,
        format: config.format });
    })
    .filter(function (b) { return b.pos !== "off"; });
  session = new Session(bulbs, level, stripConfig);
  session.begin();
  return session;
}

function stop(reason) {
  if (session) session.stop(reason || "stopped");
}

function sendJson(response, status, body) {
  var text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text)
  });
  response.end(text);
}

// What the TV's capture service offers (methods, arguments, formats) and which other services look like
// they could capture the screen. Also saved next to the captures so it can be fetched with `sdb pull`.
var INTROSPECT_FILE = CAPTURE_DIR + "/nuvio-dcapture-introspect.txt";

function introspectCapture(done) {
  var cp = require("child_process"), fs = require("fs");
  var out = { ok: true, file: INTROSPECT_FILE, introspect: [], names: [], errors: [] };
  cp.execFile("gdbus", ["introspect", "--system", "--dest", "samsung.tizen.dcapture", "--object-path", "/samsung/tizen/dcapture"],
    { timeout: 6000, maxBuffer: 512 * 1024 }, function (error, stdout) {
      if (error) out.errors.push("introspect " + describeError(error));
      else out.introspect = String(stdout).split("\n");
      cp.execFile("gdbus", ["call", "--system", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
        "--method", "org.freedesktop.DBus.ListNames"], { timeout: 6000, maxBuffer: 512 * 1024 }, function (error2, stdout2) {
        if (error2) out.errors.push("ListNames " + describeError(error2));
        else {
          out.names = (String(stdout2).match(/'[^']+'/g) || []).map(function (n) { return n.slice(1, -1); })
            .filter(function (n) { return /samsung|tizen|capture|screen|video|display|avplay|hdmi|media|multimedia|vd/i.test(n) && n.charAt(0) !== ":"; });
        }
        try {
          fs.writeFileSync(INTROSPECT_FILE, out.introspect.join("\n") + "\n\n# names\n" + out.names.join("\n") + "\n\n# errors\n" + out.errors.join("\n") + "\n");
        } catch (problem) { out.errors.push("write " + describeError(problem)); }
        done(out);
      });
    });
}

// ---- capture experiments ---------------------------------------------------------------------------
// samsung.tizen.dcapture.RequestCaptureToFileSync(app_type, capture_mode, comp_type, width, height,
// jpeg_quality, dir_path, file_name) -> (retVal, ret_width, ret_height, ret_path). The service uses
// (0, 2, 0, w, h, 80). These routes try the other values and report what comes back, so a rawer or
// cheaper format, or a mode without Nuvio's own controls, can be found. Nothing here is used by a session.
function sniffFormat(buffer) {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x89504e47) return "PNG";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "JPEG";
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return "BMP";
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "GIF8") return "GIF";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF") return "RIFF/WebP";
  if (buffer.length >= 8 && buffer.readUInt32BE(4) === 7) return "XWD?";
  return "unknown";
}

function parseCaptureReply(text) {
  var match = /\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*'([^']*)'\s*,?\s*\)/.exec(String(text));
  return match ? { ret: Number(match[1]), w: Number(match[2]), h: Number(match[3]), path: match[4] } : null;
}

function intList(value, fallback, max) {
  var out = String(value === undefined ? fallback : value).split(",").map(Number).filter(function (n) { return isFinite(n) && n >= 0 && n < 100; });
  return out.slice(0, max);
}

function captureSweep(query, done) {
  var cp = require("child_process"), fs = require("fs");
  var modes = intList(query.modes, "0,1,2,3,4", 8), comps = intList(query.comps, "0,1,2,3", 8);
  var w = Math.max(1, Math.min(1920, Number(query.w) || 64)), h = Math.max(1, Math.min(1080, Number(query.h) || 36));
  var jobs = [], rows = [];
  modes.forEach(function (m) { comps.forEach(function (c) { jobs.push({ mode: m, comp: c }); }); });
  (function next() {
    var job = jobs.shift();
    if (!job) { done({ ok: true, requested: { w: w, h: h }, rows: rows }); return; }
    var name = "nuvio-sweep-m" + job.mode + "c" + job.comp, began = Date.now();
    cp.execFile("gdbus", ["call", "--system", "--timeout", "4", "--dest", "samsung.tizen.dcapture", "--object-path", "/samsung/tizen/dcapture",
      "--method", "samsung.tizen.dcapture.RequestCaptureToFileSync", "0", String(job.mode), String(job.comp), String(w), String(h), "80", CAPTURE_DIR, name],
      { timeout: 5000 }, function (error, stdout, stderr) {
        var row = { mode: job.mode, comp: job.comp, ms: Date.now() - began };
        if (error) row.error = describeError(error) + " " + String(stderr || "").slice(0, 120);
        else {
          row.reply = String(stdout).trim().slice(0, 120);
          var parsed = parseCaptureReply(stdout);
          if (parsed) { row.ret = parsed.ret; row.w = parsed.w; row.h = parsed.h; row.path = parsed.path; }
          var file = parsed && parsed.path ? parsed.path : CAPTURE_DIR + "/" + name + ".png";
          try {
            var data = fs.readFileSync(file);
            row.bytes = data.length;
            row.format = sniffFormat(data);
            if (row.format === "PNG") {
              var image = decodePng(data), sum = [0, 0, 0], n = 0, i;
              for (i = 0; i + 2 < image.data.length; i += image.bpp * 7) { sum[0] += image.data[i]; sum[1] += image.data[i + 1]; sum[2] += image.data[i + 2]; n++; }
              row.mean = n ? sum.map(function (v) { return Math.round(v / n); }) : null;
              row.size = image.w + "x" + image.h + "x" + image.bpp;
            } else if (row.w && row.h) {
              row.bytesPerPixel = Math.round(data.length / (row.w * row.h) * 100) / 100;
            }
            fs.unlinkSync(file);
          } catch (problem) { row.fileError = describeError(problem); }
        }
        rows.push(row);
        next();
      });
  })();
}

// One JPEG capture, taken now and kept as /dev/shm/nuvio-sample.jpg: reports its structure, whether
// jpeg-dc can decode it, and how fast. For finding out why a TV JPEG fails or looks wrong.
function jpegSample(query, done) {
  var cp = require("child_process"), fs = require("fs");
  var quality = Number(query.quality), q = isFinite(quality) && quality >= 10 && quality <= 95 ? Math.round(quality) : jpegQuality;
  var out = { ok: true, quality: q, file: CAPTURE_DIR + "/nuvio-sample.jpg" };
  var began = Date.now();
  cp.execFile("gdbus", ["call", "--system", "--timeout", "4", "--dest", "samsung.tizen.dcapture", "--object-path", "/samsung/tizen/dcapture",
    "--method", "samsung.tizen.dcapture.RequestCaptureToFileSync", "0", "2", "1", String(CAPTURE_SIZE[0]), String(CAPTURE_SIZE[1]),
    String(q), CAPTURE_DIR, "nuvio-sample"], { timeout: 5000 }, function (error, stdout, stderr) {
    out.captureMs = Date.now() - began;
    if (error) { out.error = describeError(error) + " " + String(stderr || "").slice(0, 160); done(out); return; }
    out.reply = String(stdout).trim().slice(0, 160);
    var reply = parseCaptureReply(stdout), file = CAPTURE_DIR + "/nuvio-sample.jpg";
    if (reply && reply.path && !fs.existsSync(file)) file = reply.path;
    try {
      var data = fs.readFileSync(file);
      out.structure = jpegDc.describeJpeg(data);
      out.head = data.slice(0, 24).toString("hex");
      var t0 = Date.now();
      try {
        var image = jpegDc.decodeJpegDc(data);
        out.decodeMs = Date.now() - t0;
        var sum = [0, 0, 0], n = 0, i;
        for (i = 0; i + 2 < image.data.length; i += image.bpp) { sum[0] += image.data[i]; sum[1] += image.data[i + 1]; sum[2] += image.data[i + 2]; n++; }
        out.decoded = { w: image.w, h: image.h, bpp: image.bpp, mean: n ? sum.map(function (v) { return Math.round(v / n); }) : null,
          firstPixels: Array.prototype.slice.call(image.data, 0, 12) };
      } catch (problem) {
        out.decodeError = describeError(problem);
      }
      if (fs.existsSync(file) && file !== CAPTURE_DIR + "/nuvio-sample.jpg") { try { fs.writeFileSync(CAPTURE_DIR + "/nuvio-sample.jpg", data); } catch (_) {} }
    } catch (problem) {
      out.error = "read " + describeError(problem);
    }
    done(out);
  });
}

// Does StartPeriodicCapture produce files on its own, and where? Starts it for a moment, compares a few
// directories before and after, and always ends it again.
var PERIODIC_DIRS = ["/dev/shm", "/tmp", "/var/tmp", "/home/owner/share/tmp", "/opt/usr/media", "/opt/usr/home/owner/share/tmp"];

function periodicProbe(query, done) {
  var cp = require("child_process"), fs = require("fs");
  var interval = Math.max(100, Math.min(2000, Number(query.ms) || 300)), seconds = Math.max(1, Math.min(5, Number(query.seconds) || 2));
  var id = "nuvio-probe", out = { ok: true, intervalMs: interval, seconds: seconds, replies: {}, newFiles: [] };
  function list() {
    var map = {};
    PERIODIC_DIRS.forEach(function (dir) {
      try { fs.readdirSync(dir).forEach(function (f) { try { map[dir + "/" + f] = fs.statSync(dir + "/" + f).mtime.getTime(); } catch (_) {} }); } catch (_) {}
    });
    return map;
  }
  function call(method, args, cb) {
    cp.execFile("gdbus", ["call", "--system", "--timeout", "4", "--dest", "samsung.tizen.dcapture", "--object-path", "/samsung/tizen/dcapture",
      "--method", "samsung.tizen.dcapture." + method].concat(args), { timeout: 5000 }, function (error, stdout, stderr) {
      cb(error ? "error " + describeError(error) + " " + String(stderr || "").slice(0, 120) : String(stdout).trim().slice(0, 160));
    });
  }
  var before = list();
  call("StartPeriodicCaptureWithoutAppInfo", ["0", "2", "64", "36", id, String(interval)], function (started) {
    out.replies.start = started;
    setTimeout(function () {
      var after = list();
      Object.keys(after).forEach(function (f) {
        if (before[f] === undefined || before[f] !== after[f]) {
          var size = null;
          try { size = fs.statSync(f).size; } catch (_) {}
          out.newFiles.push({ file: f, bytes: size });
        }
      });
      out.newFiles = out.newFiles.slice(0, 40);
      call("EndPeriodicCapture", ["0", id, "0"], function (ended) {
        out.replies.end = ended;
        done(out);
      });
    }, seconds * 1000);
  });
}

function isAmbilightRequest(requestUrl) {
  return String(requestUrl || "").indexOf("/ambilight/") === 0;
}

function handleRequest(request, response) {
  var url = require("url");
  var parsed = url.parse(String(request.url || ""), true), query = parsed.query || {};
  try {
    switch (parsed.pathname) {
      case "/ambilight/bulbs":
        sendJson(response, 200, { ok: true, bulbs: loadBulbs().map(publicBulb) });
        return;
      case "/ambilight/start": {
        var level = Number(query.level);
        var s = start(parseAssignments(query.assign), isFinite(level) && level > 0 ? Math.min(100, level) : 100,
          parseStrip(query));
        sendJson(response, 200, { ok: true, state: s.describe() });
        return;
      }
      case "/ambilight/level": {
        var value = Number(query.value);
        if (session && isFinite(value)) {
          session.level = Math.max(1, Math.min(100, value));
          session.bulbs.forEach(function (b) { b.lastHex = ""; });
        }
        sendJson(response, 200, { ok: true, active: !!session, level: session ? session.level : null });
        return;
      }
      case "/ambilight/ping":
        if (session) session.lastPing = Date.now();
        sendJson(response, 200, { ok: true, active: !!session });
        return;
      case "/ambilight/stop":
        stop("stopped");
        sendJson(response, 200, { ok: true });
        return;
      case "/ambilight/eco": {
        if (query.mode === "on" || query.mode === "off") ecoEnabled = query.mode === "on";
        sendJson(response, 200, { ok: true, eco: ecoEnabled });
        return;
      }
      case "/ambilight/capture-format": {
        if (query.mode === "png" || query.mode === "jpeg") { captureFormat = query.mode; jpegFailures = 0; }
        var q = Number(query.quality);
        if (isFinite(q) && q >= 10 && q <= 95) jpegQuality = Math.round(q);
        sendJson(response, 200, { ok: true, format: captureFormat, jpegQuality: jpegQuality });
        return;
      }
      case "/ambilight/introspect":
        introspectCapture(function (result) { sendJson(response, 200, result); });
        return;
      case "/ambilight/capture-sweep":
        captureSweep(query, function (result) { sendJson(response, 200, result); });
        return;
      case "/ambilight/jpeg-sample":
        jpegSample(query, function (result) { sendJson(response, 200, result); });
        return;
      case "/ambilight/periodic-probe":
        periodicProbe(query, function (result) { sendJson(response, 200, result); });
        return;
      case "/ambilight/state":
        sendJson(response, 200, { ok: true, active: !!session, state: session ? session.describe() : null, last: lastSession });
        return;
      default:
        sendJson(response, 404, { ok: false });
    }
  } catch (error) {
    sendJson(response, 500, { ok: false, error: describeError(error) });
  }
}

module.exports = {
  isAmbilightRequest: isAmbilightRequest,
  handleRequest: handleRequest,
  stop: stop,
  // exported for tests
  _internals: {
    normalizeBulbList: normalizeBulbList,
    parseAssignments: parseAssignments,
    parseStrip: parseStrip,
    decodePng: decodePng,
    pictureChange: pictureChange,
    sniffFormat: sniffFormat,
    parseCaptureReply: parseCaptureReply,
    modeForActivity: modeForActivity,
    ECO: ECO,
    hsvToRgb255: hsvToRgb255,
    colourHex: colourHex,
    hsv16Hex: hsv16Hex,
    formatFromDps: formatFromDps,
    Bulb: Bulb,
    crc32: crc32,
    tuyaFrame: tuyaFrame,
    aes: aes,
    parseAnnouncement: parseAnnouncement,
    UDP_KEY: UDP_KEY
  }
};
