// What a WGT can see of the dcapture output (/dev/shm). Only explicit paths, never a crawl.
(function (R) {
  "use strict";
  var LOOKS = /nuvio|capture|dcap|series|bench|hunt|\.jpe?g$|\.png$|\.bmp$/i;

  R.define("dcapture", "dcapture.shm_list", "/dev/shm: capture-looking files", function (done) {
    R.probePath("/dev/shm", { nameLimit: 400 }, function (info) {
      if (!info.exists) { done(R.statusForError(info.error), { exists: false }, info.error); return; }
      var names = info.entries || [], hits = [], i;
      for (i = 0; i < names.length; i++) if (LOOKS.test(names[i])) hits.push(names[i]);
      done(info.listable ? "PASS" : "PARTIAL", { listable: info.listable, totalEntries: info.entryCount, captureLooking: hits.slice(0, 40), captureLookingCount: hits.length }, info.error);
    });
  });

  R.define("dcapture", "dcapture.known_path", "Known dcapture file (manual path)", function (done) {
    var path = R.inputs.dcapturePath;
    if (!path) { done("NOT_AVAILABLE", null, "no path entered (type one in 'Known dcapture path' while Nuvio is capturing)"); return; }
    R.probePath(path, {}, function (info) {
      done(!info.exists ? R.statusForError(info.error) : (info.readable ? "PASS" : "PARTIAL"), info, info.error);
    });
  });

  // Does the file change while something else writes it? 6 stats, 400 ms apart.
  R.define("dcapture", "dcapture.watch", "Known dcapture file: size/mtime changes over ~2 s", function (done) {
    var path = R.inputs.dcapturePath, samples = [], n = 0;
    if (!path) { done("NOT_AVAILABLE", null, "no path entered"); return; }
    (function next() {
      R.resolveAny(["file://" + path, path], "r", function (error, file) {
        if (error) { samples.push({ error: error }); }
        else samples.push({ size: R.safe(function () { return file.fileSize; }), modified: R.safe(function () { return file.modified ? file.modified.getTime ? file.modified.getTime() : file.modified : null; }), at: Date.now() });
        if (++n < 6) { setTimeout(next, 400); return; }
        var good = samples.filter(function (s) { return !s.error; }), sizes = {}, mods = {};
        good.forEach(function (s) { sizes[s.size] = 1; mods[s.modified] = 1; });
        var out = { stats: good.length, distinctSizes: Object.keys(sizes).length, distinctModified: Object.keys(mods).length, samples: samples };
        done(good.length ? (out.distinctModified > 1 || out.distinctSizes > 1 ? "PASS" : "PARTIAL") : R.statusForError(samples[0] && samples[0].error), out,
          good.length && out.distinctModified <= 1 && out.distinctSizes <= 1 ? "file visible but unchanged (not being rewritten, or mtime has 1 s resolution)" : (good.length ? null : samples[0] && samples[0].error));
      });
    })();
  });
})(Recon);
