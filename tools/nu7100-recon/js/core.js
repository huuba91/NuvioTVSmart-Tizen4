// Test registry, runner, log and helpers. ES5 only (Chromium M56).
(function (g) {
  "use strict";
  var STATUSES = ["PASS", "FAIL", "BLOCKED", "NOT_AVAILABLE", "PARTIAL", "ERROR"];
  var GROUP_OF = { system: "system", api: "system", filesystem: "filesystem", dcapture: "filesystem", sharedmem: "filesystem", process: "process", network: "ipc", ipc: "ipc" };
  var Recon = { STATUSES: STATUSES, VERSION: "0.2.1", tests: [], results: {}, order: [], log: [], manualProbes: [], inputs: { dcapturePath: "", shmWatchPath: "" }, TIMEOUT_MS: 12000 };

  function pad(n) { return n < 10 ? "0" + n : String(n); }
  Recon.clock = function () { var d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); };
  Recon.stamp = function () { return new Date().toISOString(); };
  Recon.note = function (id, operation, result, error) {
    Recon.log.push({ timestamp: Recon.clock(), test: id, operation: operation, result: result, error: error || null });
    if (Recon.log.length > 2000) Recon.log.shift();
  };
  Recon.errText = function (e) {
    if (e === undefined || e === null) return "unknown error";
    if (typeof e === "string") return e;
    var name = e.name ? String(e.name) : "", message = e.message ? String(e.message) : "", code = e.code !== undefined ? " code " + e.code : "";
    return (name + (name && message ? ": " : "") + message + code) || String(e);
  };
  // A refusal (permission, security) is BLOCKED, anything else FAIL.
  Recon.statusForError = function (e) {
    return /permission|security|denied|access|not\s?allowed|forbidden|privilege|EACCES|EPERM/i.test(Recon.errText(e)) ? "BLOCKED" : "FAIL";
  };
  Recon.safe = function (fn, fallback) { try { return fn(); } catch (e) { return fallback === undefined ? "(error: " + Recon.errText(e) + ")" : fallback; } };
  Recon.short = function (value, max) {
    var text;
    if (value === undefined || value === null) return "";
    if (typeof value === "string") text = value;
    else { try { text = JSON.stringify(value); } catch (e) { text = String(value); } }
    max = max || 220;
    return text.length > max ? text.slice(0, max) + "..." : text;
  };
  // Looks a dotted name up on window: { state: EXISTS | UNDEFINED | ERROR, type }
  Recon.lookup = function (dotted) {
    try {
      var parts = dotted.split("."), cur = g, i;
      for (i = 0; i < parts.length; i++) {
        if (cur === undefined || cur === null) return { state: "UNDEFINED", type: "undefined" };
        cur = cur[parts[i]];
      }
      return cur === undefined ? { state: "UNDEFINED", type: "undefined" } : { state: "EXISTS", type: typeof cur };
    } catch (e) { return { state: "ERROR", type: Recon.errText(e) }; }
  };
  Recon.keysOf = function (obj, limit) {
    var out = [], k;
    try { for (k in obj) { out.push(k); if (out.length >= (limit || 400)) break; } } catch (e) { out.push("(error: " + Recon.errText(e) + ")"); }
    return out;
  };

  // define(group-category, id, name, fn(done)); done(status, value, error)
  // opts.timeoutMs overrides the default 12 s limit (the 50x read benchmark needs longer).
  Recon.define = function (category, id, name, fn, opts) {
    Recon.tests.push({ id: id, category: category, group: GROUP_OF[category] || category, name: name, fn: fn, timeoutMs: opts && opts.timeoutMs });
  };

  // Millisecond clock, fractional where performance.now exists (Chromium M56 has it).
  Recon.now = function () { return typeof performance !== "undefined" && performance && performance.now ? performance.now() : Date.now(); };
  // mean / p50 / p95 / min / max of a list of numbers (nearest-rank percentiles), rounded to 0.01.
  Recon.stats = function (list) {
    var n = list.length, sorted = list.slice().sort(function (a, b) { return a - b; }), sum = 0, i;
    function r(v) { return Math.round(v * 100) / 100; }
    function pick(q) { return sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))]; }
    if (!n) return { count: 0, mean: null, p50: null, p95: null, min: null, max: null };
    for (i = 0; i < n; i++) sum += list[i];
    return { count: n, mean: r(sum / n), p50: r(pick(0.5)), p95: r(pick(0.95)), min: r(sorted[0]), max: r(sorted[n - 1]) };
  };

  Recon.runTest = function (test, cb) {
    var finished = false, timer;
    function done(status, value, error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (STATUSES.indexOf(status) < 0) status = "ERROR";
      var result = { id: test.id, category: test.category, name: test.name, status: status, value: value === undefined ? null : value,
        error: error === undefined || error === null ? null : (typeof error === "string" ? error : Recon.errText(error)), timestamp: Recon.stamp() };
      Recon.results[test.id] = result;
      if (Recon.order.indexOf(test.id) < 0) Recon.order.push(test.id);
      Recon.note(test.id, test.name, status, result.error);
      cb(result);
    }
    var limit = test.timeoutMs || Recon.TIMEOUT_MS;
    timer = setTimeout(function () { done("ERROR", null, "test did not finish within " + limit / 1000 + " s"); }, limit);
    try { test.fn(done); } catch (e) { done("ERROR", null, e); }
  };

  // group: "all" | system | filesystem | process | ipc
  Recon.run = function (group, onProgress, onDone) {
    var list = [], i;
    for (i = 0; i < Recon.tests.length; i++) if (group === "all" || Recon.tests[i].group === group) list.push(Recon.tests[i]);
    var index = 0;
    (function next() {
      if (index >= list.length) { if (onDone) onDone(list.length); return; }
      var test = list[index++];
      Recon.runTest(test, function (result) {
        if (onProgress) onProgress(result, index, list.length);
        setTimeout(next, 0);
      });
    })();
  };

  Recon.value = function (id) { var r = Recon.results[id]; return r ? r.value : undefined; };
  Recon.status = function (id) { var r = Recon.results[id]; return r ? r.status : undefined; };

  Recon.counts = function () {
    var c = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_AVAILABLE: 0, PARTIAL: 0, ERROR: 0, done: 0, total: Recon.tests.length }, id;
    for (id in Recon.results) { c[Recon.results[id].status]++; c.done++; }
    return c;
  };

  function yn(v) { return v === true ? "YES" : v === false ? "NO" : "UNKNOWN"; }
  // Only reports what the tests actually returned.
  Recon.fingerprint = function () {
    var v = Recon.value, s = Recon.status, f = [], build = v("system.tizen.BUILD"), fp;
    fp = function (k, val) { f.push(k + "=" + val); };
    var product = v("system.samsung.productinfo") || {};
    fp("MODEL", (product.getRealModel || product.getModel || (build && build.model) || "unreported"));
    fp("FIRMWARE", (product.getFirmware || "unreported"));
    var caps = v("system.tizen.capabilities") || {};
    fp("TIZEN", caps.platformVersion || "unreported");
    var cpu = v("system.browser");
    fp("USER_AGENT", cpu && cpu.userAgent ? cpu.userAgent : "unreported");
    function dir(id, label) {
      var p = v(id);
      if (!p) { fp("FILESYSTEM=" + label, "NOT_RUN"); return; }
      fp("FILESYSTEM=" + label, p.exists ? (p.listable || p.readable ? "VISIBLE" : "VISIBLE/NOT_READABLE") + (p.writableByResolve ? "+RW_RESOLVE" : "") : "BLOCKED/MISSING (" + (p.error || "no such path") + ")");
    }
    dir("filesystem.path./dev/shm", "/dev/shm"); dir("filesystem.path./tmp", "/tmp"); dir("filesystem.path./proc", "/proc"); dir("filesystem.path./sys", "/sys");
    var w = v("filesystem.write./dev/shm"), t = v("filesystem.write./tmp");
    fp("WRITE=/dev/shm", w ? (w.ok ? "YES" : "NO (" + w.error + ")") : "NOT_RUN");
    fp("WRITE=/tmp", t ? (t.ok ? "YES" : "NO (" + t.error + ")") : "NOT_RUN");
    var node = v("process.node_globals");
    fp("NODEJS", node ? yn(node.nodeLike) : "NOT_RUN");
    fp("REQUIRE", node ? yn(node.require === "function") : "NOT_RUN");
    fp("EXEC", node ? yn(node.childProcessResolvable === true) : "NOT_RUN");
    var lh = s("network.localhost.127.0.0.1");
    fp("LOCALHOST", lh === "PASS" ? "YES" : lh ? "NO (" + lh + ")" : "NOT_RUN");
    var ws = s("network.websocket");
    fp("WEBSOCKET", ws === "PASS" ? "YES" : ws ? "NO (" + ws + ")" : "NOT_RUN");
    var ipc = v("ipc.objects");
    fp("D-BUS", ipc ? yn(ipc.dbusLike) : "NOT_RUN");
    var pid = v("process.pid_api");
    fp("PID_API", pid ? yn(pid.pidApi) : "NOT_RUN");
    var nacl = v("ipc.nacl");
    fp("NACL", nacl ? yn(nacl.nacl) : "NOT_RUN");
    return f;
  };

  // Short answers to the headline questions, visible without opening the full report.
  Recon.findings = function () {
    var v = Recon.value, s = Recon.status, out = { filesystemWrite: {}, sharedMemory: {}, inspector: {}, dcapture: {} };
    ["filesystem.write./dev/shm", "filesystem.write./tmp", "filesystem.write.wgt-private-tmp"].forEach(function (id) {
      var r = Recon.results[id]; if (r) out.filesystemWrite[id.replace("filesystem.write.", "")] = r.status + (r.value && r.value.steps ? " (" + JSON.stringify(r.value.steps) + ")" : "");
    });
    ["shm_ave", "shm_ave_tddg", "shm_socpq", "shm_tvsystem"].forEach(function (name) {
      var r = Recon.results["sharedmem.object." + name];
      out.sharedMemory[name] = r ? { status: r.status, size: r.value && r.value.steps && r.value.steps.size, readTimeMs: r.value && r.value.readTimeMs,
        likelyJPEG: r.value && r.value.likelyJPEG, likelyText: r.value && r.value.likelyText } : "NOT_RUN";
    });
    var watch = v("sharedmem.watch");
    out.sharedMemory.watchedPathChanges = watch ? watch.changes : "NOT_RUN";
    var windows = v("sharedmem.watch_windows");
    out.sharedMemory.windowWatch = "NOT_RUN";
    if (windows) {
      out.sharedMemory.windowWatch = {};
      Object.keys(windows.files).forEach(function (path) {
        var f = windows.files[path];
        out.sharedMemory.windowWatch[path.replace("/dev/shm/", "")] = { sizeChanges: f.sizeChanges, mtimeChanges: f.mtimeChanges,
          windows: f.windows.map(function (w) { return w.label + ": " + w.hashChanges + " changes / " + w.sampleCount + " samples" + (w.errors ? " (" + w.errors + " errors: " + w.firstError + ")" : ""); } ) };
      });
    }
    out.sharedMemory.diffSinceSnapshot = Recon.results["sharedmem.diff"] ? (v("sharedmem.diff") ? { added: v("sharedmem.diff").added, removed: v("sharedmem.diff").removed, resized: v("sharedmem.diff").resized } : s("sharedmem.diff")) : "NOT_RUN";
    var insp = v("sharedmem.inspector_port");
    out.inspector.port = s("sharedmem.inspector_port") || "NOT_RUN";
    out.inspector.value = insp ? { sizeBytes: insp.sizeBytes, complete: insp.complete, nonZeroByteCount: insp.nonZeroByteCount, strings: insp.strings, first256AllZero: insp.first256AllZero } : null;
    out.inspector.devToolsSemaphores = v("sharedmem.devtools_sem") || "NOT_RUN";
    var kp = v("dcapture.known_path"), bm = v("dcapture.benchmark"), dw = v("dcapture.watch");
    out.dcapture.knownPathRead = s("dcapture.known_path") || "NOT_RUN";
    out.dcapture.knownPath = kp ? { sizeBytes: kp.sizeBytes, startsWithFFD8FF: kp.startsWithFFD8FF, endsWithFFD9: kp.endsWithFFD9, timingsMs: kp.timingsMs } : null;
    out.dcapture.benchmark50 = bm ? { status: s("dcapture.benchmark"), successes: bm.successes, failures: bm.failures, distinctContents: bm.distinctContents, readsPerSecond: bm.readsPerSecond,
      totalMs: bm.timingsMs && bm.timingsMs.total, openMs: bm.timingsMs && bm.timingsMs.open, readMs: bm.timingsMs && bm.timingsMs.read, closeMs: bm.timingsMs && bm.timingsMs.close } : "NOT_RUN";
    out.dcapture.knownPathWatch = dw ? dw.changes : "NOT_RUN";
    out.dcapture.tmpSockets = v("dcapture.tmp_sockets") || "NOT_RUN";
    return out;
  };

  Recon.report = function () {
    var out = { reconVersion: Recon.VERSION, device: { model: "UE49NU7100", firmware: "T-KTM2LDEUC-1360.0", platform: "Tizen 4.0", architecture: "armv7" },
      application: { name: "NU-7100-Recon", version: Recon.VERSION, generated: Recon.stamp() }, apis: {}, filesystem: {}, sharedmem: {}, process: {}, network: {}, ipc: {}, dcapture: {},
      manualProbes: Recon.manualProbes, fingerprint: Recon.fingerprint(), findings: Recon.findings(), tests: [], log: Recon.log };
    var i, r, bucket;
    for (i = 0; i < Recon.order.length; i++) {
      r = Recon.results[Recon.order[i]];
      out.tests.push(r);
      bucket = r.category === "system" ? "device" : r.category === "api" ? "apis" : r.category;
      if (!out[bucket]) out[bucket] = {};
      out[bucket][r.id] = { status: r.status, value: r.value, error: r.error };
    }
    return out;
  };

  g.Recon = Recon;
})(typeof window !== "undefined" ? window : this);
