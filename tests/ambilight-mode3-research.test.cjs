"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var os = require("node:os");
var test = require("node:test");
var ambilight = require("../services/tizen/runtime/ambilight.cjs");
var internals = ambilight._internals;

var SHM = { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }; // rawCaptureCall always asks the service to write under /dev/shm
var JPEG_DIR = path.join(__dirname, "fixtures", "jpeg");
var GREEN = path.join(JPEG_DIR, "green.jpg"), GREY = path.join(JPEG_DIR, "grey.jpg"), FOUR20 = path.join(JPEG_DIR, "420.jpg");

// A fake busctl always receives /dev/shm as its "dir" argument (rawCaptureCall hardcodes CAPTURE_DIR), so every script below
// reads it back out as "$d" and writes/replies there - never to a path the test makes up itself.
function withFakeBusctl(script, run) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "m3-"));
  fs.writeFileSync(path.join(dir, "busctl"), script, { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  return Promise.resolve().then(run).finally(function () {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ---- summariseMode3Research: the five answers, exercised directly against hand-built results (no TV needed) ----------

test("summariseMode3Research: a clear async, fast, non-serialised mode 3 answers all five questions YES/NO correctly", function () {
  var results = {
    "control-mode1": { realUniqueValidFramesPerSecond: 10, apiCallsPerSecond: 10, meanCallMs: 90, invalidOrPartialJpeg: 0 },
    "control-mode2": { realUniqueValidFramesPerSecond: 14, apiCallsPerSecond: 14, meanCallMs: 65, invalidOrPartialJpeg: 0 },
    "delayed-read-mode3": { requests: [
      { observations: [{ delayActualMs: 4, validJpeg: false }, { delayActualMs: 28, validJpeg: true, matchesExpected: true }] },
      { observations: [{ delayActualMs: 5, validJpeg: false }, { delayActualMs: 30, validJpeg: true, matchesExpected: true }] }
    ] },
    "filename-strategies-mode3": {
      reuse: { realUniqueValidFramesPerSecond: 1, apiCallsPerSecond: 24 },
      alternate: { realUniqueValidFramesPerSecond: 20, apiCallsPerSecond: 24 },
      ring4: { realUniqueValidFramesPerSecond: 23, apiCallsPerSecond: 24 },
      unique: { realUniqueValidFramesPerSecond: 24, apiCallsPerSecond: 24 }
    },
    "in-flight-mode3": {
      1: { completedValidFramesPerSecond: 13, overlapDetected: false, requests: 13, staleFrames: 0 },
      2: { completedValidFramesPerSecond: 24, overlapDetected: true, requests: 24, staleFrames: 0 },
      4: { completedValidFramesPerSecond: 25, overlapDetected: true, requests: 25, staleFrames: 1 }
    }
  };
  var summary = internals.summariseMode3Research(results);
  assert.equal(summary.mode3BestFilenameStrategy, "unique");
  assert.equal(summary.mode3BestInFlightCount, 4);
  assert.match(summary.answers.mode3Asynchronous, /^YES/);
  assert.match(summary.answers.mode3FasterThanMode2, /^YES/);
  assert.match(summary.answers.filenameReuseCausesStaleFrames, /^YES/);
  assert.match(summary.answers.capturesCanOverlap, /^YES/);
  assert.match(summary.answers.pathAboveTwentyRealFps, /^YES/);
});

test("summariseMode3Research: a frozen, serialised mode 3 answers NO/INCONCLUSIVE correctly", function () {
  var results = {
    "control-mode1": { realUniqueValidFramesPerSecond: 9, apiCallsPerSecond: 9, meanCallMs: 100, invalidOrPartialJpeg: 0 },
    "control-mode2": { realUniqueValidFramesPerSecond: 13, apiCallsPerSecond: 13, meanCallMs: 70, invalidOrPartialJpeg: 0 },
    "delayed-read-mode3": { requests: [
      { observations: [{ delayActualMs: 4, validJpeg: true, matchesExpected: false }, { delayActualMs: 300, validJpeg: true, matchesExpected: false }] }
    ] },
    "filename-strategies-mode3": {
      reuse: { realUniqueValidFramesPerSecond: 1, apiCallsPerSecond: 25 },
      alternate: { realUniqueValidFramesPerSecond: 1, apiCallsPerSecond: 25 },
      ring4: { realUniqueValidFramesPerSecond: 1, apiCallsPerSecond: 25 },
      unique: { realUniqueValidFramesPerSecond: 1, apiCallsPerSecond: 25 }
    },
    "in-flight-mode3": { 1: { completedValidFramesPerSecond: 1, overlapDetected: false, requests: 25, staleFrames: 24 } }
  };
  var summary = internals.summariseMode3Research(results);
  // no observation ever matched the expected colour, so delayed-read never counts a "fresh" sample
  assert.equal(summary.mode3DelayedReadSampleCount, 0);
  assert.match(summary.answers.mode3Asynchronous, /^INCONCLUSIVE/);
  assert.match(summary.answers.mode3FasterThanMode2, /^NO/);
  assert.match(summary.answers.filenameReuseCausesStaleFrames, /^NO/, "reuse and unique both gave 1 fps: filenames are not the cause");
  assert.match(summary.answers.capturesCanOverlap, /^NO/);
  assert.match(summary.answers.pathAboveTwentyRealFps, /^NO/);
  assert.equal(summary.mode3StalePercent, 96, "24 of 25 were stale");
});

// ---- classifyMiddleColour / expectedMiddleColourAt: the colour-matching arithmetic itself -----------------------------
// The capture-lab clip cycles RGB / GBR / BRG every 2 s (12 s cycle): at t=1 s the clip is still in its first ("RGB")
// phase, so the middle third is green.

test("expectedMiddleColourAt and classifyMiddleColour agree with the capture-lab clip's own scheme", function () {
  assert.equal(internals.expectedMiddleColourAt(1), "G");
  assert.equal(internals.classifyMiddleColour([230, 20, 20]), "R");
  assert.equal(internals.classifyMiddleColour([20, 230, 20]), "G");
  assert.equal(internals.classifyMiddleColour([20, 20, 230]), "B");
  assert.equal(internals.classifyMiddleColour([10, 10, 10]), "K");
  assert.equal(internals.expectedMiddleColourAt(1.8), null, "too close to the next colour change to judge");
});

// ---- rawCaptureCall + fileSnapshot: real busctl parsing and real file/JPEG inspection ----------------------------------

test("rawCaptureCall parses the busctl reply and fileSnapshot classifies the resulting JPEG", SHM, function (t, done) {
  var name = "m3-unit-test", path2 = "/dev/shm/" + name + ".jpg";
  var script = "#!/bin/sh\nfor last; do :; done\neval \"d=\\${$(($# - 1))}\"\n/bin/cp \"" + GREEN + "\" \"$d/$last.jpg\"\n" +
    "echo \"iiis 0 480 270 \\\"$d/$last.jpg\\\"\"\n";
  withFakeBusctl(script, function () {
    return new Promise(function (resolve) {
      internals.rawCaptureCall(3, name, function (callResult) {
        assert.equal(callResult.ok, true);
        assert.equal(callResult.ret, 0);
        assert.equal(callResult.reply.path, path2);
        internals.fileSnapshot(path2, null, function (snap) {
          assert.equal(snap.exists, true);
          assert.equal(snap.validJpeg, true);
          assert.equal(snap.soi, true);
          assert.equal(snap.eoi, true);
          assert.ok(snap.hash);
          assert.equal(snap.dominantMiddle, "G");
          try { fs.unlinkSync(path2); } catch (_) {}
          resolve();
        });
      });
    });
  }).then(function () { done(); }, done);
});

test("fileSnapshot reports a missing file cleanly, never throwing", function (t, done) {
  internals.fileSnapshot("/dev/shm/m3-does-not-exist-" + Date.now() + ".jpg", null, function (snap) {
    assert.equal(snap.exists, false);
    assert.ok(snap.error);
    done();
  });
});

// ---- mode3FilenameStrategyTest: distinct-frame counting on a cycling vs a frozen fake service --------------------------

test("mode3FilenameStrategyTest counts several distinct valid frames when the service's content actually varies", SHM, function (t, done) {
  var counterFile = path.join(os.tmpdir(), "m3-counter-" + process.pid);
  fs.writeFileSync(counterFile, "0");
  var script = "#!/bin/sh\nfor last; do :; done\neval \"d=\\${$(($# - 1))}\"\n" +
    "n=$(cat '" + counterFile + "')\nn=$((n+1))\necho $n > '" + counterFile + "'\n" +
    "case $(( (n - 1) % 3 )) in\n0) f='" + GREEN + "' ;;\n1) f='" + GREY + "' ;;\n*) f='" + FOUR20 + "' ;;\nesac\n" +
    "/bin/cp \"$f\" \"$d/$last.jpg\"\necho \"iiis 0 480 270 \\\"$d/$last.jpg\\\"\"\n";
  withFakeBusctl(script, function () {
    return new Promise(function (resolve) {
      internals.mode3FilenameStrategyTest(3, "unique", 1, null, function (result) {
        assert.equal(result.serviceErrors, 0);
        assert.ok(result.requests >= 3, "requests: " + result.requests);
        assert.ok(result.distinctValidFrames >= 3, "distinct: " + result.distinctValidFrames);
        assert.ok(result.realUniqueValidFramesPerSecond > 0);
        resolve();
      });
    });
  }).then(function () { fs.unlinkSync(counterFile); done(); }, function (e) { fs.unlinkSync(counterFile); done(e); });
});

test("mode3FilenameStrategyTest counts exactly one distinct frame when the service always returns the same content", SHM, function (t, done) {
  var script = "#!/bin/sh\nfor last; do :; done\neval \"d=\\${$(($# - 1))}\"\n/bin/cp \"" + GREEN + "\" \"$d/$last.jpg\"\n" +
    "echo \"iiis 0 480 270 \\\"$d/$last.jpg\\\"\"\n";
  withFakeBusctl(script, function () {
    return new Promise(function (resolve) {
      internals.mode3FilenameStrategyTest(3, "reuse", 1, null, function (result) {
        assert.ok(result.requests >= 2, "requests: " + result.requests);
        assert.equal(result.distinctValidFrames, 1, "the frozen-frame case: every read is the same picture");
        resolve();
      });
    });
  }).then(function () { done(); }, done);
});

// ---- mode3DelayedReadTest: a file that appears asynchronously after the call returns --------------------------------

test("mode3DelayedReadTest sees the file missing at an early delay and complete at a later one", SHM, function (t, done) {
  var script = "#!/bin/sh\nfor last; do :; done\neval \"d=\\${$(($# - 1))}\"\n" +
    "( sleep 0.15; /bin/cp \"" + GREEN + "\" \"$d/$last.jpg\" ) >/dev/null 2>&1 &\n" + // redirected: a backgrounded job sharing the pipe would otherwise hold execFile's callback until it also exits
    "disown 2>/dev/null || true\n" +
    "echo \"iiis 0 480 270 \\\"$d/$last.jpg\\\"\"\n";
  withFakeBusctl(script, function () {
    return new Promise(function (resolve) {
      internals.mode3DelayedReadTest(3, 1, [0, 60, 400], null, function (result) {
        var observations = result.requests[0].observations;
        assert.equal(observations.length, 3);
        assert.equal(observations[0].exists, false, "at 0 ms the background write has not happened yet");
        assert.equal(observations[2].validJpeg, true, "at 400 ms the background write is long done");
        resolve();
      });
    });
  }).then(function () { done(); }, done);
});

// ---- mode3InFlightTest: a slow service exposes real overlap between concurrent requests --------------------------------

test("mode3InFlightTest detects overlapping [start,finish] windows once more than one request runs at a time", Object.assign({ timeout: 15000 }, SHM), function (t, done) {
  var script = "#!/bin/sh\nfor last; do :; done\neval \"d=\\${$(($# - 1))}\"\nsleep 0.15\n/bin/cp \"" + GREEN + "\" \"$d/$last.jpg\"\n" +
    "echo \"iiis 0 480 270 \\\"$d/$last.jpg\\\"\"\n";
  withFakeBusctl(script, function () {
    return new Promise(function (resolve) {
      internals.mode3InFlightTest(3, 3, 1, null, function (result) {
        assert.ok(result.requests >= 2, "requests: " + result.requests);
        assert.equal(result.overlapDetected, true, "three concurrent 150 ms captures within a 1 s window must overlap");
        assert.equal(result.failedFrames, 0);
        resolve();
      });
    });
  }).then(function () { done(); }, done);
});

// ---- mode3PathSemanticsTest: the service answers with a DIFFERENT path than requested -----------------------------

test("mode3PathSemanticsTest notices when the returned path differs from the requested one", SHM, function (t, done) {
  var script = "#!/bin/sh\nfor last; do :; done\neval \"d=\\${$(($# - 1))}\"\n/bin/cp \"" + GREEN + "\" \"$d/renamed-by-service.jpg\"\n" +
    "echo \"iiis 0 480 270 \\\"$d/renamed-by-service.jpg\\\"\"\n";
  withFakeBusctl(script, function () {
    return new Promise(function (resolve) {
      internals.mode3PathSemanticsTest(3, function (result) {
        assert.equal(result.requestedPath, "/dev/shm/m3-path-test.jpg");
        assert.equal(result.returnedPath, "/dev/shm/renamed-by-service.jpg");
        assert.equal(result.returnedPathDiffersFromRequested, true);
        assert.equal(result.fileAtReturnedPath, true);
        assert.equal(result.fileAtRequestedPath, false);
        resolve();
      });
    });
  }).then(function () { done(); }, done);
});

// ---- mode3SequenceTest and mode3WarmupTest: smoke tests (the heavy lifting is already covered above) -----------------

test("mode3SequenceTest runs a warm-up mode then scores the tested mode, for every sequence", SHM, function (t, done) {
  var script = "#!/bin/sh\nfor last; do :; done\neval \"d=\\${$(($# - 1))}\"\n/bin/cp \"" + GREEN + "\" \"$d/$last.jpg\"\n" +
    "echo \"iiis 0 480 270 \\\"$d/$last.jpg\\\"\"\n";
  withFakeBusctl(script, function () {
    return new Promise(function (resolve) {
      internals.mode3SequenceTest([[3], [1, 3], [2, 3]], null, function (result) {
        assert.equal(result.sequences.length, 3);
        assert.equal(result.sequences[1].sequence, "1->3");
        assert.ok(result.sequences[1].result.requests >= 1);
        resolve();
      });
    });
  }).then(function () { done(); }, done);
});

test("mode3WarmupTest keeps every request's own result, not an average", SHM, function (t, done) {
  var script = "#!/bin/sh\nfor last; do :; done\neval \"d=\\${$(($# - 1))}\"\n/bin/cp \"" + GREEN + "\" \"$d/$last.jpg\"\n" +
    "echo \"iiis 0 480 270 \\\"$d/$last.jpg\\\"\"\n";
  withFakeBusctl(script, function () {
    return new Promise(function (resolve) {
      internals.mode3WarmupTest(3, 5, null, function (result) {
        assert.equal(result.timeline.length, 5);
        assert.equal(result.distinctFrames, 1);
        resolve();
      });
    });
  }).then(function () { done(); }, done);
});

// ---- mode3DirWatchTest: an unexpected extra file appearing alongside the requested capture ----------------------------

test("mode3DirWatchTest reports both the requested capture file and an unrelated new file as added", Object.assign({ timeout: 5000 }, SHM), function (t, done) {
  var extra = "/dev/shm/m3-dirwatch-surprise-" + Date.now() + ".tmp";
  var script = "#!/bin/sh\nfor last; do :; done\neval \"d=\\${$(($# - 1))}\"\n/bin/cp \"" + GREEN + "\" \"$d/$last.jpg\"\n" +
    "echo surprise > '" + extra + "'\n" +
    "echo \"iiis 0 480 270 \\\"$d/$last.jpg\\\"\"\n";
  withFakeBusctl(script, function () {
    return new Promise(function (resolve) {
      internals.mode3DirWatchTest(3, function (result) {
        assert.ok(result.added.some(function (e) { return e.name === "m3-dirwatch.jpg"; }));
        assert.ok(result.added.some(function (e) { return e.name.indexOf("m3-dirwatch-surprise-") === 0; }), "an unrelated new file is noticed too");
        try { fs.unlinkSync(extra); } catch (_) {}
        resolve();
      });
    });
  }).then(function () { done(); }, done);
});
