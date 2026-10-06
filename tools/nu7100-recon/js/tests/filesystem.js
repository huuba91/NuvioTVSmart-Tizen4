// Filesystem reconnaissance through tizen.filesystem only. A handful of explicit probes, never a recursive walk.
(function (R) {
  "use strict";
  var win = typeof window !== "undefined" ? window : this;
  var MAX_READ = 4096;
  R.MAX_READ = MAX_READ;

  function fsApi() { return win.tizen && win.tizen.filesystem; }

  // Tries each location until one resolves: cb(error, file, location)
  function resolveAny(locations, mode, cb) {
    var fs = fsApi(), i = 0, errors = [];
    if (!fs) { cb("tizen.filesystem undefined"); return; }
    (function next() {
      if (i >= locations.length) { cb(errors.join(" | ")); return; }
      var location = locations[i++];
      try {
        fs.resolve(location, function (file) { cb(null, file, location); }, function (e) { errors.push(location + ": " + R.errText(e)); next(); }, mode);
      } catch (e2) { errors.push(location + ": " + R.errText(e2)); next(); }
    })();
  }
  R.resolveAny = resolveAny;

  function hex(bytes, count) {
    var out = [], i;
    for (i = 0; i < bytes.length && i < count; i++) out.push((bytes[i] < 16 ? "0" : "") + (bytes[i] & 255).toString(16));
    return out.join(" ");
  }
  function text(bytes, count) {
    var out = "", i, c;
    for (i = 0; i < bytes.length && i < count; i++) { c = bytes[i]; out += c >= 32 && c < 127 ? String.fromCharCode(c) : "."; }
    return out;
  }

  // The result of probing one path. opts: { nameLimit }
  function probePath(path, opts, cb) {
    var finished = false, info = { path: path, exists: false, type: null, size: null, modified: null, readable: false, writableByResolve: false, listable: false,
      entryCount: null, entries: null, bytesRead: 0, firstBytesHex: null, firstBytesText: null, looksLikeJpeg: false, resolvedAs: null, readOnlyFlag: null, error: null };
    var limit = (opts && opts.nameLimit) || 60, timer;
    function finish() { if (finished) return; finished = true; clearTimeout(timer); cb(info); }
    timer = setTimeout(function () { info.error = (info.error ? info.error + "; " : "") + "probe timed out"; finish(); }, 9000);

    function checkWritable() {
      resolveAny([info.resolvedAs], "rw", function (error) { info.writableByResolve = !error; if (error && !info.writeNote) info.writeNote = error; finish(); });
    }
    function readFile(file) {
      var size = file.fileSize;
      if (!size) { info.readable = true; checkWritable(); return; }
      try {
        file.openStream("r", function (stream) {
          try {
            var bytes = stream.readBytes(Math.min(size, MAX_READ));
            info.bytesRead = bytes.length; info.readable = true;
            info.firstBytesHex = hex(bytes, 32); info.firstBytesText = text(bytes, 96);
            info.looksLikeJpeg = bytes.length > 2 && bytes[0] === 255 && bytes[1] === 216;
          } catch (e) { info.error = "read: " + R.errText(e); }
          try { stream.close(); } catch (e2) { /* ignore */ }
          checkWritable();
        }, function (e) { info.error = "open: " + R.errText(e); checkWritable(); }, "r");
      } catch (e3) { info.error = "open: " + R.errText(e3); checkWritable(); }
    }
    function listDir(dir) {
      try {
        dir.listFiles(function (files) {
          var names = [], i;
          info.listable = true; info.readable = true; info.entryCount = files.length;
          for (i = 0; i < files.length && i < limit; i++) names.push((files[i].isDirectory ? "d " : "f ") + files[i].name + (files[i].isFile ? " " + files[i].fileSize : ""));
          info.entries = names;
          checkWritable();
        }, function (e) { info.error = "list: " + R.errText(e); checkWritable(); });
      } catch (e2) { info.error = "list: " + R.errText(e2); checkWritable(); }
    }
    var candidates = path.charAt(0) === "/" ? ["file://" + path, path] : [path];
    resolveAny(candidates, "r", function (error, file, used) {
      if (error) { info.error = error; finish(); return; }
      info.exists = true; info.resolvedAs = used;
      try {
        info.type = file.isDirectory ? "directory" : (file.isFile ? "file" : "other");
        info.size = file.isFile ? file.fileSize : null;
        info.modified = file.modified ? new Date(file.modified).toISOString() : null;
        info.readOnlyFlag = file.readOnly;
      } catch (e) { info.error = "stat: " + R.errText(e); }
      if (info.type === "directory") listDir(file); else if (info.type === "file") readFile(file); else checkWritable();
    });
  }
  R.probePath = probePath;

  // Create, verify and delete a file with a unique name of our own. cb({ ok, steps, error, created, deleted })
  function writeTest(dirLocation, cb) {
    var name = "nu7100-recon-test-" + Date.now(), out = { dir: dirLocation, name: name, ok: false, steps: [], error: null, created: false, deleted: false };
    function end(error) { if (error) out.error = error; cb(out); }
    function cleanup(dir, file, error) {
      var candidates = [];
      try { if (file && file.fullPath) candidates.push(file.fullPath); } catch (e) { /* ignore */ }
      try { if (file && file.toURI) candidates.push(file.toURI()); } catch (e1) { /* ignore */ }
      candidates.push(dirLocation.replace(/\/$/, "") + "/" + name);
      var i = 0;
      (function tryDelete() {
        while (i < candidates.length && candidates[i].slice(-name.length) !== name) i++; // only ever our own file
        if (i >= candidates.length) { end(error ? error : "created but could not delete " + name + " (tried " + candidates.join(", ") + ")"); return; }
        var candidate = candidates[i++];
        try {
          dir.deleteFile(candidate, function () { out.deleted = true; out.steps.push("deleted via " + candidate); end(error); }, function () { tryDelete(); });
        } catch (e2) { tryDelete(); }
      })();
    }
    resolveAny(dirLocation.charAt(0) === "/" ? ["file://" + dirLocation, dirLocation] : [dirLocation], "rw", function (error, dir) {
      if (error) { out.steps.push("resolve rw failed"); end("resolve rw: " + error); return; }
      out.steps.push("resolved rw");
      var file;
      try { file = dir.createFile(name); out.created = true; out.steps.push("created"); } catch (e) { end("createFile: " + R.errText(e)); return; }
      try {
        file.openStream("w", function (stream) {
          try { stream.write("nu7100-recon"); stream.close(); out.steps.push("wrote 12 bytes"); } catch (e2) { cleanup(dir, file, "write: " + R.errText(e2)); return; }
          dir.listFiles(function (files) {
            var seen = false, i;
            for (i = 0; i < files.length; i++) if (files[i].name === name) { seen = true; out.sizeSeen = files[i].fileSize; }
            out.steps.push(seen ? "visible in listing" : "NOT in listing");
            out.ok = seen && out.sizeSeen === 12;
            cleanup(dir, file, out.ok ? null : "written file not seen with the right size");
          }, function (e3) { out.ok = true; out.steps.push("listing failed: " + R.errText(e3)); cleanup(dir, file, null); });
        }, function (e4) { cleanup(dir, file, "openStream w: " + R.errText(e4)); }, "w");
      } catch (e5) { cleanup(dir, file, "openStream w: " + R.errText(e5)); }
    });
  }
  R.writeTest = writeTest;

  R.define("filesystem", "filesystem.roots", "Virtual roots (documents, wgt-private, ...)", function (done) {
    var fs = fsApi();
    if (!fs) { done("NOT_AVAILABLE", null, "tizen.filesystem undefined"); return; }
    var names = ["documents", "images", "videos", "music", "downloads", "ringtones", "camera", "removable", "wgt-package", "wgt-private", "wgt-private-tmp", "wgt-private-root"];
    var out = { storages: null, roots: {} }, ok = 0, i = 0;
    try { fs.listStorages(function (list) { out.storages = list.map(function (s) { return { label: s.label, type: s.type, state: s.state }; }); }, function (e) { out.storages = "error: " + R.errText(e); }); } catch (e) { out.storages = "error: " + R.errText(e); }
    (function next() {
      if (i >= names.length) { done(ok === names.length ? "PASS" : ok ? "PARTIAL" : "BLOCKED", out, ok + " of " + names.length + " roots resolve"); return; }
      var name = names[i++];
      resolveAny([name], "r", function (error, dir) {
        if (error) { out.roots[name] = "ERROR " + error; next(); return; }
        ok++;
        var entry = { uri: R.safe(function () { return dir.toURI(); }), fullPath: dir.fullPath, readOnly: dir.readOnly, isDirectory: dir.isDirectory };
        out.roots[name] = entry;
        try { dir.listFiles(function (f) { entry.entryCount = f.length; next(); }, function (e2) { entry.listError = R.errText(e2); next(); }); } catch (e3) { entry.listError = R.errText(e3); next(); }
      });
    })();
  });

  ["/", "/tmp", "/dev", "/dev/shm", "/proc", "/sys", "/home", "/opt"].forEach(function (path) {
    R.define("filesystem", "filesystem.path." + path, "Path " + path, function (done) {
      if (!fsApi()) { done("NOT_AVAILABLE", null, "tizen.filesystem undefined"); return; }
      probePath(path, { nameLimit: 25 }, function (info) {
        var status = !info.exists ? R.statusForError(info.error) : (info.readable || info.listable ? "PASS" : "PARTIAL");
        done(status, info, info.error);
      });
    });
  });

  [["/dev/shm", "filesystem.write./dev/shm"], ["/tmp", "filesystem.write./tmp"], ["wgt-private-tmp", "filesystem.write.wgt-private-tmp"]].forEach(function (t) {
    R.define("filesystem", t[1], "Create/write/delete own file in " + t[0], function (done) {
      if (!fsApi()) { done("NOT_AVAILABLE", null, "tizen.filesystem undefined"); return; }
      writeTest(t[0], function (out) { done(out.ok && out.deleted ? "PASS" : (out.ok ? "PARTIAL" : R.statusForError(out.error)), out, out.error); });
    });
  });
})(Recon);
