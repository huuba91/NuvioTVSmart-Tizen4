// IPC bridges, debugging objects and NaCl: presence only.
(function (R) {
  "use strict";
  var win = typeof window !== "undefined" ? window : this;

  R.define("ipc", "ipc.objects", "IPC / bus / bridge objects", function (done) {
    var names = ["bus", "dbus", "gdbus", "webkit", "webkit.messageHandlers", "external", "Android", "native", "bridge", "ipc", "chrome.runtime", "chrome.webstore"], out = {}, any = false;
    names.forEach(function (n) { var r = R.lookup(n); out[n] = r.type; if (r.state === "EXISTS" && /dbus|gdbus|bus|bridge|ipc|native/.test(n)) any = true; });
    var like = [], k;
    try { for (k in win) if (/dbus|bridge|binder|ipc|nacl|samsung|sec[A-Z_]|wrt/i.test(k)) like.push(k); } catch (e) { /* ignore */ }
    out.windowKeysMatching = like.slice(0, 40);
    out.dbusLike = any || like.some(function (n) { return /dbus/i.test(n); });
    done(out.dbusLike || like.length ? "PARTIAL" : "NOT_AVAILABLE", out, out.dbusLike ? null : "no bus/dbus/gdbus/bridge object exposed to the page");
  });

  R.define("ipc", "ipc.debug", "Debugging-related objects", function (done) {
    var out = { "window.chrome": R.lookup("chrome").type, "window.devtools": R.lookup("devtools").type, console: typeof win.console, "console.memory": R.lookup("console.memory").type,
      performance: typeof win.performance, "performance.memory": R.lookup("performance.memory").type, "performance.timing": R.lookup("performance.timing").type };
    done("PASS", out);
  });

  R.define("ipc", "ipc.nacl", "Native Client (NaCl) support", function (done) {
    var n = win.navigator, out = { mimeTypes: [], plugins: [] }, i, found = false;
    try { for (i = 0; n.mimeTypes && i < n.mimeTypes.length; i++) { out.mimeTypes.push(n.mimeTypes[i].type); if (/nacl/i.test(n.mimeTypes[i].type)) found = true; } } catch (e) { out.mimeError = R.errText(e); }
    try { for (i = 0; n.plugins && i < n.plugins.length; i++) out.plugins.push(n.plugins[i].name); } catch (e2) { out.pluginError = R.errText(e2); }
    out.nacl = found;
    done(found ? "PASS" : "NOT_AVAILABLE", out, found ? null : "no application/x-nacl or x-pnacl mime type");
  });
})(Recon);
