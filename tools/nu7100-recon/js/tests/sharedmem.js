// /dev/shm content: what the non-semaphore objects actually contain, and the WebKit inspector port file.
// Highest priority for ambilight, because this is where dcapture leaves its JPEGs.
(function (R) {
  "use strict";
  var SEM_PREFIX = "sem.";
  var INSPECTOR_NAME = "WK2SharedMemory.inspector.port";

  function entryNames(info) {
    return (info.entries || []).map(function (e) { return e.replace(/^[df]\s/, "").replace(/\s\d+$/, ""); });
  }

  R.define("sharedmem", "sharedmem.inventory", "/dev/shm: every object (name, size, kind)", function (done) {
    R.probePath("/dev/shm", { nameLimit: 400 }, function (info) {
      if (!info.exists) { done(R.statusForError(info.error), { exists: false }, info.error); return; }
      var names = entryNames(info), semaphores = names.filter(function (n) { return n.indexOf(SEM_PREFIX) === 0; });
      var regular = names.filter(function (n) { return n.indexOf(SEM_PREFIX) !== 0; });
      done(info.listable ? "PASS" : "PARTIAL", { totalEntries: info.entryCount, regular: regular, semaphoreCount: semaphores.length, semaphores: semaphores.slice(0, 60) }, info.error);
    });
  });

  // One /dev/shm object, read the step-by-step way (resolve/size/open/bytesAvailable/read256/close), 256 bytes only - the
  // v0.1/early-v0.2 bug (openStream's encoding argument was "r", not a valid encoding) made every one of these BLOCKED.
  function shmObjectTest(id, path) {
    R.define("sharedmem", id, path, function (done) {
      R.readShmObject(path, 256, function (out) {
        var result = { path: path, steps: out.steps, readTimeMs: out.readTimeMs, bytesRead: out.bytesRead, first256Hex: null, first256Text: null };
        if (out.bytes && out.bytes.length) {
          result.first256Hex = R.hexDump(out.bytes, 256);
          result.first256Text = R.text(out.bytes, out.bytes.length);
          var cls = R.classifyBytes(out.bytes);
          result.printableRatio = cls.printableRatio; result.zeroByteRatio = cls.zeroByteRatio;
          result.likelyJPEG = cls.likelyJPEG; result.likelyPNG = cls.likelyPNG; result.likelyGZIP = cls.likelyGZIP; result.likelyELF = cls.likelyELF;
          result.likelyText = !cls.likelyJPEG && !cls.likelyPNG && !cls.likelyGZIP && !cls.likelyELF && cls.printableRatio >= 0.85;
        }
        var status = out.steps.resolve !== "ok" ? R.statusForError(out.error)
          : (out.steps.read && out.steps.read.indexOf("ok") === 0 ? "PASS" : (out.steps.open && out.steps.open.indexOf("skipped") === 0 ? "PARTIAL" : "BLOCKED"));
        done(status, result, out.error);
      });
    });
  }
  shmObjectTest("sharedmem.object.shm_ave", "/dev/shm/shm_ave");
  shmObjectTest("sharedmem.object.shm_ave_tddg", "/dev/shm/shm_ave_tddg");
  shmObjectTest("sharedmem.object.shm_socpq", "/dev/shm/shm_socpq");
  shmObjectTest("sharedmem.object.shm_tvsystem", "/dev/shm/shm_tvsystem");
  // Same read, same 256-byte limit, for the WebKit remote-inspector port/token file - report only what is read, never interpreted.
  shmObjectTest("sharedmem.inspector_port", "/dev/shm/" + INSPECTOR_NAME);

  // sem.DevToolsPort.lock* : metadata only, never opened for content (POSIX semaphores are not meaningful as byte streams here).
  R.define("sharedmem", "sharedmem.devtools_sem", "/dev/shm/sem.DevToolsPort.lock*", function (done) {
    R.probePath("/dev/shm", { nameLimit: 400 }, function (info) {
      if (!info.exists) { done(R.statusForError(info.error), null, info.error); return; }
      var names = entryNames(info).filter(function (n) { return n.indexOf("sem.DevToolsPort") === 0; });
      if (!names.length) { done("NOT_AVAILABLE", null, "no sem.DevToolsPort.* entries in this listing"); return; }
      var out = { names: names }, done2 = 0;
      names.forEach(function (n) {
        R.readFile("/dev/shm/" + n, 0, function (info2) { out[n] = { size: info2.fileSize, modified: info2.modified, isFile: info2.isFile, error: info2.error }; if (++done2 === names.length) done("PASS", out); });
      });
    });
  });

  // The two largest /dev/shm objects, polled together for 5 s at 10 Hz: timestamp, mtime, size, hash(first256), hash(first4096).
  // Run this while a movie is actually playing in Nuvio for it to mean anything - outside playback both are expected static.
  function pairWatch(paths, cb) {
    var began = Date.now(), samples = {};
    paths.forEach(function (p) { samples[p] = []; });
    (function next() {
      var pending = paths.length;
      paths.forEach(function (p) {
        R.readShmObject(p, 4096, function (out) {
          samples[p].push({ at: Date.now() - began, modified: out.modified, size: out.steps.size, error: out.error,
            hash256: out.bytes ? R.hashBytes(out.bytes.slice(0, 256)) : null, hash4096: out.bytes ? R.hashBytes(out.bytes) : null });
          if (--pending === 0) {
            if (Date.now() - began >= 5000) { cb(samples); return; }
            setTimeout(next, 100);
          }
        });
      });
    })();
  }
  R.define("sharedmem", "sharedmem.watch_pair", "WATCH 5 SEC (10 Hz): /dev/shm/shm_ave + shm_ave_tddg together", function (done) {
    var paths = ["/dev/shm/shm_ave", "/dev/shm/shm_ave_tddg"];
    pairWatch(paths, function (samples) {
      var out = { durationMs: 5000, objects: {} }, anyReached = false, anyChanged = false;
      paths.forEach(function (p) {
        var list = samples[p], hashes256 = {}, hashes4096 = {}, sizes = {}, mtimes = {}, reached = list.some(function (s) { return !s.error; });
        list.forEach(function (s) { hashes256[s.hash256] = 1; hashes4096[s.hash4096] = 1; sizes[s.size] = 1; mtimes[s.modified] = 1; });
        var changes = { size: Object.keys(sizes).length - 1, mtime: Object.keys(mtimes).length - 1, content256: Object.keys(hashes256).length - 1, content4096: Object.keys(hashes4096).length - 1 };
        out.objects[p] = { sampleCount: list.length, changes: changes, samples: list, firstError: !reached ? (list[0] && list[0].error) : null };
        if (reached) anyReached = true;
        if (changes.size > 0 || changes.mtime > 0 || changes.content256 > 0 || changes.content4096 > 0) anyChanged = true;
      });
      done(!anyReached ? "BLOCKED" : (anyChanged ? "PASS" : "PARTIAL"), out, anyChanged ? null : "both objects visible but unchanged over 5 s (try again while a movie is playing in Nuvio)");
    });
  });

  // User-chosen /dev/shm path, polled for 5 s at 10 Hz.
  R.define("sharedmem", "sharedmem.watch", "WATCH SHM: user-chosen /dev/shm path, 5 s", function (done) {
    var path = R.inputs.shmWatchPath;
    if (!path) { done("NOT_AVAILABLE", null, "no path entered in WATCH SHM"); return; }
    R.watchPath(path, 5000, 100, function (out) {
      var reached = out.samples.some(function (s) { return !s.error; });
      done(!reached ? R.statusForError(out.samples[0] && out.samples[0].error) : (out.changes.total > 0 ? "PASS" : "PARTIAL"), out,
        reached && out.changes.total === 0 ? "visible but unchanged over 5 s" : (reached ? null : out.samples[0] && out.samples[0].error));
    });
  });
})(Recon);
