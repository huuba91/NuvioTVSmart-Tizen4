/* global module, require, __dirname */
"use strict";

// Ambilight for the Tizen 4 build (UE49NU7100): the TV's own capture service
// takes a small PNG of the real screen (video plane included, any codec or
// resolution), this module averages its left half, right half and the whole
// picture, and drives Tuya bulbs over the local protocol 3.3 directly from the
// TV. Measured on the target: two overlapped captures give ~9 pictures/s at
// ~43% CPU; canvas/WebGL readback of the video is blank on this firmware.
//
// The bulb list (names, ids, addresses, local keys) is packaged next to the
// service as ambilight-bulbs.json by scripts/make-ambilight-bulbs.py. Keys never
// leave this process: the HTTP routes only expose ids, names and positions.
//
// Routes (served through the EngineFS listener on 2710):
//   GET /ambilight/bulbs                         configured bulbs, no keys
//   GET /ambilight/start?assign=id:pos,..&level=N start or update a session
//   GET /ambilight/ping                          keep the session alive
//   GET /ambilight/stop                          stop and restore the bulbs
//   GET /ambilight/state                         diagnostics

var BULBS_FILE = "ambilight-bulbs.json";
var POSITIONS = ["left", "center", "right"];
// Devices that must never be driven, whatever the bulb file says.
var NEVER_CONTROL = [/groei/i];
var CAPTURE_DIR = "/dev/shm";
var CAPTURE_PREFIX = "nuvio-ambilight-";
var CAPTURE_SIZE = [64, 36]; // capture mode 2 returns at least 320x180
var CAPTURE_WORKERS = 2; // the owner preferred two overlapped captures, no fade
var WATCHDOG_MS = 10000; // stop when the app stops pinging (player gone, app killed)
var MAX_FAILED_CAPTURES = 6;

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

function normalizeBulbList(list) {
  var out = [], seen = {};
  (Array.isArray(list) ? list : []).forEach(function (entry) {
    if (!entry || typeof entry !== "object" || isExcluded(entry)) return;
    var id = String(entry.id || ""), key = String(entry.key || ""), ip = String(entry.ip || "");
    if (!id || key.length !== 16 || !ip || seen[id]) return;
    seen[id] = true;
    out.push({ id: id, name: String(entry.name || id), key: key, ip: ip, pos: normalizePosition(entry.pos, "center") });
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

// "id:pos,id:pos" -> { id: pos }
function parseAssignments(text) {
  var out = {};
  String(text || "").split(",").forEach(function (pair) {
    var at = pair.lastIndexOf(":");
    if (at <= 0) return;
    var id = decodeURIComponent(pair.slice(0, at)), pos = normalizePosition(pair.slice(at + 1), "");
    if (id && pos) out[id] = pos;
  });
  return out;
}

// ---- colour zones ----------------------------------------------------------------------------------
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

// Average colour of the left half, the right half and the whole picture.
function zones(image) {
  var half = image.w >> 1, l = [0, 0, 0], r = [0, 0, 0], ln = 0, rn = 0, x, y, p, t, grey = image.bpp < 3;
  for (y = 0; y < image.h; y++) {
    for (x = 0; x < image.w; x++) {
      p = (y * image.w + x) * image.bpp;
      if (x < half) { t = l; ln++; } else { t = r; rn++; }
      t[0] += image.data[p]; t[1] += image.data[grey ? p : p + 1]; t[2] += image.data[grey ? p : p + 2];
    }
  }
  ln = ln || 1; rn = rn || 1;
  var L = [Math.round(l[0] / ln), Math.round(l[1] / ln), Math.round(l[2] / ln)];
  var R = [Math.round(r[0] / rn), Math.round(r[1] / rn), Math.round(r[2] / rn)];
  return {
    left: L,
    right: R,
    center: [Math.round((L[0] + R[0]) / 2), Math.round((L[1] + R[1]) / 2), Math.round((L[2] + R[2]) / 2)]
  };
}

function scale(c, level) {
  var f = Math.max(0, Math.min(100, level)) / 100;
  return [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)];
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

// Data point 5 on these bulbs: rrggbb + hue (0-360, 4 hex) + saturation and value (0-255, 2 hex each).
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

function Bulb(config) {
  this.id = config.id; this.name = config.name; this.key = config.key; this.ip = config.ip;
  this.pos = config.pos;
  this.seq = 1; this.socket = null; this.rx = new Buffer(0); this.connected = false;
  this.dps = null; this.original = null; this.sent = 0; this.errors = []; this.last = null; this.inColour = false;
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
  socket.on("connect", function () { self.connected = true; fin(null); });
  socket.on("error", function (error) { self.note(describeError(error)); self.connected = false; fin(describeError(error)); });
  socket.on("close", function () { self.connected = false; });
  socket.on("data", function (chunk) { self.rx = Buffer.concat([self.rx, chunk]); self.parse(); });
  setTimeout(function () {
    if (self.connected) return;
    try { socket.destroy(); } catch (_) {}
    self.note("connect timeout");
    fin("timeout");
  }, 4000);
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
  if (ok) this.sent++;
  return ok;
};

Bulb.prototype.colour = function (c) {
  var last = this.last;
  if (last && Math.abs(last[0] - c[0]) < 2 && Math.abs(last[1] - c[1]) < 2 && Math.abs(last[2] - c[2]) < 2) return;
  var value = colourHex(c);
  // the first update also switches the bulb on and into colour mode; afterwards only the colour is sent
  if (this.set(this.inColour ? { 5: value } : { 1: true, 2: "colour", 5: value })) {
    this.inColour = true;
    this.last = c;
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
  var file = CAPTURE_DIR + "/" + name + ".png";
  cp.execFile(
    "gdbus",
    ["call", "--system", "--timeout", "4", "--dest", "samsung.tizen.dcapture", "--object-path", "/samsung/tizen/dcapture",
      "--method", "samsung.tizen.dcapture.RequestCaptureToFileSync",
      "0", "2", "0", String(CAPTURE_SIZE[0]), String(CAPTURE_SIZE[1]), "80", CAPTURE_DIR, name],
    { timeout: 5000 },
    function (error) {
      if (error) { done("capture " + describeError(error)); return; }
      try {
        done(null, zones(decodePng(fs.readFileSync(file))));
      } catch (problem) {
        done("decode " + describeError(problem));
      }
    }
  );
}

// ---- session ---------------------------------------------------------------------------------------
var session = null;

function publicBulb(b) {
  return { id: b.id, name: b.name, pos: b.pos };
}

function Session(bulbs, level) {
  this.bulbs = bulbs;
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
}

Session.prototype.note = function (text) {
  if (this.errors.length < 8) this.errors.push(text);
};

Session.prototype.begin = function () {
  var self = this, waiting = this.bulbs.length;
  this.watchdog = setInterval(function () {
    if (Date.now() - self.lastPing > WATCHDOG_MS) self.stop("watchdog");
  }, 1000);
  if (!waiting) { this.stop("no-bulbs"); return; }
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
      if (--waiting > 0) return;
      // give the status replies a moment, remember how each bulb was set, then start capturing
      setTimeout(function () {
        if (self.stopped) return;
        self.bulbs.forEach(function (x) { if (x.dps) x.original = JSON.parse(JSON.stringify(x.dps)); });
        self.running = true;
        for (var w = 0; w < CAPTURE_WORKERS; w++) {
          (function (index) { setTimeout(function () { self.loop(index); }, index * 60); })(w);
        }
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
  captureOnce(CAPTURE_PREFIX + worker, function (error, z) {
    if (self.stopped) return;
    if (error) {
      self.failures++;
      self.note(error);
      if (self.failures >= MAX_FAILED_CAPTURES && self.captures === 0) { self.stop("capture-failed"); return; }
      setTimeout(function () { self.loop(worker); }, 300);
      return;
    }
    self.captures++;
    if (begun >= self.shownBegun) {
      self.shownBegun = begun;
      self.apply(z);
    }
    self.loop(worker);
  });
};

Session.prototype.apply = function (z) {
  var level = this.level;
  this.bulbs.forEach(function (b) {
    if (b.pos === "off" || !z[b.pos]) return;
    b.colour(scale(z[b.pos], level));
  });
};

Session.prototype.update = function (assignments, level) {
  this.level = level;
  this.bulbs.forEach(function (b) {
    var pos = assignments[b.id];
    if (pos) b.pos = pos;
  });
};

Session.prototype.stop = function (reason) {
  if (this.stopped) return;
  this.stopped = true;
  this.running = false;
  this.endReason = reason;
  clearInterval(this.watchdog);
  var fs = require("fs"), bulbs = this.bulbs;
  for (var w = 0; w < CAPTURE_WORKERS; w++) {
    try { fs.unlinkSync(CAPTURE_DIR + "/" + CAPTURE_PREFIX + w + ".png"); } catch (_) {}
  }
  bulbs.forEach(function (b) { b.restore(); });
  setTimeout(function () { bulbs.forEach(function (b) { b.close(); }); }, 1200);
  if (session === this) session = null;
};

Session.prototype.describe = function () {
  return {
    running: this.running,
    level: this.level,
    captures: this.captures,
    perSecond: this.captures ? Math.round((this.captures * 10000) / (Date.now() - this.startedAt)) / 10 : 0,
    errors: this.errors,
    bulbs: this.bulbs.map(function (b) {
      return { id: b.id, name: b.name, pos: b.pos, connected: b.connected, sent: b.sent, errors: b.errors };
    })
  };
};

function start(assignments, level) {
  if (session && !session.stopped) {
    session.lastPing = Date.now();
    session.update(assignments, level);
    return session;
  }
  // Only bulbs that follow a part of the screen are opened: an "off" bulb stays free for other apps.
  var bulbs = loadBulbs()
    .map(function (config) {
      return new Bulb({ id: config.id, name: config.name, key: config.key, ip: config.ip, pos: assignments[config.id] || config.pos });
    })
    .filter(function (b) { return b.pos !== "off"; });
  session = new Session(bulbs, level);
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
        var s = start(parseAssignments(query.assign), isFinite(level) && level > 0 ? Math.min(100, level) : 100);
        sendJson(response, 200, { ok: true, state: s.describe() });
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
      case "/ambilight/state":
        sendJson(response, 200, { ok: true, active: !!session, state: session ? session.describe() : null });
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
    decodePng: decodePng,
    zones: zones,
    scale: scale,
    colourHex: colourHex,
    crc32: crc32,
    tuyaFrame: tuyaFrame,
    aes: aes,
    parseAnnouncement: parseAnnouncement,
    UDP_KEY: UDP_KEY
  }
};
