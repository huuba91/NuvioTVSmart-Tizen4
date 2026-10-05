/* global module, require */
"use strict";

// Surround strip for the TV ambilight: an addressable LED strip (LSC 3 m RGBIC running OpenBeken
// with the DDP driver) laid round the back of the TV in a rectangle. Each of its 8 segments follows
// the edge of the picture next to it (ambilight-colour.cjs: STRIP_ZONES), and the colours go out as
// one DDP packet per update over UDP.
//
// OpenBeken startup command (same as the PC's strip_sync.py):
//   backlog startDriver SM16703P; SM16703P_Init 16 BRG; startDriver DDP
// That gives 16 pixels: even ones are the RGB segments 1..8, odd ones are white chips kept off.

var colourEngine = require("./ambilight-colour.cjs");

var SEGMENTS = 8;
var DDP_PORT = 4048;
var DEFAULT_IP = "192.168.129.19";
var GAMMA = 2.2; // LEDs are linear, the screen colours are not
var DEFAULT_BRIGHT = 0.6; // PC strip_sync.py default
var SATURATION = 1.3; // PC strip_sync.py default
var WARM_WHITE = [255, 170, 90];
var STATS_WINDOW = 200;

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function normalizeIp(value) {
  var text = String(value || "").trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(text) ? text : "";
}

// "start" is the segment that sits at the strip's controller end, as an index into STRIP_ZONES
// (0 = top-left); "clockwise" says which way the strip runs from there.
function segmentOrder(start, clockwise) {
  var zones = colourEngine.STRIP_ZONES, out = [], first = clamp(Math.round(Number(start) || 0), 0, SEGMENTS - 1);
  for (var i = 0; i < SEGMENTS; i++) {
    out.push(zones[(first + (clockwise ? i : -i) + SEGMENTS * 2) % SEGMENTS]);
  }
  return out;
}

// Linear-light colour of a Region state for the strip, 0..255 per channel.
function stateToRgb(state, level, bright) {
  var scale = clamp(level, 0, 100) / 100 * bright, hsv, rgb, i;
  if (!state) return [0, 0, 0];
  if (state.mode === "white") {
    var white = colourEngine.WHITE_BRIGHTNESS * 6 * scale; // warm light, a little stronger than the bulbs' 5%
    return [WARM_WHITE[0] * white, WARM_WHITE[1] * white, WARM_WHITE[2] * white];
  }
  hsv = [state.hsv[0], Math.min(1, state.hsv[1] * SATURATION), state.hsv[2]];
  rgb = hsvToRgb(hsv);
  for (i = 0; i < 3; i++) rgb[i] = 255 * Math.pow(rgb[i], GAMMA) * scale;
  return rgb;
}

function hsvToRgb(hsv) {
  var h = (((hsv[0] % 1) + 1) % 1) * 6, s = hsv[1], v = hsv[2], i = Math.floor(h), f = h - i;
  var p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

// 8 segment colours -> 16 physical pixels (segment, black, segment, black, ...).
function buildPayload(colours) {
  var payload = new Buffer(SEGMENTS * 2 * 3), i, k;
  payload.fill(0);
  for (i = 0; i < SEGMENTS; i++) {
    for (k = 0; k < 3; k++) payload[i * 6 + k] = Math.round(clamp(colours[i][k], 0, 255));
  }
  return payload;
}

// DDP v1 with the push flag: 10 byte header, then the pixel data.
function buildPacket(payload, sequence) {
  var packet = new Buffer(10 + payload.length);
  packet[0] = 0x41;
  packet[1] = sequence & 15 || 1;
  packet[2] = 0x01; // RGB, 8 bit
  packet[3] = 1; // default output device
  packet.writeUInt32BE(0, 4); // offset
  packet.writeUInt16BE(payload.length, 8);
  payload.copy(packet, 10);
  return packet;
}

function Strip(config) {
  this.configure(config);
  this.regions = {};
  colourEngine.STRIP_ZONES.forEach(function (name) { this.regions[name] = new colourEngine.Region(); }, this);
  this.socket = null;
  this.method = 0;
  this.closed = false;
  this.httpBusy = false;
  this.httpWaiting = null;
  this.sequence = 0;
  this.last = "";
  this.sent = 0;
  this.skipped = 0;
  this.errors = [];
  this.sendMs = [];
  this.analyseMs = [];
  this.colours = [];
}

// Also used while running, when a setting changes mid-playback.
Strip.prototype.configure = function (config) {
  config = config || {};
  this.ip = normalizeIp(config.ip) || DEFAULT_IP;
  this.order = segmentOrder(config.start, config.clockwise !== false);
  this.bright = clamp(Number(config.bright) > 0 ? Number(config.bright) / 100 : DEFAULT_BRIGHT, 0.05, 1);
  this.ddpPort = config.ddpPort || DDP_PORT; // ports are only changed by tests
  this.webPort = config.webPort || 80;
  this.healthMs = config.healthMs || HEALTH_MS;
};

Strip.prototype.note = function (text) {
  if (this.errors.length < 6) this.errors.push(text);
};

// Ways of getting a frame to the strip, tried in this order. The first is plain DDP and should be
// the only one ever needed; the others exist because this runs on a TV whose network stack we cannot
// inspect. A health check watches the strip's own "DDP received" counter and moves on to the next way
// when packets are sent but never counted.
var METHODS = ["udp", "udp-fresh", "udp-bound", "http"];
var HEALTH_MS = 4000;
var HEALTH_MIN_SENT = 4; // packets sent between two checks before silence counts as a failure
var HEALTH_FAILS = 2; // silent checks in a row before switching

Strip.prototype.open = function () {
  this.method = 0;
  this.openMethod();
  this.startHealth();
};

Strip.prototype.openMethod = function () {
  var self = this, method = METHODS[this.method];
  this.closeSocket();
  this.last = ""; // the next frame goes out even when it equals the last one
  if (method === "udp-fresh" || method === "http") return; // nothing to keep open
  try {
    this.socket = require("dgram").createSocket("udp4");
    this.socket.on("error", function (error) { self.note(String((error && error.message) || error)); });
    if (method === "udp-bound") this.socket.bind(0);
  } catch (error) {
    this.socket = null;
    this.note(method + ": " + String((error && error.message) || error));
  }
};

Strip.prototype.closeSocket = function () {
  var socket = this.socket;
  this.socket = null;
  if (socket) { try { socket.close(); } catch (_) {} }
};

Strip.prototype.currentMethod = function () {
  return METHODS[this.method];
};

// ---- health check: does the strip count what we send? ---------------------------------------------
Strip.prototype.startHealth = function () {
  var self = this;
  this.health = { counter: null, sentAt: 0, fails: 0, available: null, switches: 0 };
  this.healthTimer = setInterval(function () { self.checkHealth(); }, this.healthMs);
};

Strip.prototype.readCounter = function (done) {
  var http = require("http"), body = "", finished = false;
  function fin(value, error) { if (finished) return; finished = true; done(value, error); }
  try {
    var request = http.get({ host: this.ip, port: this.webPort, path: "/", agent: false }, function (response) {
      response.setEncoding("utf8");
      response.on("data", function (chunk) { if (body.length < 65536) body += chunk; });
      response.on("end", function () {
        var match = /DDP received:\s*(\d+)/i.exec(body);
        fin(match ? Number(match[1]) : null, match ? "" : "no counter on the strip's web page");
      });
    });
    request.setTimeout(3000, function () { request.abort(); fin(null, "web page timeout"); });
    request.on("error", function (error) { fin(null, String((error && error.message) || error)); });
  } catch (error) {
    fin(null, String((error && error.message) || error));
  }
};

Strip.prototype.checkHealth = function () {
  var self = this, health = this.health, sentNow = this.sent;
  if (this.currentMethod() === "http" || this.closed) return;
  this.readCounter(function (value, error) {
    if (self.closed) return;
    if (value === null) {
      health.available = false;
      health.error = error;
      return; // cannot judge: stay with the current way
    }
    health.available = true;
    health.error = "";
    if (health.counter !== null) {
      var moved = value - health.counter, sent = sentNow - health.sentAt;
      health.moved = moved;
      if (moved > 0) {
        health.fails = 0;
      } else if (sent >= HEALTH_MIN_SENT) {
        health.fails++;
        if (health.fails >= HEALTH_FAILS && self.method < METHODS.length - 1) {
          self.note(METHODS[self.method] + ": " + sent + " packets sent, strip counted none; trying " + METHODS[self.method + 1]);
          self.method++;
          health.switches++;
          health.fails = 0;
          self.openMethod();
          health.counter = null; // start counting again for the new way
          return;
        }
      }
    }
    health.counter = value;
    health.sentAt = sentNow;
  });
};

// The strip has no connection: the first frame is simply the first packet.
Strip.prototype.setGoals = function (zones) {
  var regions = this.regions;
  colourEngine.STRIP_ZONES.forEach(function (name) { if (zones[name]) regions[name].setGoal(zones[name]); });
};

Strip.prototype.record = function (list, ms) {
  list.push(ms);
  if (list.length > STATS_WINDOW) list.shift();
};

// Glide every zone one step, then send when the strip would actually look different.
Strip.prototype.tick = function (dt, level) {
  var regions = this.regions, order = this.order, bright = this.bright, colours = [], ready = false;
  order.forEach(function (name) {
    var state = regions[name].step(dt);
    if (state) ready = true;
    colours.push(stateToRgb(state, level, bright));
  });
  if (!ready) return;
  this.colours = colours;
  this.send(buildPayload(colours), false);
};

Strip.prototype.send = function (payload, force) {
  var key = payload.toString("hex"), method = this.currentMethod();
  if (this.closed) return false;
  if (!force && key === this.last) { this.skipped++; return false; }
  var begun = Date.now(), self = this, packet;
  this.sequence = this.sequence % 15 + 1;
  try {
    if (method === "http") {
      this.sendHttp(payload);
    } else {
      packet = buildPacket(payload, this.sequence);
      // Node 4 (the TV) only knows send(buffer, offset, length, port, address, callback)
      if (method === "udp-fresh") {
        var fresh = require("dgram").createSocket("udp4");
        fresh.on("error", function (error) { self.note(String((error && error.message) || error)); });
        fresh.send(packet, 0, packet.length, this.ddpPort, this.ip, function (error) {
          if (error) self.note(String(error.message || error));
          try { fresh.close(); } catch (_) {}
        });
      } else if (this.socket) {
        this.socket.send(packet, 0, packet.length, this.ddpPort, this.ip, function (error) {
          if (error) self.note(String(error.message || error));
        });
      } else {
        return false;
      }
    }
  } catch (error) {
    this.note(String((error && error.message) || error));
    return false;
  }
  this.record(this.sendMs, Date.now() - begun);
  this.last = key;
  this.sent++;
  return true;
};

// OpenBeken's own command interface; one request at a time, a newer frame replaces a waiting one.
Strip.prototype.sendHttp = function (payload) {
  var self = this;
  if (this.httpBusy) { this.httpWaiting = payload; return; }
  this.httpBusy = true;
  var done = false;
  function fin(error) {
    if (done) return;
    done = true;
    self.httpBusy = false;
    if (error) self.note("http: " + String((error && error.message) || error));
    if (self.httpWaiting && !self.closed) { var next = self.httpWaiting; self.httpWaiting = null; self.sendHttp(next); }
  }
  try {
    var path = "/cm?cmnd=" + encodeURIComponent("SM16703P_SetRaw 1 0 " + payload.toString("hex"));
    var request = require("http").get({ host: this.ip, port: this.webPort, path: path, agent: false }, function (response) {
      response.resume();
      response.on("end", function () { fin(response.statusCode === 200 ? null : new Error("HTTP " + response.statusCode)); });
    });
    request.setTimeout(2000, function () { request.abort(); fin(new Error("timeout")); });
    request.on("error", fin);
  } catch (error) {
    fin(error);
  }
};

// UDP can drop a packet: say "off" a few times.
Strip.prototype.close = function () {
  var self = this, black = buildPayload([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  clearInterval(this.healthTimer);
  if (this.closed) return;
  if (this.currentMethod() === "http") {
    this.httpWaiting = null;
    this.send(black, true);
    setTimeout(function () { self.closed = true; }, 600);
    return;
  }
  [0, 40, 80].forEach(function (delay) { setTimeout(function () { self.send(black, true); }, delay); });
  setTimeout(function () { self.closed = true; self.closeSocket(); }, 200);
};

function median(list) {
  if (!list.length) return 0;
  var sorted = list.slice().sort(function (a, b) { return a - b; });
  return sorted[Math.floor(sorted.length / 2)];
}

Strip.prototype.describe = function () {
  return {
    ip: this.ip,
    order: this.order,
    bright: Math.round(this.bright * 100),
    sent: this.sent,
    unchanged: this.skipped,
    errors: this.errors,
    method: this.currentMethod(),
    health: this.health ? { counter: this.health.counter, moved: this.health.moved, available: this.health.available,
      error: this.health.error, switches: this.health.switches } : null,
    analyseMs: Math.round(median(this.analyseMs) * 10) / 10, // picture -> 8 zone goals, on the TV
    sendMs: Math.round(median(this.sendMs) * 10) / 10,
    segments: this.colours.map(function (c) { return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]; })
  };
};

module.exports = {
  Strip: Strip,
  DEFAULT_IP: DEFAULT_IP,
  _internals: {
    segmentOrder: segmentOrder,
    stateToRgb: stateToRgb,
    buildPayload: buildPayload,
    buildPacket: buildPacket,
    normalizeIp: normalizeIp
  }
};
