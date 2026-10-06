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

  // One non-semaphore /dev/shm object: size, first 256/4096 bytes, signature, text/binary ratios. Read-only.
  function shmObjectTest(name) {
    R.define("sharedmem", "sharedmem.object." + name, "/dev/shm/" + name, function (done) {
      R.readFile("/dev/shm/" + name, 4096, function (info) {
        if (!info.exists) { done(R.statusForError(info.error), null, info.error); return; }
        if (!info.isFile) { done("PARTIAL", { type: info.isDirectory ? "directory" : "other" }, "not a regular file"); return; }
        var out = { name: name, size: info.fileSize, modified: info.modified, bytesRead: info.bytesRead, first256Hex: null, first4096Hex: null };
        if (info.bytes && info.bytes.length) {
          var cls = R.classifyBytes(info.bytes);
          out.first256Hex = R.hexDump(info.bytes, 256);
          out.first4096Hex = info.bytesRead > 256 ? R.hexDump(info.bytes, 4096) : null;
          out.printableRatio = cls.printableRatio; out.zeroByteRatio = cls.zeroByteRatio;
          out.likelyText = cls.likelyText; out.likelyBinary = cls.likelyBinary; out.likelyJPEG = cls.likelyJPEG; out.likelyPNG = cls.likelyPNG; out.likelyGZIP = cls.likelyGZIP; out.likelyELF = cls.likelyELF;
        }
        done(info.readable ? "PASS" : "BLOCKED", out, info.error);
      });
    });
  }
  ["shm_ave", "shm_ave_tddg", "shm_socpq", "shm_tvsystem"].forEach(shmObjectTest);

  // High priority: the WebKit remote-inspector port/token file. Report only what is read - never interpreted.
  R.define("sharedmem", "sharedmem.inspector_port", "/dev/shm/" + INSPECTOR_NAME, function (done) {
    R.readFile("/dev/shm/" + INSPECTOR_NAME, 4096, function (info) {
      if (!info.exists) { done(R.statusForError(info.error), null, info.error); return; }
      if (!info.readable) { done("BLOCKED", { size: info.fileSize }, info.error); return; }
      var cls = R.classifyBytes(info.bytes || []);
      done("PASS", { size: info.fileSize, modified: info.modified, hex: R.hexDump(info.bytes, 4096), asText: R.text(info.bytes, info.bytes.length),
        printableRatio: cls.printableRatio, looksNumeric: /^\s*\d+\s*$/.test(R.text(info.bytes, info.bytes.length)) });
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
