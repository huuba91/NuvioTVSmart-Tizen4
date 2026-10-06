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
  R.hex = hex;
  R.text = text;

  // offset/hex/printable dump, 16 bytes per line, capped at 256 lines (4096 bytes) so a report never carries a megabyte of text.
  R.hexDump = function (bytes, max, base) {
    var lines = [], i, j, limit = Math.min(bytes.length, max || 4096), hexPart, textPart, b, offset = base || 0;
    for (i = 0; i < limit; i += 16) {
      hexPart = []; textPart = "";
      for (j = i; j < Math.min(i + 16, limit); j++) { b = bytes[j] & 255; hexPart.push((b < 16 ? "0" : "") + b.toString(16)); textPart += b >= 32 && b < 127 ? String.fromCharCode(b) : "."; }
      lines.push(pad6(offset + i) + "  " + hexPart.join(" ") + "  " + textPart);
    }
    return lines.join("\n");
  };
  // Runs of at least minLen printable ASCII characters (the "strings" view), capped at 40 runs.
  R.printableStrings = function (bytes, minLen) {
    var out = [], cur = "", i, b, min = minLen || 4;
    for (i = 0; i <= bytes.length; i++) {
      b = i < bytes.length ? bytes[i] & 255 : 0;
      if (b >= 32 && b < 127) cur += String.fromCharCode(b);
      else { if (cur.length >= min && out.length < 40) out.push(cur); cur = ""; }
    }
    return out;
  };
  function pad6(n) { var s = n.toString(16); while (s.length < 6) s = "0" + s; return s; }

  // Common file signatures and printable/zero ratios, from whatever bytes were already read.
  R.classifyBytes = function (bytes) {
    var n = bytes.length, printable = 0, zero = 0, i, b, out = { byteCount: n, printableRatio: 0, zeroByteRatio: 0, likelyJPEG: false, likelyPNG: false, likelyGZIP: false, likelyELF: false, likelyText: false, likelyBinary: false };
    for (i = 0; i < n; i++) { b = bytes[i] & 255; if (b === 0) zero++; if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13) printable++; }
    if (n) { out.printableRatio = Math.round(printable / n * 1000) / 1000; out.zeroByteRatio = Math.round(zero / n * 1000) / 1000; }
    out.likelyJPEG = n > 2 && (bytes[0] & 255) === 0xff && (bytes[1] & 255) === 0xd8 && (bytes[2] & 255) === 0xff;
    out.likelyPNG = n > 3 && (bytes[0] & 255) === 0x89 && (bytes[1] & 255) === 0x50 && (bytes[2] & 255) === 0x4e && (bytes[3] & 255) === 0x47;
    out.likelyGZIP = n > 1 && (bytes[0] & 255) === 0x1f && (bytes[1] & 255) === 0x8b;
    out.likelyELF = n > 3 && (bytes[0] & 255) === 0x7f && (bytes[1] & 255) === 0x45 && (bytes[2] & 255) === 0x4c && (bytes[3] & 255) === 0x46;
    out.likelyText = !out.likelyJPEG && !out.likelyPNG && !out.likelyGZIP && !out.likelyELF && out.printableRatio >= 0.85;
    out.likelyBinary = !out.likelyText && !out.likelyJPEG && !out.likelyPNG && !out.likelyGZIP && !out.likelyELF;
    return out;
  };

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
        }, function (e) { info.error = "open: " + R.errText(e); checkWritable(); }, "UTF-8");
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

  // Raw bytes of one file, up to maxBytes. cb({ exists, isFile, isDirectory, fileSize, modified, readable, bytesRead, bytes, error })
  R.readFile = function (path, maxBytes, cb) {
    var out = { path: path, exists: false, isFile: false, isDirectory: false, fileSize: null, modified: null, readable: false, bytesRead: 0, bytes: null, error: null };
    resolveAny(path.charAt(0) === "/" ? ["file://" + path, path] : [path], "r", function (error, file) {
      if (error) { out.error = error; cb(out); return; }
      out.exists = true;
      try { out.isDirectory = !!file.isDirectory; out.isFile = !!file.isFile; out.fileSize = file.isFile ? file.fileSize : null; out.modified = R.safe(function () { return file.modified ? new Date(file.modified).toISOString() : null; }, null); }
      catch (e) { out.error = "stat: " + R.errText(e); cb(out); return; }
      if (!out.isFile) { cb(out); return; }
      if (!out.fileSize) { out.readable = true; out.bytes = []; cb(out); return; }
      try {
        file.openStream("r", function (stream) {
          try { out.bytes = stream.readBytes(Math.min(out.fileSize, maxBytes || 4096)); out.bytesRead = out.bytes.length; out.readable = true; }
          catch (e2) { out.error = "read: " + R.errText(e2); }
          try { stream.close(); } catch (e3) { /* ignore */ }
          cb(out);
        }, function (e4) { out.error = "open: " + R.errText(e4); cb(out); }, "UTF-8");
      } catch (e5) { out.error = "open: " + R.errText(e5); cb(out); }
    });
  };

  // Small, fast hash (FNV-1a, 32-bit) of whatever bytes were already read - just enough to tell "changed" from "unchanged"
  // across watch samples; not a security hash.
  R.hashBytes = function (bytes) {
    var h = 0x811c9dc5, i;
    for (i = 0; i < bytes.length; i++) { h ^= bytes[i] & 255; h = (h * 0x01000193) >>> 0; }
    return ("00000000" + h.toString(16)).slice(-8);
  };

  // Low-level, step-by-step read of one existing file (named exactly as the spec's six steps): resolve, size, open,
  // bytesAvailable, read<maxBytes> (256 by default - deliberately small so a 1.3 MB shared-memory object is never read whole),
  // close. cb({ path, steps: { resolve, size, open, bytesAvailable, read, close }, readTimeMs, bytesRead, bytes, error })
  R.readShmObject = function (path, maxBytes, cb) {
    var limit = maxBytes || 256;
    var out = { path: path, steps: { resolve: null, size: null, open: null, bytesAvailable: null, read: null, close: null }, readTimeMs: null, bytesRead: 0, bytes: null, modified: null, error: null };
    resolveAny(path.charAt(0) === "/" ? ["file://" + path, path] : [path], "r", function (error, file) {
      if (error) { out.steps.resolve = error; out.error = "resolve: " + error; cb(out); return; }
      out.steps.resolve = "ok";
      out.modified = R.safe(function () { return file.modified ? new Date(file.modified).toISOString() : null; }, null);
      var size; try { size = file.fileSize; out.steps.size = size; } catch (e) { out.steps.size = R.errText(e); out.error = "size: " + R.errText(e); cb(out); return; }
      if (!size) { out.steps.open = "skipped (empty file)"; cb(out); return; }
      var begun = Date.now();
      try {
        file.openStream("r", function (stream) {
          out.steps.open = "ok";
          out.steps.bytesAvailable = R.safe(function () { return stream.bytesAvailable; }, "(not exposed by this FileStream)");
          try {
            out.bytes = stream.readBytes(Math.min(size, limit));
            out.bytesRead = out.bytes.length;
            out.steps.read = "ok (" + out.bytesRead + " of up to " + limit + " requested)";
          } catch (e2) { out.steps.read = R.errText(e2); out.error = "read: " + R.errText(e2); }
          out.readTimeMs = Date.now() - begun;
          try { stream.close(); out.steps.close = "ok"; } catch (e3) { out.steps.close = R.errText(e3); }
          cb(out);
        }, function (e4) { out.steps.open = R.errText(e4); out.error = "open: " + R.errText(e4); out.readTimeMs = Date.now() - begun; cb(out); }, "UTF-8");
      } catch (e5) { out.steps.open = R.errText(e5); out.error = "open: " + R.errText(e5); cb(out); }
    });
  };

  // One level of a directory as objects: cb(error, [{ name, size, isDirectory, modified }])
  R.listDir = function (path, cb) {
    resolveAny(path.charAt(0) === "/" ? ["file://" + path, path] : [path], "r", function (error, dir) {
      if (error) { cb(error); return; }
      try {
        dir.listFiles(function (files) {
          var out = [], i;
          for (i = 0; i < files.length; i++) out.push({ name: files[i].name, size: files[i].isFile ? files[i].fileSize : null, isDirectory: !!files[i].isDirectory,
            modified: R.safe(function () { return files[i].modified ? new Date(files[i].modified).toISOString() : null; }, null) });
          cb(null, out);
        }, function (e) { cb("list: " + R.errText(e)); });
      } catch (e2) { cb("list: " + R.errText(e2)); }
    });
  };

  // Hashes `windowSize`-byte windows at several offsets of one file with ONE open stream (position is set before each read).
  // offsets: numbers, or -1 meaning "the last window" (size - windowSize). cb({ size, modified, windows: [{ offset, bytesRead, hash, zeroRatio, error }], error })
  R.readWindows = function (path, offsets, windowSize, cb) {
    var out = { size: null, modified: null, windows: [], error: null };
    resolveAny(path.charAt(0) === "/" ? ["file://" + path, path] : [path], "r", function (error, file) {
      if (error) { out.error = "resolve: " + error; cb(out); return; }
      try { out.size = file.fileSize; out.modified = R.safe(function () { return file.modified ? new Date(file.modified).toISOString() : null; }, null); }
      catch (e) { out.error = "stat: " + R.errText(e); cb(out); return; }
      try {
        file.openStream("r", function (stream) {
          offsets.forEach(function (wanted) {
            var offset = wanted === -1 ? Math.max(0, out.size - windowSize) : wanted, entry = { offset: offset, bytesRead: 0, hash: null, zeroRatio: null, error: null };
            out.windows.push(entry);
            if (offset >= out.size) { entry.error = "beyond end of file (" + out.size + " bytes)"; return; }
            try {
              stream.position = offset;
              var bytes = stream.readBytes(Math.min(windowSize, out.size - offset)), zeros = 0, i;
              for (i = 0; i < bytes.length; i++) if ((bytes[i] & 255) === 0) zeros++;
              entry.bytesRead = bytes.length; entry.hash = R.hashBytes(bytes); entry.zeroRatio = bytes.length ? Math.round(zeros / bytes.length * 1000) / 1000 : null;
            } catch (e2) { entry.error = R.errText(e2); }
          });
          try { stream.close(); } catch (e3) { /* ignore */ }
          cb(out);
        }, function (e4) { out.error = "open: " + R.errText(e4); cb(out); }, "UTF-8");
      } catch (e5) { out.error = "open: " + R.errText(e5); cb(out); }
    });
  };

  // One complete read with every phase timed separately (ms, fractional): resolve, stat, open, read, close. Reads the WHOLE file
  // up to maxBytes (default 4 MB). cb({ ok, error, size, bytes, timings: { resolve, stat, open, read, close, total } })
  R.readTimed = function (path, maxBytes, cb) {
    var t0 = R.now(), out = { ok: false, error: null, size: null, modified: null, bytes: null, timings: { resolve: null, stat: null, open: null, read: null, close: null, total: null } };
    resolveAny(path.charAt(0) === "/" ? ["file://" + path, path] : [path], "r", function (error, file) {
      var t1 = R.now();
      out.timings.resolve = t1 - t0;
      if (error) { out.error = "resolve: " + error; out.timings.total = R.now() - t0; cb(out); return; }
      var size;
      try { size = file.fileSize; out.size = size; out.modified = R.safe(function () { return file.modified ? new Date(file.modified).toISOString() : null; }, null); }
      catch (e) { out.error = "stat: " + R.errText(e); out.timings.total = R.now() - t0; cb(out); return; }
      var t2 = R.now();
      out.timings.stat = t2 - t1;
      try {
        file.openStream("r", function (stream) {
          var t3 = R.now(), t4, t5;
          out.timings.open = t3 - t2;
          try { out.bytes = size ? stream.readBytes(Math.min(size, maxBytes || 4194304)) : []; out.ok = true; } catch (e2) { out.error = "read: " + R.errText(e2); }
          t4 = R.now();
          out.timings.read = t4 - t3;
          try { stream.close(); } catch (e3) { /* ignore */ }
          t5 = R.now();
          out.timings.close = t5 - t4;
          out.timings.total = t5 - t0;
          cb(out);
        }, function (e4) { out.error = "open: " + R.errText(e4); out.timings.total = R.now() - t0; cb(out); }, "UTF-8");
      } catch (e5) { out.error = "open: " + R.errText(e5); out.timings.total = R.now() - t0; cb(out); }
    });
  };

  // Polls one path's size/mtime/content fingerprint for durationMs, no faster than every minGapMs (default 100 ms = 10 Hz).
  // cb({ path, samples, changes: { mtime, size, content } })
  R.watchPath = function (path, durationMs, minGapMs, cb) {
    var out = { path: path, samples: [] }, began = Date.now();
    (function next() {
      R.readFile(path, 16, function (info) {
        out.samples.push({ at: Date.now() - began, size: info.fileSize, modified: info.modified, error: info.error,
          first16Hex: info.bytes && info.bytes.length ? R.hex(info.bytes, 16) : null });
        if (Date.now() - began >= durationMs) { finish(); return; }
        setTimeout(next, minGapMs || 100);
      });
    })();
    function finish() {
      var sizes = {}, mods = {}, hexes = {};
      out.samples.forEach(function (s) { sizes[s.size] = 1; mods[s.modified] = 1; hexes[s.first16Hex] = 1; });
      out.changes = { size: Object.keys(sizes).length - 1, mtime: Object.keys(mods).length - 1, content: Object.keys(hexes).length - 1 };
      out.changes.total = Math.max(out.changes.size, out.changes.mtime, out.changes.content, 0);
      cb(out);
    }
  };

  var WRITE_PAYLOAD = "NU7100_RECON_TEST";

  // Create, write, close, reopen, read back, verify and delete a file with a unique name of our own.
  // cb({ ok, steps: { resolve, create, write, read, verify, delete }, error, created, deleted })
  // The v0.1 bug: openStream's 4th argument is the ENCODING, not the mode ("w" there is not a valid encoding
  // and threw TypeMismatchError before a single byte was written) - openStream(mode, onSuccess, onError, encoding).
  function writeTest(dirLocation, cb) {
    var name = "nu7100-recon-write-test-" + Date.now(), encoding = "UTF-8";
    var out = { dir: dirLocation, name: name, ok: false, created: false, deleted: false, error: null,
      steps: { resolve: null, create: null, write: null, read: null, verify: null, delete: null } };
    function end(error) { if (error) out.error = error; cb(out); }
    function cleanup(dir, file, error) {
      var candidates = [];
      try { if (file && file.fullPath) candidates.push(file.fullPath); } catch (e) { /* ignore */ }
      try { if (file && file.toURI) candidates.push(file.toURI()); } catch (e1) { /* ignore */ }
      candidates.push(dirLocation.replace(/\/$/, "") + "/" + name);
      var i = 0;
      (function tryDelete() {
        while (i < candidates.length && candidates[i].slice(-name.length) !== name) i++; // only ever our own file
        if (i >= candidates.length) { out.steps.delete = "could not delete " + name + " (tried " + candidates.join(", ") + ")"; end(error || out.steps.delete); return; }
        var candidate = candidates[i++];
        try {
          dir.deleteFile(candidate, function () { out.deleted = true; out.steps.delete = "ok via " + candidate; end(error); },
            function (e3) { out.steps.delete = R.errText(e3); tryDelete(); });
        } catch (e2) { out.steps.delete = R.errText(e2); tryDelete(); }
      })();
    }
    resolveAny(dirLocation.charAt(0) === "/" ? ["file://" + dirLocation, dirLocation] : [dirLocation], "rw", function (error, dir) {
      if (error) { out.steps.resolve = error; end("resolve rw: " + error); return; }
      out.steps.resolve = "ok";
      var file;
      try { file = dir.createFile(name); out.created = true; out.steps.create = "ok"; } catch (e) { out.steps.create = R.errText(e); end("createFile: " + R.errText(e)); return; }
      try {
        file.openStream("w", function (writeStream) {
          try { writeStream.write(WRITE_PAYLOAD); writeStream.close(); out.steps.write = "ok (" + WRITE_PAYLOAD.length + " bytes)"; }
          catch (e2) { out.steps.write = R.errText(e2); cleanup(dir, file, "write: " + R.errText(e2)); return; }
          // Reopen (not the same handle) so this is a genuine readback, not the writer's own buffer.
          resolveAny([dirLocation.replace(/\/$/, "") + "/" + name], "r", function (reErr, reread) {
            if (reErr) { out.steps.read = reErr; cleanup(dir, file, "reopen for read: " + reErr); return; }
            try {
              reread.openStream("r", function (readStream) {
                var back;
                try { back = readStream.read(WRITE_PAYLOAD.length); out.steps.read = "ok (" + back.length + " chars)"; }
                catch (e3) { out.steps.read = R.errText(e3); cleanup(dir, file, "read: " + R.errText(e3)); return; }
                try { readStream.close(); } catch (e4) { /* ignore */ }
                out.readBack = back;
                out.steps.verify = back === WRITE_PAYLOAD ? "exact match" : "MISMATCH: wrote " + JSON.stringify(WRITE_PAYLOAD) + ", read " + JSON.stringify(back);
                out.ok = back === WRITE_PAYLOAD;
                cleanup(dir, file, out.ok ? null : out.steps.verify);
              }, function (e5) { out.steps.read = R.errText(e5); cleanup(dir, file, "openStream r: " + R.errText(e5)); }, encoding);
            } catch (e6) { out.steps.read = R.errText(e6); cleanup(dir, file, "openStream r: " + R.errText(e6)); }
          });
        }, function (e7) { out.steps.write = R.errText(e7); cleanup(dir, file, "openStream w: " + R.errText(e7)); }, encoding);
      } catch (e8) { out.steps.write = R.errText(e8); cleanup(dir, file, "openStream w: " + R.errText(e8)); }
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
