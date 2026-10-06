// What a WGT can see of the dcapture output (/dev/shm), and Chromium/WebKit temp sockets in /tmp. Only explicit paths, never a crawl.
(function (R) {
  "use strict";
  var LOOKS = /nuvio|capture|dcap|series|bench|hunt|\.jpe?g$|\.png$|\.bmp$/i;
  var TMP_LOOKS = /\.sock(et)?$|port|inspector|webkit|chromium/i;

  R.define("dcapture", "dcapture.shm_list", "/dev/shm: capture-looking files", function (done) {
    R.probePath("/dev/shm", { nameLimit: 400 }, function (info) {
      if (!info.exists) { done(R.statusForError(info.error), { exists: false }, info.error); return; }
      var names = info.entries || [], hits = [], i;
      for (i = 0; i < names.length; i++) if (LOOKS.test(names[i])) hits.push(names[i]);
      done(info.listable ? "PASS" : "PARTIAL", { listable: info.listable, totalEntries: info.entryCount, captureLooking: hits.slice(0, 40), captureLookingCount: hits.length }, info.error);
    });
  });

  // READ: stat + first 256 bytes + signature + read latency, for a path entered after watching Nuvio capture.
  R.define("dcapture", "dcapture.known_path", "Known dcapture file (manual path): READ", function (done) {
    var path = R.inputs.dcapturePath;
    if (!path) { done("NOT_AVAILABLE", null, "no path entered (type one in 'Known dcapture path' while Nuvio is capturing)"); return; }
    var begun = Date.now();
    R.readFile(path, 4096, function (info) {
      var ms = Date.now() - begun;
      if (!info.exists) { done(R.statusForError(info.error), { readTimeMs: ms }, info.error); return; }
      if (!info.isFile) { done("PARTIAL", { type: info.isDirectory ? "directory" : "other", readTimeMs: ms }, "not a regular file"); return; }
      var cls = R.classifyBytes(info.bytes || []);
      done(info.readable ? "PASS" : "BLOCKED", { size: info.fileSize, modified: info.modified, readTimeMs: ms, bytesRead: info.bytesRead,
        first256Hex: R.hexDump(info.bytes, 256), looksLikeJpeg: cls.likelyJPEG, looksLikePng: cls.likelyPNG, printableRatio: cls.printableRatio }, info.error);
    });
  });

  // WATCH 5 SEC: does the known dcapture file change on its own, at up to 10 Hz, while Nuvio writes it?
  R.define("dcapture", "dcapture.watch", "Known dcapture file: WATCH 5 SEC", function (done) {
    var path = R.inputs.dcapturePath;
    if (!path) { done("NOT_AVAILABLE", null, "no path entered"); return; }
    R.watchPath(path, 5000, 100, function (out) {
      var reached = out.samples.some(function (s) { return !s.error; });
      done(!reached ? R.statusForError(out.samples[0] && out.samples[0].error) : (out.changes.total > 0 ? "PASS" : "PARTIAL"), out,
        reached && out.changes.total === 0 ? "file visible but unchanged over 5 s (not being rewritten while watched, or Nuvio capture is not running)" : (reached ? null : out.samples[0] && out.samples[0].error));
    });
  });

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
