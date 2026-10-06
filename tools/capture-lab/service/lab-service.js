/* global module, require, process, __dirname */
"use strict";

// Web service of the Capture Lab. It serves the test clips, relays commands from a controller on the PC to the lab page,
// runs the test matrix, and exposes the ambilight service's /ambilight/* routes (capture methods) unchanged.
var http = require("http");
var fs = require("fs");
var path = require("path");
var url = require("url");
var core = require("./lab-core.cjs");
var ambilight;
try { ambilight = require("./runtime/ambilight.cjs"); } catch (e) { ambilight = require("../../../services/tizen/runtime/ambilight.cjs"); } // the second path is for running from the repository

var PORTS = [2720, 2721, 2722, 2723];
var MEDIA_DIR = path.join(__dirname, "..", "media");
var CLIPS = ["h264-720p.mp4", "h264-1080p.mp4", "hevc-1080p-8bit.mp4", "hevc-1080p-10bit.mp4"];
var hub = new core.Hub();
var server = null, port = 0;
var job = { running: false, plan: null, progress: [], results: null, error: null, startedAt: 0, finishedAt: 0 };

function sendJson(response, status, body) {
  var text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}

function list(value, fallback) {
  if (!value) return fallback;
  return String(value).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}

function readBody(request, cb) {
  var chunks = [], size = 0;
  request.on("data", function (c) { size += c.length; if (size < 1000000) chunks.push(c); });
  request.on("end", function () { cb(Buffer.concat(chunks).toString("utf8")); });
}

// One capture series through the ambilight routes of this same service.
function series(mode, seconds) {
  return new Promise(function (resolve, reject) {
    var request = http.get({ host: "127.0.0.1", port: port, path: "/ambilight/capture-series?mode=" + mode + "&seconds=" + seconds + "&max=" + Math.min(300, Math.ceil(seconds * 40)) }, function (response) {
      var text = "";
      response.setEncoding("utf8");
      response.on("data", function (c) { text += c; });
      response.on("end", function () {
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error("capture-series answered with something that is not JSON")); }
      });
    });
    request.on("error", reject);
    request.setTimeout((seconds + 40) * 1000, function () { request.abort(); reject(new Error("capture-series timed out")); });
  });
}

function startMatrix(query) {
  if (job.running) return false;
  var opts = {
    clips: list(query.clips, CLIPS),
    engines: list(query.engines, ["html", "avplay"]),
    modes: list(query.modes, ["1", "2", "3"]).map(Number),
    seconds: Number(query.seconds) || 6,
    warm: query.warm === "1" || query.warm === "true"
  };
  job = { running: true, plan: "matrix", options: opts, progress: [], results: null, error: null, startedAt: Date.now(), finishedAt: 0 };
  var mine = job;
  core.runMatrix({
    hub: hub,
    series: series,
    progress: function (text) { mine.progress.push(text); }
  }, opts).then(function (results) {
    mine.results = results;
  }, function (error) {
    mine.error = String(error && error.message || error);
  }).then(function () {
    mine.running = false;
    mine.finishedAt = Date.now();
  });
  return true;
}

function serveMedia(request, response, name) {
  var clean = path.basename(name);
  var file = path.join(MEDIA_DIR, clean);
  fs.stat(file, function (error, stat) {
    if (error || !stat.isFile()) { response.writeHead(404, { "Access-Control-Allow-Origin": "*" }); response.end("no such clip"); return; }
    var range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ""));
    var start = 0, end = stat.size - 1, status = 200;
    if (range) {
      if (range[1] !== "") { start = Number(range[1]); if (range[2] !== "") end = Math.min(end, Number(range[2])); }
      else if (range[2] !== "") { start = Math.max(0, stat.size - Number(range[2])); }
      if (start > end || start >= stat.size) {
        response.writeHead(416, { "Content-Range": "bytes */" + stat.size, "Access-Control-Allow-Origin": "*" });
        response.end();
        return;
      }
      status = 206;
    }
    var headers = {
      "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
      "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges", "Cache-Control": "no-store"
    };
    if (status === 206) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + stat.size;
    response.writeHead(status, headers);
    if (request.method === "HEAD") { response.end(); return; }
    fs.createReadStream(file, { start: start, end: end }).pipe(response);
  });
}

function handle(request, response) {
  var parsed = url.parse(String(request.url || ""), true), query = parsed.query || {}, p = parsed.pathname || "";
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Range", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS" });
      response.end();
      return;
    }
    if (ambilight.isAmbilightRequest(String(request.url || ""))) { ambilight.handleRequest(request, response); return; }
    if (p.indexOf("/media/") === 0) { serveMedia(request, response, decodeURIComponent(p.slice(7))); return; }
    switch (p) {
      case "/lab/health":
        sendJson(response, 200, { ok: true, lab: true, port: port, uiConnected: hub.uiConnected(), ui: hub.ui.info, clips: CLIPS, job: { running: job.running, plan: job.plan } });
        return;
      case "/lab/poll": {
        var info = null;
        try { info = query.info ? JSON.parse(query.info) : null; } catch (e) { info = null; }
        hub.poll(20000, info, function (command) { sendJson(response, 200, { ok: true, command: command }); });
        return;
      }
      case "/lab/event":
        readBody(request, function (text) {
          var event = null;
          try { event = JSON.parse(text); } catch (e) { sendJson(response, 400, { ok: false, error: "bad JSON" }); return; }
          hub.event(event);
          sendJson(response, 200, { ok: true });
        });
        return;
      case "/lab/events":
        sendJson(response, 200, { ok: true, events: hub.events.slice(-60) });
        return;
      case "/lab/command": {
        var command = { type: String(query.type || "") };
        Object.keys(query).forEach(function (k) { if (k !== "type" && k !== "wait") command[k] = query[k]; });
        hub.send(command, (Number(query.wait) || 30) * 1000).then(function (data) {
          sendJson(response, 200, { ok: true, data: data });
        }, function (error) {
          sendJson(response, 200, { ok: false, error: String(error && error.message || error) });
        });
        return;
      }
      case "/lab/run":
        if (query.plan !== "matrix") { sendJson(response, 400, { ok: false, error: "unknown plan (matrix)" }); return; }
        sendJson(response, 200, { ok: true, started: startMatrix(query) });
        return;
      case "/lab/job":
        sendJson(response, 200, { ok: true, job: job });
        return;
      default:
        sendJson(response, 404, { ok: false, error: "unknown route " + p });
    }
  } catch (error) {
    sendJson(response, 500, { ok: false, error: String(error && error.stack || error) });
  }
}

function listen(index) {
  if (index >= PORTS.length) return;
  var candidate = http.createServer(handle);
  candidate.on("error", function () { listen(index + 1); });
  candidate.listen(PORTS[index], function () { server = candidate; port = PORTS[index]; });
}

module.exports.onStart = function () { if (!server) listen(0); };
module.exports.onExit = function () {
  try { ambilight.stop("service-exit"); } catch (e) {}
  try { if (server) server.close(); } catch (e2) {}
  server = null;
};
module.exports.onStop = module.exports.onExit;
module.exports._test = { handle: handle, hub: hub, setPort: function (p) { port = p; }, getJob: function () { return job; }, startMatrix: startMatrix };
