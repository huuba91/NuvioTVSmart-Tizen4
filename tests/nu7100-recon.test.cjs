"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var test = require("node:test");
var acorn = require("acorn");

var DIR = path.join(__dirname, "..", "tools", "nu7100-recon");
var FILES = ["js/core.js", "js/tests/system.js", "js/tests/filesystem.js", "js/tests/sharedmem.js", "js/tests/dcapture.js", "js/tests/process.js", "js/tests/network.js", "js/tests/ipc.js", "js/app.js"];

test("the recon app is plain ES5 (Chromium M56 on the TV)", function () {
  FILES.forEach(function (file) {
    acorn.parse(fs.readFileSync(path.join(DIR, file), "utf8"), { ecmaVersion: 5 });
  });
  assert.ok(fs.statSync(path.join(DIR, "config.xml")).size > 0);
  assert.match(fs.readFileSync(path.join(DIR, "config.xml"), "utf8"), /package="NU7100Reco"/);
  assert.equal("NU7100Reco".length, 10, "Tizen package ids are exactly 10 characters");
});

// A small in-memory tizen.filesystem: two writable directories and one that refuses. Streams keep a `position` (readBytes
// advances it) so the multi-offset window reads can be tested against real content at each offset.
function repeat(ch, length) {
  var s = "", chunk = new Array(1025).join(ch);
  while (s.length < length) s += chunk;
  return s.slice(0, length);
}
function fakeTizen() {
  var jpeg = "\xff\xd8\xff\xe0" + repeat("x", 40) + "\xff\xd9";
  var inspectorTail = "port=37011 token=abc";
  var inspector = repeat("\x00", 256) + inspectorTail + repeat("\x00", 412 - 256 - inspectorTail.length);
  var ave = repeat("A", 270 * 1024); // bigger than the 256 KB named offset (and not an exact multiple, so end-4KB stays a distinct offset)
  var tddg = repeat("B", 1060 * 1024); // bigger than the 1 MB named offset, same reasoning
  var store = { "/tmp": {}, "/dev/shm": { "nuvio-series.jpg": jpeg, "shm_ave": ave, "shm_ave_tddg": tddg,
    "shm_socpq": "socpq config block", "shm_tvsystem": "tvsystem", "WK2SharedMemory.inspector.port": inspector } };
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
        var pos = 0;
        ok({
          get position() { return pos; }, set position(v) { pos = v; },
          readBytes: function (c) { var str = store[p][n].substr(pos, c), out = [], i; for (i = 0; i < str.length; i++) out.push(str.charCodeAt(i)); pos += str.length; return out; },
          read: function (c) { return store[p][n].slice(pos, pos + c); }, write: function (s) { store[p][n] = s; }, close: function () {},
          bytesAvailable: store[p][n].length - pos
        });
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

function fakeStorage() {
  var data = {};
  return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; }, setItem: function (k, v) { data[k] = String(v); } };
}

function load() {
  var window = { tizen: fakeTizen(), navigator: { userAgent: "Mozilla Chromium/56", platform: "Linux armv7l", language: "en", mimeTypes: [], plugins: [] }, screen: { width: 1920, height: 1080 },
    setTimeout: setTimeout, clearTimeout: clearTimeout, ArrayBuffer: ArrayBuffer, Uint8Array: Uint8Array, performance: { now: function () { return Date.now(); } },
    localStorage: fakeStorage(), devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080, console: console };
  window.window = window;
  window.XMLHttpRequest = function () { var self = this; this.open = function () {}; this.send = function () { setTimeout(function () { self.onerror(); }, 1); }; };
  window.WebSocket = function () { var self = this; setTimeout(function () { self.onerror(); }, 1); this.close = function () {}; };
  var context = vm.createContext(window);
  FILES.slice(0, 8).forEach(function (file) { vm.runInContext(fs.readFileSync(path.join(DIR, file), "utf8"), context, { filename: file }); });
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
    // the openStream encoding-argument bug (v0.1): writeTest must now actually write, reopen and verify the exact bytes
    var w1 = R.results["filesystem.write./dev/shm"].value;
    assert.equal(w1.steps.write.indexOf("ok") , 0, "write step: " + w1.steps.write);
    assert.equal(w1.steps.verify, "exact match");
    assert.equal(w1.readBack, "NU7100_RECON_TEST");
    assert.equal(status("filesystem.write./dev/shm"), "PASS");
    // sharedmem: the read-path encoding bug (openStream's 4th arg was "r", not a valid encoding) made every one of
    // these BLOCKED before the fix - confirm the step-by-step read now actually succeeds, with the exact field set asked for.
    assert.equal(status("sharedmem.object.shm_ave"), "PASS");
    var ave = R.results["sharedmem.object.shm_ave"].value;
    assert.equal(ave.steps.resolve, "ok");
    assert.equal(ave.steps.open, "ok");
    assert.ok(ave.steps.read.indexOf("ok") === 0, "read step: " + ave.steps.read);
    assert.equal(ave.steps.close, "ok");
    assert.ok(typeof ave.readTimeMs === "number");
    assert.ok(ave.first256Hex && ave.first256Text);
    assert.equal(ave.likelyText, true);
    // the inspector-port fix: the WHOLE 412-byte file is read now, not just the (all-zero) first 256 bytes
    assert.equal(status("sharedmem.inspector_port"), "PASS");
    var insp = R.results["sharedmem.inspector_port"].value;
    assert.equal(insp.sizeBytes, 412);
    assert.equal(insp.complete, true);
    assert.equal(insp.first256AllZero, true);
    assert.ok(insp.fullText.indexOf("port=37011") >= 0, "bytes 256-411 are read too: " + insp.fullText);
    assert.ok(insp.strings.indexOf("port=37011 token=abc") >= 0);
    assert.ok(insp.nonZeroByteCount > 0);
    // the multi-offset window watcher over shm_ave + shm_ave_tddg - every named offset must actually land inside the file
    assert.equal(status("sharedmem.watch_windows"), "PARTIAL", "the fake objects never change, so PARTIAL (visible, unchanged) is correct");
    var windows = R.results["sharedmem.watch_windows"].value;
    var aveWindows = windows.files["/dev/shm/shm_ave"].windows, tddgWindows = windows.files["/dev/shm/shm_ave_tddg"].windows;
    assert.equal(aveWindows.length, 7, "0, 4KB, 64KB, 128KB, 192KB, 256KB, end-4KB");
    assert.equal(tddgWindows.length, 8, "0, 4KB, 64KB, 256KB, 512KB, 768KB, 1MB, end-4KB");
    aveWindows.forEach(function (w) { assert.equal(w.errors, 0, w.label + ": " + w.firstError); assert.ok(w.sampleCount >= 3, w.label); assert.equal(w.hashChanges, 0, w.label + ": static content must hash the same every sample"); });
    tddgWindows.forEach(function (w) { assert.equal(w.errors, 0, w.label + ": " + w.firstError); assert.ok(w.sampleCount >= 3, w.label); });
    assert.equal(windows.files["/dev/shm/shm_ave"].sizeBytes, 270 * 1024);
    // snapshot/diff: before a snapshot, the diff test must say so cleanly (never NOT_AVAILABLE as a crash)
    assert.equal(status("sharedmem.diff"), "NOT_AVAILABLE");
    // dcapture.known_path now does one full timed read with every phase separated, plus the benchmark
    assert.equal(status("dcapture.known_path"), "PASS");
    var kp = R.results["dcapture.known_path"].value;
    assert.equal(kp.looksLikeJpeg, true);
    assert.equal(kp.startsWithFFD8FF, true);
    assert.equal(kp.endsWithFFD9, true);
    assert.equal(kp.complete, true);
    assert.ok(typeof kp.timingsMs.total === "number" && kp.timingsMs.total >= 0);
    assert.equal(status("dcapture.benchmark"), "PASS");
    var bench = R.results["dcapture.benchmark"].value;
    assert.equal(bench.successes, 50);
    assert.equal(bench.failures, 0);
    assert.equal(bench.distinctContents, 1, "the fake file never changes across the 50 reads");
    assert.equal(bench.startsWithFFD8FF, 50);
    assert.equal(bench.timingsMs.total.count, 50);
    assert.ok(bench.timingsMs.total.p95 >= bench.timingsMs.total.p50);
    var findings = R.findings();
    assert.equal(findings.sharedMemory.shm_ave.likelyJPEG, false);
    assert.equal(findings.inspector.value.sizeBytes, 412);
    assert.equal(findings.dcapture.knownPathRead, "PASS");
    assert.equal(findings.dcapture.benchmark50.successes, 50);
    var report2 = R.report();
    assert.equal(report2.reconVersion, "0.2.1");
    assert.equal(report2.device.model, "UE49NU7100");
    assert.ok(report2.findings);
    assert.ok(report2.sharedmem["sharedmem.object.shm_ave"]);
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

test("SNAPSHOT SHM then DIFF SHM reports added, removed and resized /dev/shm names", function (t, done) {
  var context = load(), R = context.Recon;
  R.shmSnapshotSave(function (saved) {
    assert.equal(saved.ok, true);
    assert.ok(saved.count >= 4);
    // Mutate /dev/shm the same way Nuvio starting dcapture would: a new file appears, one shrinks.
    context.tizen.filesystem.resolve("/dev/shm", function (dir) {
      var added = dir.createFile("nuvio-ambilight-0.jpg");
      added.openStream("w", function (stream) { stream.write("\xff\xd8\xff\xe0newframe\xff\xd9"); stream.close();
        context.tizen.filesystem.resolve("/dev/shm/shm_socpq", function (file) {
          file.openStream("w", function (stream2) { stream2.write("x"); stream2.close();
            var test = null, i;
            for (i = 0; i < R.tests.length; i++) if (R.tests[i].id === "sharedmem.diff") test = R.tests[i];
            R.runTest(test, function (r) {
              assert.equal(r.status, "PASS");
              assert.ok(r.value.added.some(function (e) { return e.name === "nuvio-ambilight-0.jpg"; }), JSON.stringify(r.value.added));
              assert.ok(r.value.resized.some(function (e) { return e.name === "shm_socpq"; }), JSON.stringify(r.value.resized));
              assert.equal(r.value.removed.length, 0);
              done();
            });
          }, function () {}, "UTF-8");
        });
      }, function () {}, "UTF-8");
    }, function () {}, "rw");
  });
});
