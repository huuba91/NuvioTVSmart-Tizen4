// Device, browser, Tizen/Samsung info, API existence, memory.
(function (R) {
  "use strict";
  var win = typeof window !== "undefined" ? window : this;

  R.define("system", "system.browser", "Browser properties", function (done) {
    var n = win.navigator || {}, s = win.screen || {}, perf = win.performance;
    done("PASS", { userAgent: n.userAgent, platform: n.platform, language: n.language, languages: n.languages ? Array.prototype.slice.call(n.languages) : null,
      screenWidth: s.width, screenHeight: s.height, availWidth: s.availWidth, availHeight: s.availHeight, devicePixelRatio: win.devicePixelRatio,
      innerWidth: win.innerWidth, innerHeight: win.innerHeight, cookieEnabled: n.cookieEnabled, hardwareConcurrency: n.hardwareConcurrency,
      timezoneOffsetMin: new Date().getTimezoneOffset(), hasPerformanceNow: !!(perf && perf.now) });
  });

  var PROPS = ["BUILD", "CPU", "DISPLAY", "MEMORY", "NETWORK", "STORAGE", "LOCALE", "WIFI_NETWORK", "ETHERNET_NETWORK", "CELLULAR_NETWORK", "DEVICE_ORIENTATION"];
  PROPS.forEach(function (prop) {
    R.define("system", "system.tizen." + prop, "tizen.systeminfo " + prop, function (done) {
      if (!win.tizen || !win.tizen.systeminfo) { done("NOT_AVAILABLE", null, "tizen.systeminfo undefined"); return; }
      try {
        win.tizen.systeminfo.getPropertyValue(prop, function (value) { done("PASS", value); },
          function (e) { done(R.statusForError(e), null, e); });
      } catch (e) { done(/NotSupported|not supported|Type/i.test(R.errText(e)) ? "NOT_AVAILABLE" : R.statusForError(e), null, e); }
    });
  });

  R.define("system", "system.tizen.capabilities", "tizen.systeminfo capabilities", function (done) {
    var si = win.tizen && win.tizen.systeminfo;
    if (!si || typeof si.getCapabilities !== "function") { done("NOT_AVAILABLE", null, "getCapabilities missing"); return; }
    var caps = si.getCapabilities(), keep = {}, k, count = 0;
    for (k in caps) { count++; if (/platform|webApi|nativeApi|screen|opengles|speech|input|network|wifi|bluetooth|fmradio|camera|sip|mediacodec|usb|tv/i.test(k)) keep[k] = caps[k]; }
    keep.count = count;
    done("PASS", keep);
  });

  function callGetters(obj, names) {
    var out = {}, i, name;
    for (i = 0; i < names.length; i++) {
      name = names[i];
      if (typeof obj[name] !== "function") continue;
      try { out[name] = obj[name](); } catch (e) { out[name] = "(error: " + R.errText(e) + ")"; }
    }
    return out;
  }
  R.define("system", "system.samsung.productinfo", "webapis.productinfo", function (done) {
    var p = win.webapis && win.webapis.productinfo;
    if (!p) { done("NOT_AVAILABLE", null, "webapis.productinfo undefined"); return; }
    var out = callGetters(p, ["getModel", "getRealModel", "getModelCode", "getFirmware", "getVersion", "getSmartTVServerType", "getSmartTVServerVersion", "isUdPanelSupported", "is8KPanelSupported"]);
    done(Object.keys(out).length ? "PASS" : "PARTIAL", out);
  });
  R.define("system", "system.samsung.network", "webapis.network", function (done) {
    var n = win.webapis && win.webapis.network;
    if (!n) { done("NOT_AVAILABLE", null, "webapis.network undefined"); return; }
    var out = callGetters(n, ["getActiveConnectionType", "getIp", "getGateway", "getDns", "getSubnetMask", "isConnectedToGateway"]);
    done(Object.keys(out).length ? "PASS" : "PARTIAL", out);
  });

  R.define("system", "system.app.info", "Current application / package", function (done) {
    var t = win.tizen, out = {};
    if (!t || !t.application) { done("NOT_AVAILABLE", null, "tizen.application undefined"); return; }
    try {
      var app = t.application.getCurrentApplication(), info = app.appInfo;
      out.contextId = app.contextId;
      out.appInfo = { id: info.id, name: info.name, packageId: info.packageId, version: info.version, installDate: String(info.installDate), show: info.show };
    } catch (e) { out.appInfoError = R.errText(e); }
    try {
      if (t.package && out.appInfo) { var pk = t.package.getPackageInfo(out.appInfo.packageId); out.packageInfo = { id: pk.id, name: pk.name, version: pk.version, totalSize: pk.totalSize, dataSize: pk.dataSize, appIds: pk.appIds }; }
      else out.packageInfo = "tizen.package undefined";
    } catch (e2) { out.packageInfoError = R.errText(e2); }
    done(out.appInfo ? (out.packageInfoError ? "PARTIAL" : "PASS") : "FAIL", out, out.appInfoError || null);
  });

  var API_NAMES = ["tizen", "webapis", "webapis.avplay", "webapis.productinfo", "webapis.systeminfo", "webapis.network", "webapis.tvinfo", "webapis.appcommon", "webapis.sso", "webapis.filesystem",
    "window.tizen", "window.webapis", "window.require", "window.process", "window.Buffer", "window.module", "window.exports", "window.NodeJS", "tizen.application", "tizen.filesystem", "tizen.systeminfo",
    "tizen.package", "tizen.tvinputdevice", "tizen.ApplicationControl"];
  R.define("api", "api.scan", "Web API availability scan", function (done) {
    var map = {}, i, name, found = 0, errors = 0, r;
    for (i = 0; i < API_NAMES.length; i++) {
      name = API_NAMES[i].replace(/^window\./, "");
      r = R.lookup(name);
      map[API_NAMES[i]] = r.state + (r.state === "EXISTS" ? " (" + r.type + ")" : "");
      if (r.state === "EXISTS") found++; else if (r.state === "ERROR") errors++;
    }
    done(errors ? "PARTIAL" : "PASS", map, found + " of " + API_NAMES.length + " exist");
  });
  R.define("api", "api.keys", "Exposed tizen / webapis members and private-looking globals", function (done) {
    var out = { tizen: R.keysOf(win.tizen), webapis: R.keysOf(win.webapis), privateLooking: [] }, k, count = 0;
    try { for (k in win) { count++; if (/samsung|tizen|webapi|wrt|dbus|native|bridge|nacl|pepper|ipc|binder|sec_|efl|ewk/i.test(k) && out.privateLooking.length < 80) out.privateLooking.push(k); } } catch (e) { out.error = R.errText(e); }
    out.windowKeyCount = count;
    done(out.tizen.length || out.webapis.length ? "PASS" : "NOT_AVAILABLE", out);
  });

  R.define("system", "system.memory", "Memory (deviceMemory, performance.memory, 16 MB allocation)", function (done) {
    var n = win.navigator, pm = win.performance && win.performance.memory, out = { deviceMemory: n && n.deviceMemory !== undefined ? n.deviceMemory : null };
    out.performanceMemory = pm ? { jsHeapSizeLimit: pm.jsHeapSizeLimit, totalJSHeapSize: pm.totalJSHeapSize, usedJSHeapSize: pm.usedJSHeapSize } : null;
    try {
      var begun = Date.now(), buffer = new ArrayBuffer(16 * 1024 * 1024), view = new Uint8Array(buffer);
      view[0] = 1; view[view.length - 1] = 1;
      out.alloc16MbMs = Date.now() - begun;
      buffer = null; view = null;
    } catch (e) { out.allocError = R.errText(e); }
    done(out.deviceMemory !== null || out.performanceMemory ? "PASS" : (out.allocError ? "FAIL" : "NOT_AVAILABLE"), out, out.deviceMemory === null && !pm ? "neither navigator.deviceMemory nor performance.memory exist" : null);
  });
})(Recon);
