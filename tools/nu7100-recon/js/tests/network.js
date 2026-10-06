// Browser networking APIs and a conservative localhost probe: two fixed URLs and one WebSocket attempt, no scanning.
(function (R) {
  "use strict";
  var win = typeof window !== "undefined" ? window : this;

  R.define("network", "network.apis", "Networking API availability", function (done) {
    var out = {}, names = ["WebSocket", "XMLHttpRequest", "fetch", "EventSource", "RTCPeerConnection", "webkitRTCPeerConnection", "navigator.sendBeacon", "navigator.onLine"];
    names.forEach(function (n) { out[n] = R.lookup(n).type; });
    out["navigator.sendBeacon"] = typeof (win.navigator && win.navigator.sendBeacon);
    out["navigator.onLine"] = win.navigator ? win.navigator.onLine : "undefined";
    var req = typeof win.require === "function";
    out["node net"] = req ? R.safe(function () { win.require("net"); return "resolvable"; }) : "NOT_AVAILABLE (no require)";
    out["node dgram"] = req ? R.safe(function () { win.require("dgram"); return "resolvable"; }) : "NOT_AVAILABLE (no require)";
    done("PASS", out);
  });

  function localhost(url, id) {
    R.define("network", "network.localhost." + id, "HTTP GET " + url, function (done) {
      if (typeof win.XMLHttpRequest !== "function") { done("NOT_AVAILABLE", null, "no XMLHttpRequest"); return; }
      var x = new win.XMLHttpRequest(), begun = Date.now(), ended = false;
      function end(status, value, error) { if (ended) return; ended = true; done(status, value, error); }
      try {
        x.open("GET", url, true);
        x.timeout = 4000;
        x.onload = function () {
          var headers = ""; try { headers = x.getAllResponseHeaders(); } catch (e) { headers = "(unreadable)"; }
          end("PASS", { reachable: true, httpStatus: x.status, headers: String(headers).slice(0, 400), responseSize: (x.responseText || "").length, ms: Date.now() - begun });
        };
        x.onerror = function () { end("FAIL", { reachable: false, ms: Date.now() - begun, httpStatus: x.status }, "XHR error: connection refused, unreachable, or blocked by the page's origin policy (the browser does not say which)"); };
        x.ontimeout = function () { end("FAIL", { reachable: false }, "timeout after 4 s"); };
        x.send();
      } catch (e2) { end(R.statusForError(e2), null, e2); }
    });
  }
  localhost("http://127.0.0.1/", "127.0.0.1");
  localhost("http://localhost/", "localhost");

  R.define("network", "network.websocket", "WebSocket ws://127.0.0.1/", function (done) {
    if (typeof win.WebSocket !== "function") { done("NOT_AVAILABLE", null, "no WebSocket"); return; }
    var ws, ended = false, timer;
    function end(status, value, error) { if (ended) return; ended = true; clearTimeout(timer); try { ws.close(); } catch (e) { /* ignore */ } done(status, value, error); }
    try {
      ws = new win.WebSocket("ws://127.0.0.1/");
      ws.onopen = function () { end("PASS", { opened: true, protocol: ws.protocol }); };
      ws.onerror = function () { end("FAIL", { opened: false, readyState: ws.readyState }, "WebSocket error event (nothing listening on port 80, or blocked)"); };
      ws.onclose = function (e) { end("FAIL", { opened: false, closeCode: e.code }, "closed before opening, code " + e.code); };
      timer = setTimeout(function () { end("FAIL", { opened: false }, "no open/error within 3 s"); }, 3000);
    } catch (e2) { end(R.statusForError(e2), { constructed: false }, e2); }
  });
})(Recon);
