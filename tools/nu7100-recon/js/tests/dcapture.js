// What a WGT can see of the dcapture output (/dev/shm), and Chromium/WebKit temp sockets in /tmp. Only explicit paths, never a crawl.
(function (R) {
  "use strict";
  var LOOKS = /nuvio|capture|dcap|series|bench|hunt|\.jpe?g$|\.png$|\.bmp$/i;
  var TMP_LOOKS = /\.sock(et)?$|port|inspector|webkit|chromium/i;
  var ITERATIONS = 50;

  function isJpeg(bytes) { return bytes.length > 2 && (bytes[0] & 255) === 0xff && (bytes[1] & 255) === 0xd8 && (bytes[2] & 255) === 0xff; }
  function hasEoi(bytes) { return bytes.length > 3 && (bytes[bytes.length - 2] & 255) === 0xff && (bytes[bytes.length - 1] & 255) === 0xd9; }

  R.define("dcapture", "dcapture.shm_list", "/dev/shm: capture-looking files", function (done) {
    R.probePath("/dev/shm", { nameLimit: 400 }, function (info) {
      if (!info.exists) { done(R.statusForError(info.error), { exists: false }, info.error); return; }
      var names = info.entries || [], hits = [], i;
      for (i = 0; i < names.length; i++) if (LOOKS.test(names[i])) hits.push(names[i]);
      done(info.listable ? "PASS" : "PARTIAL", { listable: info.listable, totalEntries: info.entryCount, captureLooking: hits.slice(0, 40), captureLookingCount: hits.length }, info.error);
    });
  });

  // READ: one complete read of the known capture file - resolve, stat, open, read all, close - each phase timed, JPEG checked.
  R.define("dcapture", "dcapture.known_path", "Known dcapture file: READ whole file once", function (done) {
    var path = R.inputs.dcapturePath;
    if (!path) { done("NOT_AVAILABLE", null, "no path entered"); return; }
    R.readTimed(path, 4194304, function (r) {
      if (!r.ok) { done(R.statusForError(r.error), { path: path, timingsMs: r.timings, size: r.size }, r.error); return; }
      var bytes = r.bytes || [];
      done("PASS", { path: path, sizeBytes: r.size, bytesRead: bytes.length, complete: bytes.length === r.size, modified: r.modified, timingsMs: r.timings,
        startsWithFFD8FF: isJpeg(bytes), endsWithFFD9: hasEoi(bytes), looksLikeJpeg: isJpeg(bytes), first64Hex: R.hexDump(bytes, 64) }, null);
    });
  }, { timeoutMs: 20000 });

  // BENCHMARK: the same read 50 times back to back; mean/p50/p95 for every phase, JPEG validity, and how many distinct frames were seen.
  R.define("dcapture", "dcapture.benchmark", "Known dcapture file: " + ITERATIONS + "x direct read benchmark", function (done) {
    var path = R.inputs.dcapturePath;
    if (!path) { done("NOT_AVAILABLE", null, "no path entered"); return; }
    var series = { resolve: [], stat: [], open: [], read: [], close: [], total: [] }, sizes = {}, hashes = {}, valid = 0, torn = 0, failures = 0, firstError = null, consecutive = 0, count = 0, began = R.now();
    (function next() {
      if (count >= ITERATIONS) { finish(); return; }
      count++;
      R.readTimed(path, 4194304, function (r) {
        if (!r.ok) {
          failures++; consecutive++;
          if (!firstError) firstError = r.error;
          if (consecutive >= 3 && !series.total.length) { finish(); return; } // the file is not there: no point repeating
          setTimeout(next, 0);
          return;
        }
        consecutive = 0;
        var bytes = r.bytes || [];
        ["resolve", "stat", "open", "read", "close", "total"].forEach(function (k) { series[k].push(r.timings[k]); });
        sizes[r.size] = 1; hashes[R.hashBytes(bytes)] = 1;
        if (isJpeg(bytes)) valid++;
        if (!hasEoi(bytes) || bytes.length !== r.size) torn++;
        setTimeout(next, 0);
      });
    })();
    function finish() {
      var elapsed = R.now() - began, out = { path: path, iterationsAsked: ITERATIONS, iterationsDone: count, successes: series.total.length, failures: failures, firstError: firstError,
        startsWithFFD8FF: valid, incompleteOrNoEoi: torn, distinctSizes: Object.keys(sizes).length, distinctContents: Object.keys(hashes).length, elapsedMs: Math.round(elapsed),
        readsPerSecond: elapsed > 0 ? Math.round(series.total.length / (elapsed / 1000) * 10) / 10 : null, timingsMs: {} };
      ["resolve", "stat", "open", "read", "close", "total"].forEach(function (k) { out.timingsMs[k] = R.stats(series[k]); });
      done(series.total.length ? (failures || torn ? "PARTIAL" : "PASS") : R.statusForError(firstError), out, series.total.length ? null : firstError);
    }
  }, { timeoutMs: 60000 });

  // WATCH 5 SEC: full-file hash + mtime + size at ~10 Hz, to see whether Nuvio's capture file is being rewritten while we watch.
  R.define("dcapture", "dcapture.watch", "Known dcapture file: WATCH 5 SEC (full-file hash, ~10 Hz)", function (done) {
    var path = R.inputs.dcapturePath;
    if (!path) { done("NOT_AVAILABLE", null, "no path entered"); return; }
    var began = R.now(), samples = [];
    (function next() {
      R.readTimed(path, 262144, function (r) {
        samples.push({ at: Math.round(R.now() - began), size: r.size, modified: r.modified, hash: r.ok && r.bytes ? R.hashBytes(r.bytes) : null, error: r.error });
        if (R.now() - began >= 5000) { finish(); return; }
        setTimeout(next, 100);
      });
    })();
    function finish() {
      var sizes = {}, mods = {}, hashes = {}, reached = samples.filter(function (s) { return !s.error; }).length;
      samples.forEach(function (s) { if (!s.error) { sizes[s.size] = 1; mods[s.modified] = 1; hashes[s.hash] = 1; } });
      var out = { path: path, sampleCount: samples.length, readable: reached, changes: { size: Math.max(0, Object.keys(sizes).length - 1), mtime: Math.max(0, Object.keys(mods).length - 1), content: Math.max(0, Object.keys(hashes).length - 1) },
        firstSample: samples[0], lastSample: samples[samples.length - 1], samples: samples.length > 60 ? samples.slice(0, 60) : samples };
      out.changes.total = Math.max(out.changes.size, out.changes.mtime, out.changes.content);
      done(!reached ? R.statusForError(samples[0] && samples[0].error) : (out.changes.total > 0 ? "PASS" : "PARTIAL"), out,
        !reached ? (samples[0] && samples[0].error) : (out.changes.total === 0 ? "file readable but unchanged for 5 s (Nuvio's capture not running, or it is being rewritten between our polls)" : null));
    }
  }, { timeoutMs: 20000 });

  // /tmp, one level only: just the Chromium/WebKit/inspector/socket-looking names. Metadata only - no connection attempted.
  R.define("dcapture", "dcapture.tmp_sockets", "/tmp: socket/inspector/WebKit object inventory (one level)", function (done) {
    R.probePath("/tmp", { nameLimit: 400 }, function (info) {
      if (!info.exists) { done(R.statusForError(info.error), { exists: false }, info.error); return; }
      var names = info.entries || [], hits = [], i;
      for (i = 0; i < names.length; i++) if (TMP_LOOKS.test(names[i])) hits.push(names[i]);
      if (!hits.length) { done("NOT_AVAILABLE", { totalEntries: info.entryCount }, "no socket/port/inspector/WebKit/Chromium-looking name in this /tmp listing"); return; }
      var out = { matches: hits }, done2 = 0;
      hits.forEach(function (entry) {
        var name = entry.replace(/^[df]\s/, "").replace(/\s\d+$/, "");
        R.readFile("/tmp/" + name, 0, function (info2) {
          out[name] = { isFile: info2.isFile, isDirectory: info2.isDirectory, size: info2.fileSize, modified: info2.modified, error: info2.error };
          if (++done2 === hits.length) done("PASS", out);
        });
      });
    });
  });

  // One matching socket path (e.g. fcgi_plugin_0.socket): can resolve/stat/open even be attempted on it? No protocol traffic.
  R.define("dcapture", "dcapture.socket_open", "/tmp/fcgi_plugin_0.socket: resolve / stat / open-read", function (done) {
    R.readFile("/tmp/fcgi_plugin_0.socket", 16, function (info) {
      if (!info.exists) { done(R.statusForError(info.error), null, info.error); return; }
      var out = { isFile: info.isFile, isDirectory: info.isDirectory, size: info.fileSize, readable: info.readable, error: info.error };
      done(info.readable ? "PARTIAL" : "BLOCKED", out, info.error || "resolved/stated but not opened for byte traffic (as expected for a socket)");
    });
  });
})(Recon);
