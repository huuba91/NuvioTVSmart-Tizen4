// /dev/shm content: what the non-semaphore objects actually contain, and the WebKit inspector port file.
// Highest priority for ambilight, because this is where dcapture leaves its JPEGs.
(function (R) {
  "use strict";
  var SEM_PREFIX = "sem.";
  var INSPECTOR_NAME = "WK2SharedMemory.inspector.port";

  function entryNames(info) {
    return (info.entries || []).map(function (e) { return e.replace(/^[df]\s/, "").replace(/\s\d+$/, ""); });
  }

  R.define("sharedmem", "sharedmem.inventory", "/dev/shm: every object (name, size, mtime) - for before/after comparison between reports", function (done) {
    R.listDir("/dev/shm", function (error, entries) {
      if (error) { done(R.statusForError(error), { exists: false }, error); return; }
      var regular = [], semaphores = [];
      entries.forEach(function (e) { if (e.name.indexOf(SEM_PREFIX) === 0) semaphores.push(e.name); else regular.push({ name: e.name, size: e.size, modified: e.modified, isDirectory: e.isDirectory }); });
      done("PASS", { totalEntries: entries.length, regular: regular, semaphoreCount: semaphores.length, semaphores: semaphores.slice(0, 80) }, null);
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
  // The WebKit remote-inspector port/token file is small (about 412 bytes): read ALL of it, not just 256. Reported as read, never interpreted.
  R.define("sharedmem", "sharedmem.inspector_port", "/dev/shm/" + INSPECTOR_NAME + " (whole file)", function (done) {
    var path = "/dev/shm/" + INSPECTOR_NAME;
    R.readShmObject(path, 4096, function (out) {
      var bytes = out.bytes || [], result = { path: path, sizeBytes: out.steps.size, bytesRead: out.bytesRead, complete: out.steps.size === out.bytesRead, steps: out.steps, readTimeMs: out.readTimeMs };
      if (bytes.length) {
        var nonZero = [], i, cls = R.classifyBytes(bytes);
        for (i = 0; i < bytes.length; i++) if ((bytes[i] & 255) !== 0) nonZero.push(i);
        result.fullHex = R.hexDump(bytes, 4096);
        result.bytes256ToEndHex = bytes.length > 256 ? R.hexDump(bytes.slice(256), 4096, 256) : null;
        result.fullText = R.text(bytes, bytes.length);
        result.strings = R.printableStrings(bytes, 3);
        result.nonZeroByteCount = nonZero.length;
        result.firstNonZeroOffsets = nonZero.slice(0, 40);
        result.first256AllZero = bytes.slice(0, 256).every(function (b) { return (b & 255) === 0; });
        result.printableRatio = cls.printableRatio; result.zeroByteRatio = cls.zeroByteRatio;
      }
      done(out.steps.resolve !== "ok" ? R.statusForError(out.error) : (out.steps.read && out.steps.read.indexOf("ok") === 0 ? "PASS" : "BLOCKED"), result, out.error);
    });
  });

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

  // The two big /dev/shm objects, 4 KB windows at several offsets each, polled together for 5 s (about 5-10 Hz). If only the header is
  // a static control block, the dynamic data (if any) would show up as hash changes at a later offset.
  var KB = 1024, WINDOW = 4 * KB;
  var WINDOW_PLANS = [
    { path: "/dev/shm/shm_ave", offsets: [0, 4 * KB, 64 * KB, 128 * KB, 192 * KB, 256 * KB, -1] },
    { path: "/dev/shm/shm_ave_tddg", offsets: [0, 4 * KB, 64 * KB, 256 * KB, 512 * KB, 768 * KB, 1024 * KB, -1] }
  ];
  function windowLabel(offset, size) { return offset === Math.max(0, size - WINDOW) ? "end-4KB" : (offset % KB === 0 ? (offset / KB) + "KB" : String(offset)); }
  R.define("sharedmem", "sharedmem.watch_windows", "WATCH 5 SEC: multi-offset 4 KB windows of shm_ave + shm_ave_tddg", function (done) {
    var began = R.now(), perFile = {}, sampleTimes = [];
    WINDOW_PLANS.forEach(function (plan) { perFile[plan.path] = { size: null, sizes: {}, mtimes: {}, windows: {}, order: [], reads: 0, readErrors: 0, firstError: null }; });
    (function next() {
      var pending = WINDOW_PLANS.length;
      WINDOW_PLANS.forEach(function (plan) {
        R.readWindows(plan.path, plan.offsets, WINDOW, function (out) {
          var f = perFile[plan.path];
          f.reads++;
          if (out.error) { f.readErrors++; if (!f.firstError) f.firstError = out.error; }
          else {
            f.size = out.size; f.sizes[out.size] = 1; f.mtimes[out.modified] = 1;
            out.windows.forEach(function (w) {
              var key = String(w.offset), entry = f.windows[key];
              if (!entry) { entry = f.windows[key] = { offset: w.offset, label: windowLabel(w.offset, out.size), samples: 0, errors: 0, hashes: {}, zeroRatioFirst: w.zeroRatio, firstError: null }; f.order.push(key); }
              if (w.error) { entry.errors++; if (!entry.firstError) entry.firstError = w.error; return; }
              entry.samples++; entry.hashes[w.hash] = 1;
            });
          }
          if (--pending === 0) {
            sampleTimes.push(R.now() - began);
            if (R.now() - began >= 5000) { finish(); return; }
            setTimeout(next, 60);
          }
        });
      });
    })();
    function finish() {
      var out = { durationMs: Math.round(R.now() - began), rounds: sampleTimes.length, roundsPerSecond: Math.round(sampleTimes.length / ((R.now() - began) / 1000) * 10) / 10, files: {} }, anyReached = false, anyChanged = false;
      WINDOW_PLANS.forEach(function (plan) {
        var f = perFile[plan.path], rows = [];
        f.order.forEach(function (key) {
          var w = f.windows[key], distinct = Object.keys(w.hashes).length;
          rows.push({ offset: w.offset, label: w.label, sampleCount: w.samples, hashChanges: Math.max(0, distinct - 1), zeroRatioFirstSample: w.zeroRatioFirst, errors: w.errors, firstError: w.firstError });
          if (w.samples) anyReached = true;
          if (distinct > 1) anyChanged = true;
        });
        out.files[plan.path] = { sizeBytes: f.size, sizeChanges: Math.max(0, Object.keys(f.sizes).length - 1), mtimeChanges: Math.max(0, Object.keys(f.mtimes).length - 1),
          reads: f.reads, readErrors: f.readErrors, firstError: f.firstError, windows: rows };
        if (Object.keys(f.mtimes).length > 1 || Object.keys(f.sizes).length > 1) anyChanged = true;
      });
      done(!anyReached ? "BLOCKED" : (anyChanged ? "PASS" : "PARTIAL"), out, anyReached ? (anyChanged ? null : "all windows unchanged for 5 s (try again while a movie is playing in Nuvio)") : "no window could be read (position/readBytes failed - see firstError)");
    }
  }, { timeoutMs: 30000 });

  // ---- /dev/shm filename diff between two moments (e.g. dcapture off, then on). The baseline is kept in localStorage so it survives
  // closing Recon and opening Nuvio in between (this TV keeps one foreground app).
  var BASELINE_KEY = "nu7100.shm.baseline";
  function storageGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; } }
  R.shmSnapshotSave = function (cb) {
    R.listDir("/dev/shm", function (error, entries) {
      if (error) { cb({ ok: false, error: error }); return; }
      var snap = { at: R.stamp(), entries: entries.map(function (e) { return { name: e.name, size: e.size, modified: e.modified }; }) };
      cb({ ok: storageSet(BASELINE_KEY, JSON.stringify(snap)), count: entries.length, at: snap.at, storageNote: storageGet(BASELINE_KEY) ? null : "localStorage not available: the baseline could not be kept" });
    });
  };
  R.define("sharedmem", "sharedmem.diff", "/dev/shm: names added / removed / resized since the saved snapshot", function (done) {
    var raw = storageGet(BASELINE_KEY), base = null;
    try { base = raw ? JSON.parse(raw) : null; } catch (e) { base = null; }
    if (!base) { done("NOT_AVAILABLE", null, "no saved snapshot: press SNAPSHOT SHM first (with dcapture/Nuvio idle), then run this again with dcapture active"); return; }
    R.listDir("/dev/shm", function (error, entries) {
      if (error) { done(R.statusForError(error), null, error); return; }
      var before = {}, now = {}, added = [], removed = [], resized = [], unchanged = 0;
      base.entries.forEach(function (e) { before[e.name] = e; });
      entries.forEach(function (e) { now[e.name] = e; });
      entries.forEach(function (e) {
        if (!before[e.name]) added.push({ name: e.name, size: e.size });
        else if (before[e.name].size !== e.size) resized.push({ name: e.name, before: before[e.name].size, after: e.size });
        else unchanged++;
      });
      base.entries.forEach(function (e) { if (!now[e.name]) removed.push({ name: e.name, size: e.size }); });
      done(added.length || removed.length || resized.length ? "PASS" : "PARTIAL", { baselineAt: base.at, baselineCount: base.entries.length, currentCount: entries.length, added: added, removed: removed, resized: resized, unchangedCount: unchanged },
        added.length || removed.length || resized.length ? null : "no difference from the snapshot");
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
