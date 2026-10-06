"use strict";

// Logic of the capture lab that does not need a TV: the command channel between a controller (a script on a PC) and the lab's web page
// on the TV, scoring of captured pictures against the known test video, and the test plans. Plain ES5 (the TV's service runs Node 4).

var SETS = ["RGB", "GBR", "BRG"]; // left / middle / right colours of the test clip in each 2 s phase, repeating every 6 s
var CLIP_SECONDS = 12;

// ---------------------------------------------------------------- scoring
function classify(c) {
  var m = Math.max(c[0], c[1], c[2]);
  if (m < 40) return "K";
  var s = [c[0], c[1], c[2]].sort(function (a, b) { return b - a; });
  if (s[0] - s[1] < 60) return m > 200 ? "W" : "?";
  return c[0] === m ? "R" : (c[1] === m ? "G" : "B");
}

// Colours that should be on screen `seconds` after the clip started; null close to a change (not judged).
function expectedAt(seconds) {
  var t = ((seconds % CLIP_SECONDS) + CLIP_SECONDS) % CLIP_SECONDS, d = t - 2 * Math.floor(t / 2);
  if (d < 0.45 || d > 1.55) return null;
  return SETS[Math.floor(t / 2) % 3];
}

// series: the result of /ambilight/capture-series; clipStartEpoch: when the clip's time 0 was (ms since 1970).
function scoreSeries(series, clipStartEpoch) {
  var samples = (series && series.samples) || [];
  var out = { verdict: "NO PICTURES", pictures: samples.length, perSecond: series ? series.perSecond : 0, errors: series ? series.errors : [] };
  if (!samples.length) return out;
  var distinct = {}, black = 0, sizeMin = Infinity, sizeMax = 0, classCounts = {};
  samples.forEach(function (s) {
    distinct[s.bytes + ":" + s.sum] = (distinct[s.bytes + ":" + s.sum] || 0) + 1;
    if (Math.max(s.L[0], s.L[1], s.L[2], s.C[0], s.C[1], s.C[2], s.R[0], s.R[1], s.R[2]) < 40) black++;
    if (s.bytes < sizeMin) sizeMin = s.bytes;
    if (s.bytes > sizeMax) sizeMax = s.bytes;
    var key = classify(s.L) + classify(s.C) + classify(s.R);
    classCounts[key] = (classCounts[key] || 0) + 1;
  });
  var keys = Object.keys(distinct), top = 0;
  keys.forEach(function (k) { if (distinct[k] > top) top = distinct[k]; });
  out.timing = series.timing || null; // median / 90th percentile ms: capture call, file read, decode
  out.distinctPictures = keys.length;
  out.sizeRange = [sizeMin, sizeMax];
  out.classCounts = classCounts;
  out.first = { L: samples[0].L, C: samples[0].C, R: samples[0].R };
  out.last = { L: samples[samples.length - 1].L, C: samples[samples.length - 1].C, R: samples[samples.length - 1].R };
  // best agreement with the expected colours, allowing for the unknown delay between asking for a picture and the picture being taken
  var best = { ratio: 0, offset: 0, checked: 0, matched: 0 }, offset, i;
  for (offset = -0.8; offset <= 0.81; offset += 0.1) {
    var checked = 0, matched = 0;
    for (i = 0; i < samples.length; i++) {
      var expected = expectedAt((series.startEpoch + samples[i].t - clipStartEpoch) / 1000 + offset);
      if (expected === null) continue;
      checked++;
      if (classify(samples[i].L) === expected.charAt(0) && classify(samples[i].C) === expected.charAt(1) && classify(samples[i].R) === expected.charAt(2)) matched++;
    }
    var ratio = checked ? matched / checked : 0;
    if (ratio > best.ratio || (ratio === best.ratio && checked > best.checked)) best = { ratio: ratio, offset: Math.round(offset * 10) / 10, checked: checked, matched: matched };
  }
  out.score = Math.round(best.ratio * 100) / 100;
  out.offsetS = best.offset;
  out.checked = best.checked;
  out.matched = best.matched;
  if (black / samples.length >= 0.9) out.verdict = "BLACK";
  else if (top / samples.length >= 0.9 && samples.length >= 4) out.verdict = "STATIC"; // the same picture over and over
  else if (best.ratio >= 0.85 && best.checked >= 6) out.verdict = "PASS";
  else out.verdict = "WRONG";
  return out;
}

// ---------------------------------------------------------------- command channel
// A controller sends commands; the lab page on the TV long-polls for them, runs them and reports an event per command.
function Hub(options) {
  options = options || {};
  this.nextId = 1;
  this.queue = [];
  this.pollers = [];
  this.pending = {};
  this.events = [];
  this.ui = { lastSeen: 0, info: null };
  this.uiAliveMs = options.uiAliveMs || 25000;
}

Hub.prototype.uiConnected = function () {
  return Date.now() - this.ui.lastSeen < this.uiAliveMs;
};

// Queues a command for the page. Promise of the page's answer ({ ok, data } or an error).
Hub.prototype.send = function (command, timeoutMs) {
  var self = this, id = this.nextId++;
  command = JSON.parse(JSON.stringify(command));
  command.id = id;
  return new Promise(function (resolve, reject) {
    if (!self.uiConnected()) { reject(new Error("the lab page on the TV is not connected (open the Capture Lab app)")); return; }
    var timer = setTimeout(function () {
      delete self.pending[id];
      reject(new Error("the lab page did not answer " + command.type + " within " + Math.round((timeoutMs || 30000) / 1000) + " s"));
    }, timeoutMs || 30000);
    self.pending[id] = { resolve: resolve, reject: reject, timer: timer, command: command };
    self.queue.push(command);
    self.flush();
  });
};

// Hands the next command to a waiting poller.
Hub.prototype.flush = function () {
  while (this.queue.length && this.pollers.length) {
    var poller = this.pollers.shift();
    clearTimeout(poller.timer);
    poller.cb(this.queue.shift());
  }
};

// The page asks for work: cb(command) or cb(null) after timeoutMs.
Hub.prototype.poll = function (timeoutMs, info, cb) {
  var self = this;
  this.ui.lastSeen = Date.now();
  if (info) this.ui.info = info;
  if (this.queue.length) { cb(this.queue.shift()); return; }
  var poller = { cb: cb };
  poller.timer = setTimeout(function () {
    var index = self.pollers.indexOf(poller);
    if (index >= 0) self.pollers.splice(index, 1);
    self.ui.lastSeen = Date.now();
    cb(null);
  }, timeoutMs);
  this.pollers.push(poller);
};

// The page reports on a command: { id, status: "done" | "error" | "progress", data, error }.
Hub.prototype.event = function (event) {
  this.ui.lastSeen = Date.now();
  this.events.push({ at: Date.now(), id: event.id, status: event.status, error: event.error || null, data: event.status === "progress" ? event.data : undefined });
  if (this.events.length > 200) this.events.shift();
  var entry = this.pending[event.id];
  if (!entry || event.status === "progress") return;
  clearTimeout(entry.timer);
  delete this.pending[event.id];
  if (event.status === "error") entry.reject(new Error(event.error || "the lab page reported an error"));
  else entry.resolve(event.data || {});
};

// ---------------------------------------------------------------- test plans
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// ctx: { hub, series(mode, seconds) -> Promise<series>, progress(text), sleep }. opts: { clips, engines, modes, seconds, warm }.
function runMatrix(ctx, opts) {
  var clips = opts.clips, engines = opts.engines, modes = opts.modes, seconds = opts.seconds || 6, wait = ctx.sleep || sleep;
  var combos = [], results = [];
  clips.forEach(function (clip) {
    engines.forEach(function (engine) {
      if (opts.warm) combos.push({ clip: clip, engine: engine, modes: modes });
      else modes.forEach(function (mode) { combos.push({ clip: clip, engine: engine, modes: [mode] }); });
    });
  });
  var chain = Promise.resolve();
  combos.forEach(function (combo, index) {
    chain = chain.then(function () {
      var label = combo.clip + " / " + combo.engine + " / mode " + combo.modes.join(",");
      ctx.progress((index + 1) + "/" + combos.length + " " + label);
      return ctx.hub.send({ type: "play", clip: combo.clip, engine: combo.engine }, 45000).then(function (played) {
        var settle = opts.warm ? wait(1500) : Promise.resolve(); // a cold test captures straight away, like a session starting with the movie
        var inner = settle;
        combo.modes.forEach(function (mode) {
          inner = inner.then(function () {
            return ctx.series(mode, seconds).then(function (series) {
              var scored = scoreSeries(series, played.clipStartEpoch);
              scored.clip = combo.clip; scored.engine = combo.engine; scored.mode = mode; scored.startupMs = played.startupMs; scored.warm = !!opts.warm;
              results.push(scored);
            });
          });
        });
        return inner;
      }).catch(function (error) {
        combo.modes.forEach(function (mode) { results.push({ clip: combo.clip, engine: combo.engine, mode: mode, verdict: "PLAY FAILED", error: String(error.message || error) }); });
      }).then(function () {
        return ctx.hub.send({ type: "stop" }, 15000).catch(function () {}).then(function () { return wait(700); });
      });
    });
  });
  return chain.then(function () { return results; });
}

module.exports = { classify: classify, expectedAt: expectedAt, scoreSeries: scoreSeries, Hub: Hub, runMatrix: runMatrix, SETS: SETS, CLIP_SECONDS: CLIP_SECONDS };
