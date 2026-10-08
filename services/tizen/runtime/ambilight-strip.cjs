/* global module, require */
"use strict";

// Surround strip for the TV ambilight: an addressable LED strip (LSC 3 m RGBIC running OpenBeken
// with the DDP driver) laid round the back of the TV in a rectangle. Each of its 8 segments follows
// the edge of the picture next to it (ambilight-colour.cjs: STRIP_ZONES), and the colours go out as
// one DDP packet per change over UDP (ddp-packet.cjs builds the bytes and paces them).
//
// OpenBeken startup command (same as the PC's strip_sync.py):
//   backlog startDriver SM16703P; SM16703P_Init 16 BRG; startDriver DDP
// That gives 16 pixels: even ones are the RGB segments 1..8, odd ones are white chips kept off.
//
// Everything that can be set (address, port, brightness, saturation, smoothing, layout) comes from
// the app (js/data/local/ambilightSettingsStore.js) with /ambilight/start or /ambilight/config.
// DEFAULT_IP is only a last resort for a request that names no address at all.

var colourEngine = require("./ambilight-colour.cjs");
var ddp = require("./ddp-packet.cjs");

var SEGMENTS = ddp.ZONES;
var DDP_PORT = 4048;
var DEFAULT_IP = "192.168.129.20";
var GAMMA = 2.2; // LEDs are linear, the screen colours are not
var DEFAULT_BRIGHT = 0.6; // PC strip_sync.py default
var DEFAULT_SATURATION = 1.3; // PC strip_sync.py default
var WARM_WHITE = [255, 170, 90];
var STATS_WINDOW = 200;
var BLACKOUT_DELAYS = [0, 40, 80]; // ms: UDP can drop a packet, so "off" is said three times
// The strip is a lot more responsive than a bulb (one UDP packet, no acknowledgement), so by default
// its colours follow the picture much faster than the bulbs' 0.6 s: drifts settle in ~0.15 s, cuts in
// ~0.05 s ("medium"). "high" is the bulbs' own glide (ambilight-colour.cjs), "low" follows closer still.
var SMOOTHING = {
  low: { smoothing: 0.08, cutSmoothing: 0.04 },
  medium: { smoothing: 0.15, cutSmoothing: 0.05 },
  high: { smoothing: 0.6, cutSmoothing: 0.08 }
};

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function normalizeIp(value) {
  var text = String(value || "").trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return "";
  return text.split(".").every(function (part) { return Number(part) <= 255; }) ? text : "";
}

function normalizePort(value) {
  var n = Math.round(Number(value));
  return isFinite(n) && n >= 1 && n <= 65535 ? n : 0;
}

function normalizeSmoothing(value) {
  var text = String(value || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(SMOOTHING, text) ? text : "medium";
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
function stateToRgb(state, level, bright, saturation) {
  var scale = clamp(level, 0, 100) / 100 * bright, hsv, rgb, i;
  if (!state) return [0, 0, 0];
  if (state.mode === "white") {
    var white = colourEngine.WHITE_BRIGHTNESS * 6 * scale; // warm light, a little stronger than the bulbs' 5%
    return [WARM_WHITE[0] * white, WARM_WHITE[1] * white, WARM_WHITE[2] * white];
  }
  hsv = [state.hsv[0], Math.min(1, state.hsv[1] * (saturation > 0 ? saturation : DEFAULT_SATURATION)), state.hsv[2]];
  rgb = hsvToRgb(hsv);
  for (i = 0; i < 3; i++) rgb[i] = 255 * Math.pow(rgb[i], GAMMA) * scale;
  return rgb;
}

function hsvToRgb(hsv) {
  var h = (((hsv[0] % 1) + 1) % 1) * 6, s = hsv[1], v = hsv[2], i = Math.floor(h), f = h - i;
  var p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

var buildPayload = ddp.buildPayload;
var buildPacket = ddp.buildPacket;

function Strip(config) {
  this.regions = {};
  this.configure(config);
  this.socket = null;
  this.method = 0;
  this.closed = false;
  this.dark = false;
  this.httpBusy = false;
  this.httpWaiting = null;
  this.sequence = 0;
  this.pacer = new ddp.Pacer(ddp.KEEP_ALIVE_MS);
  this.sent = 0;
  this.keepAlives = 0;
  this.skipped = 0;
  this.errors = [];
  this.sendMs = [];
  this.analyseMs = [];
  this.colours = [];
}

// Also used while running, when a setting changes mid-playback (/ambilight/config): nothing restarts,
// the next tick simply uses the new values. A new address or port reopens the socket.
Strip.prototype.configure = function (config) {
  config = config || {};
  var ip = normalizeIp(config.ip), port = normalizePort(config.ddpPort) || DDP_PORT;
  var moved = this.ip !== undefined && (this.ip !== (ip || DEFAULT_IP) || this.ddpPort !== port);
  this.ipFallback = !ip; // the app named no address: last-resort default
  this.ip = ip || DEFAULT_IP;
  this.ddpPort = port;
  this.order = segmentOrder(config.start, config.clockwise !== false);
  this.bright = clamp(Number(config.bright) > 0 ? Number(config.bright) / 100 : DEFAULT_BRIGHT, 0.05, 1);
  this.saturation = clamp(Number(config.saturation) > 0 ? Number(config.saturation) / 100 : DEFAULT_SATURATION, 0.5, 2.5);
  this.smoothing = normalizeSmoothing(config.smoothing);
  this.webPort = config.webPort || 80;
  this.healthMs = config.healthMs || HEALTH_MS;
  var follow = SMOOTHING[this.smoothing];
  colourEngine.STRIP_ZONES.forEach(function (name) {
    var region = this.regions[name];
    if (!region) { this.regions[name] = new colourEngine.Region(follow); return; }
    region.options = follow;
    if (region.glide) { region.glide.smoothing = follow.smoothing; region.glide.cutSmoothing = follow.cutSmoothing; }
  }, this);
  if (moved && this.health && !this.closed) this.openMethod();
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
  this.pacer.reset(); // the next frame goes out even when it equals the last one
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

// New zone goals from a fresh frame (capture or a native zone source). The strip has no
// connection: the first frame is simply the first packet.
Strip.prototype.setGoals = function (zones) {
  var regions = this.regions;
  colourEngine.STRIP_ZONES.forEach(function (name) { if (zones[name]) regions[name].setGoal(zones[name]); });
};

Strip.prototype.record = function (list, ms) {
  list.push(ms);
  if (list.length > STATS_WINDOW) list.shift();
};

// Glide every zone one step, then send when the strip would actually look different, or once a
// second as a keep-alive when nothing changed. Dark (paused to black, blacked out): black only.
Strip.prototype.tick = function (dt, level, now) {
  var regions = this.regions, bright = this.bright, saturation = this.saturation, colours = [], ready = false;
  if (this.dark) {
    this.send(buildPayload(ddp.blackZones()), false, now);
    return;
  }
  this.order.forEach(function (name) {
    var state = regions[name].step(dt);
    if (state) ready = true;
    colours.push(stateToRgb(state, level, bright, saturation));
  });
  if (!ready) return;
  this.colours = colours;
  this.send(buildPayload(colours), false, now);
};

// Paced send of the newest frame (there is no queue, so nothing stale is ever sent): a changed frame
// goes at once, an identical one only as the keep-alive. force: always (black on blackout/close).
Strip.prototype.send = function (payload, force, now) {
  var key = payload.toString("hex"), method = this.currentMethod(), decision, packet;
  if (this.closed) return false;
  now = now || Date.now();
  decision = force ? "send" : this.pacer.decide(key, now);
  if (decision === "skip") { this.skipped++; return false; }
  var begun = Date.now(), self = this;
  this.sequence = ddp.nextSequence(this.sequence);
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
  this.pacer.sent(key, now);
  if (decision === "keepalive") this.keepAlives++;
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

// Goes dark now: a few black packets a few tens of ms apart, then black keep-alives from tick()
// until resume().
Strip.prototype.blackout = function () {
  var self = this, black = buildPayload(ddp.blackZones());
  this.dark = true;
  if (this.closed) return;
  if (this.currentMethod() === "http") {
    this.httpWaiting = null;
    this.send(black, true);
    return;
  }
  BLACKOUT_DELAYS.forEach(function (delay) {
    if (!delay) { self.send(black, true); return; }
    setTimeout(function () { if (self.dark) self.send(black, true); }, delay);
  });
};

// Back to following the picture; the first frame goes out even if it equals the last one sent.
Strip.prototype.resume = function () {
  this.dark = false;
  this.pacer.reset();
};

Strip.prototype.close = function () {
  var self = this;
  clearInterval(this.healthTimer);
  if (this.closed) return;
  this.blackout();
  if (this.currentMethod() === "http") {
    setTimeout(function () { self.closed = true; }, 600);
    return;
  }
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
    ipFallback: this.ipFallback,
    port: this.ddpPort,
    order: this.order,
    bright: Math.round(this.bright * 100),
    saturation: Math.round(this.saturation * 100),
    smoothing: this.smoothing,
    dark: this.dark,
    sent: this.sent,
    keepAlives: this.keepAlives,
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
  DDP_PORT: DDP_PORT,
  SMOOTHING: SMOOTHING,
  _internals: {
    segmentOrder: segmentOrder,
    stateToRgb: stateToRgb,
    buildPayload: buildPayload,
    buildPacket: buildPacket,
    normalizeIp: normalizeIp,
    normalizePort: normalizePort,
    normalizeSmoothing: normalizeSmoothing
  }
};
