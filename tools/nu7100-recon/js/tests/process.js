// Is anything Node-like or process-related exposed to the page? Availability probes only; nothing is executed.
(function (R) {
  "use strict";
  var win = typeof window !== "undefined" ? window : this;

  R.define("process", "process.node_globals", "Node-like globals", function (done) {
    var names = ["process", "require", "module", "exports", "Buffer", "NodeJS", "global", "child_process", "exec", "spawn", "fork", "system", "shell"], out = {}, i, any = false;
    for (i = 0; i < names.length; i++) { out[names[i]] = R.lookup(names[i]).type; if (out[names[i]] !== "undefined" && /^(process|require|module|exports|Buffer|global|NodeJS)$/.test(names[i])) any = true; }
    out.nodeLike = any;
    out.childProcessResolvable = false; // set by process.modules
    done(any ? "PASS" : "NOT_AVAILABLE", out, any ? null : "none of process / require / Buffer / module exist in the page");
  });

  R.define("process", "process.node_info", "process.* values", function (done) {
    var p;
    try { p = win.process; } catch (e) { p = undefined; }
    if (!p || typeof p !== "object") { done("NOT_AVAILABLE", null, "window.process undefined"); return; }
    var out = {};
    ["version", "platform", "arch", "execPath", "pid"].forEach(function (k) { out[k] = R.safe(function () { return p[k]; }); });
    out.cwd = R.safe(function () { return typeof p.cwd === "function" ? p.cwd() : undefined; });
    done("PASS", out);
  });

  R.define("process", "process.modules", "require() of fs, path, os, net, child_process, dgram, http, https, crypto", function (done) {
    var req;
    try { req = win.require; } catch (e) { req = undefined; }
    if (typeof req !== "function") { done("NOT_AVAILABLE", null, "window.require is " + typeof req); return; }
    var out = {}, ok = 0, mods = ["fs", "path", "os", "net", "child_process", "dgram", "http", "https", "crypto"];
    mods.forEach(function (m) {
      try { var loaded = req(m); out[m] = loaded ? "resolvable" : "empty"; ok++; } catch (e2) { out[m] = "error: " + R.errText(e2); }
    });
    var g = R.results["process.node_globals"];
    if (g && g.value) g.value.childProcessResolvable = out.child_process === "resolvable";
    done(ok === mods.length ? "PASS" : (ok ? "PARTIAL" : "BLOCKED"), out);
  });

  R.define("process", "process.app_contexts", "tizen.application contexts / apps (documented API)", function (done) {
    var app = win.tizen && win.tizen.application, out = { apiMembers: R.keysOf(app, 60) };
    if (!app) { done("NOT_AVAILABLE", null, "tizen.application undefined"); return; }
    var pending = 2, failed = 0;
    function part() { if (--pending === 0) done(failed === 2 ? "BLOCKED" : (failed ? "PARTIAL" : "PASS"), out); }
    try {
      app.getAppsContext(function (list) {
        out.runningContexts = list.length;
        out.contextSample = list.slice(0, 6).map(function (c) { return { id: c.id, appId: c.appId, keys: R.keysOf(c, 12) }; });
        part();
      }, function (e) { out.contextsError = R.errText(e); failed++; part(); });
    } catch (e) { out.contextsError = R.errText(e); failed++; part(); }
    try {
      app.getAppsInfo(function (list) {
        out.installedApps = list.length;
        out.appSample = list.slice(0, 8).map(function (a) { return a.id + " (" + a.name + ")"; });
        part();
      }, function (e2) { out.appsInfoError = R.errText(e2); failed++; part(); });
    } catch (e3) { out.appsInfoError = R.errText(e3); failed++; part(); }
  });

  // Is there any legitimate application <-> PID mapping exposed? Looks at names only.
  R.define("process", "process.pid_api", "PID-related API exposure", function (done) {
    var hits = [], roots = { tizen: win.tizen, webapis: win.webapis }, name, k, sub, k2;
    for (name in roots) {
      if (!roots[name]) continue;
      for (k in roots[name]) {
        if (/pid/i.test(k)) hits.push(name + "." + k);
        try { sub = roots[name][k]; } catch (e) { continue; }
        if (sub && typeof sub === "object") for (k2 in sub) if (/pid/i.test(k2)) hits.push(name + "." + k + "." + k2);
      }
    }
    var ctx = R.value("process.app_contexts"), example = null;
    if (ctx && ctx.contextSample && ctx.contextSample[0]) { example = ctx.contextSample[0]; ctx.contextSample.forEach(function (c) { c.keys.forEach(function (key) { if (/pid/i.test(key)) hits.push("context." + key); }); }); }
    var processPid = R.safe(function () { return win.process && win.process.pid; }, undefined);
    var out = { pidApi: hits.length > 0 || typeof processPid === "number", names: hits, appToPidAccessible: hits.some(function (h) { return /context/.test(h); }), contextExample: example, processPid: processPid === undefined ? null : processPid };
    done(out.pidApi ? "PASS" : "NOT_AVAILABLE", out, out.pidApi ? null : "no member containing 'pid' in tizen.*, webapis.* (2 levels) or application contexts");
  });
})(Recon);
