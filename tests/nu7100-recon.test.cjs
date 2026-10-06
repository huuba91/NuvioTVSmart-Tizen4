"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var test = require("node:test");
var acorn = require("acorn");

var DIR = path.join(__dirname, "..", "tools", "nu7100-recon");
var FILES = ["js/core.js", "js/tests/system.js", "js/tests/filesystem.js", "js/tests/dcapture.js", "js/tests/process.js", "js/tests/network.js", "js/tests/ipc.js", "js/app.js"];

test("the recon app is plain ES5 (Chromium M56 on the TV)", function () {
  FILES.forEach(function (file) {
    acorn.parse(fs.readFileSync(path.join(DIR, file), "utf8"), { ecmaVersion: 5 });
  });
  assert.ok(fs.statSync(path.join(DIR, "config.xml")).size > 0);
  assert.match(fs.readFileSync(path.join(DIR, "config.xml"), "utf8"), /package="NU7100Reco"/);
  assert.equal("NU7100Reco".length, 10, "Tizen package ids are exactly 10 characters");
});

// A small in-memory tizen.filesystem: two writable directories and one that refuses.
function fakeTizen() {
  var store = { "/tmp": {}, "/dev/shm": { "nuvio-series.jpg": "\xff\xd8\xff\xe0abc" } };
  function dirObject(p) {
    return {
      isDirectory: true, isFile: false, readOnly: false, fullPath: p, name: p.split("/").pop(), toURI: function () { return "file://" + p; },
      listFiles: function (ok) { ok(Object.keys(store[p]).map(function (n) { return fileObject(p, n); })); },
      createFile: function (n) { store[p][n] = ""; return fileObject(p, n); },
      deleteFile: function (full, ok, err) { var n = full.split("/").pop(); if (store[p][n] !== undefined && full.indexOf(p) === 0) { delete store[p][n]; ok(); } else err({ name: "NotFoundError" }); }
    };
  }
  function fileObject(p, n) {
    return {
      isDirectory: false, isFile: true, readOnly: false, name: n, fullPath: p + "/" + n, fileSize: store[p][n].length, modified: new Date(1e12), toURI: function () { return "file://" + p + "/" + n; },
      openStream: function (mode, ok) {
        ok({ readBytes: function (c) { return store[p][n].split("").slice(0, c).map(function (ch) { return ch.charCodeAt(0); }); }, write: function (s) { store[p][n] = s; }, close: function () {} });
      }
    };
  }
  return {
    filesystem: {
      listStorages: function (ok) { ok([{ label: "internal", type: "INTERNAL", state: "MOUNTED" }]); },
      resolve: function (loc, ok, err) {
        var p = loc.replace(/^file:\/\//, "");
        if (store[p]) { ok(dirObject(p)); return; }
        var dir = p.replace(/\/[^/]*$/, ""), name = p.split("/").pop();
        if (store[dir] && store[dir][name] !== undefined) { ok(fileObject(dir, name)); return; }
        if (p === "/proc") { err({ name: "SecurityError", message: "permission denied" }); return; }
        err({ name: "NotFoundError", message: "no " + p });
      }
    },
    systeminfo: { getPropertyValue: function (prop, ok, err) { if (prop === "BUILD") ok({ model: "UE49NU7100" }); else err({ name: "NotSupportedError" }); }, getCapabilities: function () { return { platformVersion: "4.0" }; } },
    application: { getCurrentApplication: function () { return { contextId: "1", appInfo: { id: "A.B", name: "n", packageId: "A", version: "1", installDate: new Date(0) } }; },
      getAppsContext: function (ok) { ok([{ id: "9", appId: "x.y" }]); }, getAppsInfo: function (ok) { ok([{ id: "x.y", name: "X" }]); } }
  };
}

function load() {
  var window = { tizen: fakeTizen(), navigator: { userAgent: "Mozilla Chromium/56", platform: "Linux armv7l", language: "en", mimeTypes: [], plugins: [] }, screen: { width: 1920, height: 1080 },
    setTimeout: setTimeout, clearTimeout: clearTimeout, ArrayBuffer: ArrayBuffer, Uint8Array: Uint8Array, performance: { now: function () { return 1; } }, devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080, console: console };
  window.window = window;
  window.XMLHttpRequest = function () { var self = this; this.open = function () {}; this.send = function () { setTimeout(function () { self.onerror(); }, 1); }; };
  window.WebSocket = function () { var self = this; setTimeout(function () { self.onerror(); }, 1); this.close = function () {}; };
  var context = vm.createContext(window);
  FILES.slice(0, 7).forEach(function (file) { vm.runInContext(fs.readFileSync(path.join(DIR, file), "utf8"), context, { filename: file }); });
  return context;
}

test("every recon test finishes with a structured result, and refusals are not crashes", function (t, done) {
  var context = load(), R = context.Recon, finished = 0;
  R.inputs.dcapturePath = "/dev/shm/nuvio-series.jpg";
  assert.ok(R.tests.length >= 30, "tests defined: " + R.tests.length);
  R.run("all", function () { finished++; }, function () {
    assert.equal(finished, R.tests.length);
    R.tests.forEach(function (tt) {
      var r = R.results[tt.id];
      assert.ok(r, "result for " + tt.id);
      assert.ok(R.STATUSES.indexOf(r.status) >= 0, tt.id + " status " + r.status);
      ["id", "category", "name", "status", "value", "error", "timestamp"].forEach(function (k) { assert.ok(k in r, tt.id + " has " + k); });
    });
    var status = function (id) { return R.results[id].status; };
    assert.equal(status("filesystem.path./dev/shm"), "PASS");
    assert.equal(R.results["filesystem.path./dev/shm"].value.entries[0].indexOf("nuvio-series.jpg") >= 0, true);
    assert.equal(status("filesystem.path./proc"), "BLOCKED", "a permission error is BLOCKED, not a crash");
    assert.equal(status("filesystem.write./dev/shm"), "PASS");
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(context.Recon.results["filesystem.write./tmp"].value)).steps).length > 3, true);
    assert.equal(Object.keys(vm.runInContext("({})", context)).length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(R.report().dcapture["dcapture.known_path"].value.looksLikeJpeg)), true);
    assert.equal(status("dcapture.shm_list"), "PASS");
    assert.equal(status("process.node_globals"), "NOT_AVAILABLE");
    assert.equal(status("network.localhost.127.0.0.1"), "FAIL");
    assert.equal(status("network.websocket"), "FAIL");
    assert.equal(status("ipc.nacl"), "NOT_AVAILABLE");
    // the files made by the tests were removed again
    var after = R.results["filesystem.write./tmp"].value;
    assert.equal(after.created, true);
    assert.equal(after.deleted, true);
    var fp = R.fingerprint().join("\n");
    assert.match(fp, /MODEL=/);
    assert.match(fp, /FILESYSTEM=\/dev\/shm=VISIBLE/);
    assert.match(fp, /NODEJS=NO/);
    assert.match(fp, /D-BUS=NO/);
    var report = R.report();
    ["application", "device", "apis", "filesystem", "process", "network", "ipc", "dcapture", "tests"].forEach(function (k) { assert.ok(k in report, "report has " + k); });
    done();
  });
});
