/*
 * HTML colour probe for Samsung Tizen 4 (UE49NU7100, Chromium 56).
 *
 * Question it answers: if Nuvio played through an HTML <video> element instead of AVPlay, could the
 * page itself read the picture colours (canvas / WebGL / ImageBitmap) fast enough to drive the
 * ambilight strip? The existing service-side capture (dcapture + gdbus) needs a signed
 * filesystem/system build; page-side readback would not.
 *
 * Every test plays media/pattern.mp4, a clip whose left 20% / centre 60% / right 20% rotate through
 * red, green and blue every 2 s, and checks that what the page reads back matches the expected colour
 * at the expected time. "blank" = the TV composited the video on a hardware plane the page cannot
 * read (all zero pixels). Plain ES5/ES2015 only; Chromium 56 has no optional chaining or padStart.
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";
  var CFG = window.PROBE_CONFIG || {};
  var SW = 64;
  var SH = 36;
  var TEST_MS = 8000;
  var SAMPLE_MS = 100;
  var MIME_FRAG = 'video/mp4; codecs="avc1.4d4028"';
  var SETS = ["RGB", "GBR", "BRG"];

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function withTimeout(p, ms, msg) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(msg + " (>" + ms + " ms)")); }, ms);
      p.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }
  function hex(c) {
    function h(v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? "0" : "") + v.toString(16); }
    return "#" + h(c[0]) + h(c[1]) + h(c[2]);
  }

  // ---------------------------------------------------------------- logging
  var logLines = [];
  function log(msg) {
    var line = new Date().toISOString().substr(11, 8) + " " + msg;
    try { console.log("[probe] " + msg); } catch (e) { /* ignore */ }
    logLines.push(line);
    if (logLines.length > 12) logLines.shift();
    $("log").textContent = logLines.join("\n");
  }

  // ---------------------------------------------------------------- environment
  function tryCall(fn) { try { return fn(); } catch (e) { return undefined; } }

  function gatherEnv() {
    var ua = navigator.userAgent;
    var tz = /Tizen[ \/]([\d.]+)/.exec(ua);
    var ch = /Chrome\/([\d.]+)/.exec(ua);
    var env = {
      ua: ua,
      tizen: tz ? tz[1] : null,
      chromium: ch ? ch[1] : null,
      screen: screen.width + "x" + screen.height + " @" + (window.devicePixelRatio || 1),
      model: tryCall(function () { return webapis.productinfo.getRealModel(); }),
      firmware: tryCall(function () { return webapis.productinfo.getFirmware(); }),
      avplay: typeof window.webapis !== "undefined" && !!window.webapis.avplay,
      features: {
        mediaSource: typeof window.MediaSource !== "undefined",
        createImageBitmap: typeof window.createImageBitmap === "function",
        captureStream: typeof HTMLVideoElement !== "undefined" && "captureStream" in HTMLVideoElement.prototype,
        videoFrameCallback: typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype,
        offscreenCanvas: typeof window.OffscreenCanvas !== "undefined",
        playbackQuality: typeof HTMLVideoElement !== "undefined" && "getVideoPlaybackQuality" in HTMLVideoElement.prototype,
        worker: typeof window.Worker !== "undefined"
      },
      webgl: null,
      codecs: {}
    };
    try {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (gl) {
        var ext = gl.getExtension("WEBGL_debug_renderer_info");
        env.webgl = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      }
    } catch (e) { env.webgl = "error: " + e.message; }
    var v = document.createElement("video");
    var types = {
      "h264": 'video/mp4; codecs="avc1.640028"',
      "hevc": 'video/mp4; codecs="hvc1.1.6.L120.B0"',
      "hevc10": 'video/mp4; codecs="hvc1.2.4.L120.B0"',
      "vp9": 'video/webm; codecs="vp9"',
      "av1": 'video/mp4; codecs="av01.0.05M.08"',
      "aac": 'audio/mp4; codecs="mp4a.40.2"',
      "ac3": 'audio/mp4; codecs="ac-3"',
      "eac3": 'audio/mp4; codecs="ec-3"',
      "hls": "application/vnd.apple.mpegurl"
    };
    Object.keys(types).forEach(function (k) {
      var cp = v.canPlayType(types[k]) || "no";
      var ms = (window.MediaSource && MediaSource.isTypeSupported) ? (MediaSource.isTypeSupported(types[k]) ? "mse" : "") : "";
      env.codecs[k] = cp + (ms ? "+" + ms : "");
    });
    return env;
  }

  function renderEnv(env) {
    var f = env.features;
    var lines = [
      "Tizen " + env.tizen + " · Chromium " + env.chromium + " · " + env.screen + " · model " + (env.model || "?") + " fw " + (env.firmware || "?"),
      "webgl: " + env.webgl + " · avplay: " + env.avplay,
      "MSE " + f.mediaSource + " · ImageBitmap " + f.createImageBitmap + " · captureStream " + f.captureStream +
        " · rVFC " + f.videoFrameCallback + " · OffscreenCanvas " + f.offscreenCanvas + " · Worker " + f.worker,
      "codecs: " + Object.keys(env.codecs).map(function (k) { return k + "=" + env.codecs[k]; }).join("  ")
    ];
    $("env").textContent = lines.join("\n");
  }

  // ---------------------------------------------------------------- pixel analysis
  function zones(d) {
    // Left 10 columns, right 10 columns, centre columns 18-45; all rows. Pattern edges sit at x=12.8/51.2.
    var acc = { L: [0, 0, 0, 0], C: [0, 0, 0, 0], R: [0, 0, 0, 0] };
    var nonzero = 0;
    for (var y = 0; y < SH; y++) {
      for (var x = 0; x < SW; x++) {
        var i = (y * SW + x) * 4;
        var r = d[i], g = d[i + 1], b = d[i + 2];
        if (r | g | b) nonzero++;
        var z = x < 10 ? acc.L : (x >= 54 ? acc.R : ((x >= 18 && x < 46) ? acc.C : null));
        if (z) { z[0] += r; z[1] += g; z[2] += b; z[3]++; }
      }
    }
    function avg(z) { return [z[0] / z[3], z[1] / z[3], z[2] / z[3]]; }
    return { L: avg(acc.L), C: avg(acc.C), R: avg(acc.R), nonzero: nonzero };
  }

  function cls(c) {
    var m = Math.max(c[0], c[1], c[2]);
    if (m < 40) return "K";
    var s = [c[0], c[1], c[2]].sort(function (a, b) { return b - a; });
    if (s[0] - s[1] < 60) return m > 200 ? "W" : "?";
    return c[0] === m ? "R" : (c[1] === m ? "G" : "B");
  }

  function sigOf(z) {
    function q(c) { return Math.round(c[0] / 24) + "." + Math.round(c[1] / 24) + "." + Math.round(c[2] / 24); }
    return q(z.L) + "|" + q(z.C) + "|" + q(z.R);
  }

  // ---------------------------------------------------------------- grabbers (each returns Promise<RGBA array>)
  function makeGrabber(method, video) {
    var c = document.createElement("canvas");
    c.width = SW; c.height = SH;
    if (method === "canvas2d") {
      var ctx = c.getContext("2d");
      return { grab: function () { ctx.drawImage(video, 0, 0, SW, SH); return Promise.resolve(ctx.getImageData(0, 0, SW, SH).data); }, close: function () {} };
    }
    if (method === "bitmap") {
      if (typeof createImageBitmap !== "function") throw new Error("createImageBitmap unsupported");
      var bctx = c.getContext("2d");
      return {
        grab: function () {
          return createImageBitmap(video).then(function (bmp) {
            bctx.drawImage(bmp, 0, 0, SW, SH);
            if (bmp.close) bmp.close();
            return bctx.getImageData(0, 0, SW, SH).data;
          });
        },
        close: function () {}
      };
    }
    if (method === "webgl") {
      var gl = c.getContext("webgl", { preserveDrawingBuffer: true, antialias: false, alpha: false });
      if (!gl) throw new Error("webgl unavailable");
      var sh = function (type, src) {
        var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s));
        return s;
      };
      var p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, "attribute vec2 p;varying vec2 u;void main(){u=p*.5+.5;gl_Position=vec4(p,0.,1.);}"));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, "precision mediump float;uniform sampler2D t;varying vec2 u;void main(){gl_FragColor=texture2D(t,u);}"));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
      gl.useProgram(p);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(p, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.viewport(0, 0, SW, SH);
      var out = new Uint8Array(SW * SH * 4);
      return {
        grab: function () {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          var e = gl.getError();
          if (e) throw new Error("texImage2D GL error 0x" + e.toString(16));
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.readPixels(0, 0, SW, SH, gl.RGBA, gl.UNSIGNED_BYTE, out);
          return Promise.resolve(out);
        },
        close: function () { try { gl.deleteTexture(tex); } catch (e) { /* ignore */ } }
      };
    }
    throw new Error("unknown method " + method);
  }

  // ---------------------------------------------------------------- sources
  function xhrGet(url, type) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open("GET", url, true);
      x.responseType = type;
      x.timeout = 20000;
      x.ontimeout = function () { reject(new Error("XHR timeout for " + url)); };
      x.onload = function () { (x.status === 200 || x.status === 0) && x.response ? resolve(x.response) : reject(new Error("HTTP " + x.status + " for " + url)); };
      x.onerror = function () { reject(new Error("XHR failed for " + url)); };
      x.send();
    });
  }

  function remoteUrl() { return CFG.REMOTE_URL || CFG.PUBLIC_SAMPLE_URL; }
  function remoteIsPattern() { return !!(CFG.REMOTE_URL && CFG.REMOTE_IS_PATTERN); }

  // Returns Promise<{isPattern, cleanup}> after attaching media to `video`.
  function attachSource(source, video) {
    if (source === "packaged") {
      video.src = "media/pattern.mp4";
      return Promise.resolve({ isPattern: true, cleanup: function () {} });
    }
    if (source === "blob") {
      return xhrGet("media/pattern.mp4", "blob").then(function (blob) {
        var url = URL.createObjectURL(blob);
        video.src = url;
        return { isPattern: true, cleanup: function () { URL.revokeObjectURL(url); } };
      });
    }
    if (source === "mse") {
      if (!window.MediaSource) return Promise.reject(new Error("MediaSource unsupported"));
      if (!MediaSource.isTypeSupported(MIME_FRAG)) return Promise.reject(new Error("MSE rejects " + MIME_FRAG));
      return xhrGet("media/pattern-frag.mp4", "arraybuffer").then(function (buf) {
        return new Promise(function (resolve, reject) {
          var ms = new MediaSource();
          var url = URL.createObjectURL(ms);
          ms.addEventListener("sourceopen", function () {
            try {
              var sb = ms.addSourceBuffer(MIME_FRAG);
              sb.addEventListener("updateend", function () { try { if (ms.readyState === "open") ms.endOfStream(); } catch (e) { /* ignore */ } });
              sb.appendBuffer(buf);
              resolve({ isPattern: true, cleanup: function () { URL.revokeObjectURL(url); } });
            } catch (e) { reject(e); }
          });
          video.src = url;
        });
      });
    }
    if (source === "remote") {
      video.crossOrigin = "anonymous";
      video.src = remoteUrl();
      return Promise.resolve({ isPattern: remoteIsPattern(), cleanup: function () {} });
    }
    return Promise.reject(new Error("unknown source " + source));
  }

  function createVideo(display) {
    var stage = $("stage");
    stage.className = display === "full" ? "full" : (display === "hint" ? "hint" : "");
    stage.innerHTML = "";
    var v = document.createElement("video");
    v.muted = true;
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    v.preload = "auto";
    v.loop = false;
    stage.appendChild(v);
    return v;
  }

  function releaseVideo(v) {
    try { v.pause(); } catch (e) { /* ignore */ }
    try { v.removeAttribute("src"); v.load(); } catch (e) { /* ignore */ }
    if (v.parentNode) v.parentNode.removeChild(v);
  }

  function waitPlaying(v, ms) {
    var t0 = now();
    return new Promise(function (resolve, reject) {
      (function poll() {
        if (v.error) return reject(new Error("media error " + v.error.code + (v.error.message ? " " + v.error.message : "")));
        if (!v.paused && v.currentTime > 0.3 && v.readyState >= 3) return resolve(Math.round(now() - t0));
        if (now() - t0 > ms) return reject(new Error("no playback after " + ms + " ms (readyState " + v.readyState + ", networkState " + v.networkState + ", paused " + v.paused + ", t=" + v.currentTime.toFixed(2) + ")"));
        setTimeout(poll, 100);
      })();
    });
  }

  // ---------------------------------------------------------------- one test
  function expectedMatch(t, z) {
    var d = t - 2 * Math.floor(t / 2);
    if (d < 0.6 || d > 1.9) return null; // too close to a colour change to judge
    var set = SETS[Math.floor(t / 2) % 3];
    return cls(z.L) === set.charAt(0) && cls(z.C) === set.charAt(1) && cls(z.R) === set.charAt(2);
  }

  function runTest(t) {
    var res = { id: t.id, name: t.name, status: "run", detail: "", match: "", msGrab: null, samples: 0 };
    var video = createVideo(t.display);
    var cleanup = function () {};
    var grabber = null;
    var sigs = {};
    var n = 0, blank = 0, checked = 0, matched = 0, lastColours = null;

    function finish(status, detail) {
      res.status = status;
      res.detail = detail || res.detail;
      try { if (grabber) grabber.close(); } catch (e) { /* ignore */ }
      cleanup();
      releaseVideo(video);
      return sleep(400).then(function () { return res; });
    }

    var skipReason = null;
    if (t.source === "mse" && !window.MediaSource) skipReason = "MediaSource unsupported";
    if (t.source === "remote" && !remoteUrl()) skipReason = "no remote URL configured";
    if (skipReason) { releaseVideo(video); res.status = "skip"; res.detail = skipReason; return Promise.resolve(res); }

    return attachSource(t.source, video).then(function (src) {
      cleanup = src.cleanup;
      res.isPattern = src.isPattern;
      try { var pp = video.play && video.play(); if (pp && pp.catch) pp.catch(function () { /* AbortError on cleanup is expected */ }); } catch (e) { /* ignore */ }
      return waitPlaying(video, 15000);
    }).then(function (startMs) {
      res.startMs = startMs;
      res.size = video.videoWidth + "x" + video.videoHeight;
      log("  " + t.id + ": playing after " + startMs + " ms, " + res.size + ", reading pixels…");
      grabber = makeGrabber(t.method, video);
      var t0 = now();
      var failed = null;
      function step() {
        if (failed || now() - t0 > TEST_MS || video.ended) return Promise.resolve();
        var vt = video.currentTime;
        var g0 = now();
        var p;
        try { p = withTimeout(grabber.grab(), 4000, "grab() never returned"); } catch (e) { failed = e; return Promise.resolve(); }
        return p.then(function (data) {
          if (n === 0) log("  " + t.id + ": first grab ok (" + Math.round(now() - g0) + " ms)");
          var z = zones(data);
          n++;
          lastColours = z;
          if (z.nonzero === 0) blank++;
          sigs[sigOf(z)] = 1;
          if (res.isPattern) {
            var m = expectedMatch(vt, z);
            if (m !== null) { checked++; if (m) matched++; }
          }
          return sleep(Math.max(0, SAMPLE_MS - (now() - g0))).then(step);
        }, function (e) { failed = e; });
      }
      return step().then(function () {
        if (failed) throw failed;
        // Grab cost against live video: 30 grabs 40 ms apart (a new frame each time), timing only the grab.
        var spent = 0, k = 0;
        function bench() {
          if (k >= 30) return Promise.resolve();
          k++;
          var b0 = now();
          return withTimeout(grabber.grab(), 4000, "grab() never returned").then(function () { spent += now() - b0; return sleep(40); }).then(bench);
        }
        return bench().then(function () { res.msGrab = Math.round(spent / 30 * 10) / 10; });
      });
    }).then(function () {
      res.samples = n;
      var q = tryCall(function () { return video.getVideoPlaybackQuality(); });
      var dist = Object.keys(sigs).length;
      var ratio = checked ? matched / checked : null;
      res.match = res.isPattern ? (checked ? matched + "/" + checked : "n/a") : "generic";
      res.colours = lastColours ? { L: hex(lastColours.L), C: hex(lastColours.C), R: hex(lastColours.R) } : null;
      var extra = "start " + res.startMs + " ms, " + res.size + ", " + dist + " distinct frames" +
        (q ? ", dropped " + q.droppedVideoFrames + "/" + q.totalVideoFrames : "") +
        (res.colours ? ", last L/C/R " + res.colours.L + " " + res.colours.C + " " + res.colours.R : "");
      if (n === 0) return finish("error", "no samples");
      if (blank / n >= 0.9) return finish("blank", "all pixels 0 (hardware video plane?) · " + extra);
      if (res.isPattern) {
        if (checked >= 10 && ratio >= 0.9) return finish("pass", extra);
        if (dist <= 1) return finish("frozen", "readback never changes · " + extra);
        return finish("wrong", "colours do not follow the video · " + extra);
      }
      return dist >= 2 ? finish("pass", extra) : finish("frozen", "non-black but never changes (static clip?) · " + extra);
    }).catch(function (e) {
      var msg = (e && (e.name ? e.name + ": " : "") + e.message) || String(e);
      var tainted = /SecurityError|tainted|insecure|cross-origin/i.test(msg);
      log("  " + t.id + " -> " + msg);
      return finish(tainted ? "tainted" : "error", msg);
    });
  }

  var TESTS = [
    { id: "c2d-packaged", name: "canvas 2D · packaged file", method: "canvas2d", source: "packaged" },
    { id: "c2d-blob", name: "canvas 2D · blob URL", method: "canvas2d", source: "blob" },
    { id: "c2d-mse", name: "canvas 2D · MSE (hls.js / dash.js path)", method: "canvas2d", source: "mse" },
    { id: "c2d-remote", name: "canvas 2D · remote CORS URL", method: "canvas2d", source: "remote" },
    { id: "gl-blob", name: "WebGL texImage2D · blob URL", method: "webgl", source: "blob" },
    { id: "gl-mse", name: "WebGL texImage2D · MSE", method: "webgl", source: "mse" },
    { id: "bmp-blob", name: "createImageBitmap · blob URL", method: "bitmap", source: "blob" },
    { id: "c2d-blob-full", name: "canvas 2D · blob · 1080p fullscreen", method: "canvas2d", source: "blob", display: "full" },
    { id: "c2d-blob-hint", name: "canvas 2D · blob · compositing hints", method: "canvas2d", source: "blob", display: "hint" }
  ];

  // ---------------------------------------------------------------- UI
  var results = [];
  var env = null;
  var busy = false;
  var mode = "report"; // "report" | "live"

  function renderRows() {
    var tb = document.querySelector("#results tbody");
    tb.innerHTML = "";
    TESTS.forEach(function (t, i) {
      var r = null;
      for (var k = 0; k < results.length; k++) if (results[k].id === t.id) r = results[k];
      var tr = document.createElement("tr");
      var st = r ? r.status : "wait";
      tr.innerHTML = "<td>" + (i + 1) + "</td><td></td><td><span class=\"st " + st + "\">" + st.toUpperCase() + "</span></td><td></td><td></td><td class=\"d\"></td>";
      tr.cells[1].textContent = t.name;
      tr.cells[3].textContent = r ? r.match : "";
      tr.cells[4].textContent = r && r.msGrab !== null ? r.msGrab : "";
      tr.cells[5].textContent = r ? r.detail : "";
      tb.appendChild(tr);
    });
  }

  function setVerdict(cls, text) { var v = $("verdict"); v.className = cls; v.textContent = text; }

  function computeVerdict() {
    var pass = results.filter(function (r) { return r.status === "pass" && r.isPattern; });
    var real = results.filter(function (r) { return r.isPattern && r.status !== "skip"; });
    if (pass.length) {
      var best = pass.slice().sort(function (a, b) { return a.msGrab - b.msGrab; })[0];
      var hz = best.msGrab > 0 ? Math.min(100, Math.round(1000 / best.msGrab)) : 100;
      var fullOk = results.some(function (r) { return r.id === "c2d-blob-full" && r.status === "pass"; });
      setVerdict("ok", "READBACK WORKS: " + pass.length + "/" + real.length + " pattern tests pass. Fastest: " + best.name +
        " at " + best.msGrab + " ms/grab (~" + hz + " Hz)" + (fullOk ? "" : " — NOT proven at 1080p fullscreen!") +
        " → HTML playback + page-side ambilight looks viable.");
      return "pass";
    }
    var allBlank = real.length && real.every(function (r) { return r.status === "blank" || r.status === "error" || r.status === "tainted"; }) &&
      real.some(function (r) { return r.status === "blank"; });
    if (allBlank) {
      setVerdict("bad", "BLANK FRAMES: video plays but the page reads only black. The TV draws HTML video on a hardware plane, so " +
        "page-side colour readback does not work here → keep the dcapture service path.");
      return "blank";
    }
    var tainted = real.some(function (r) { return r.status === "tainted"; });
    setVerdict("mid", tainted ? "TAINTED CANVAS: readback is blocked by origin rules; see rows marked TAINTED/ERROR." : "NO TEST PASSED: see the rows above.");
    return "fail";
  }

  function buildReport() {
    return {
      probe: VERSION,
      at: new Date().toISOString(),
      env: env,
      results: results.map(function (r) {
        return { id: r.id, name: r.name, status: r.status, match: r.match, msGrab: r.msGrab, startMs: r.startMs, size: r.size, colours: r.colours, detail: r.detail };
      })
    };
  }

  function sendReport() {
    var rep = buildReport();
    var json = JSON.stringify(rep);
    try { localStorage.setItem("probe.lastReport", json); } catch (e) { /* ignore */ }
    try { console.log("PROBE_RESULT " + json); } catch (e) { /* ignore */ }
    if (!CFG.REPORT_URL) { log("report saved locally + console (no REPORT_URL configured)"); return Promise.resolve(false); }
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest();
      x.open("POST", CFG.REPORT_URL.replace(/\/$/, "") + "/report", true);
      x.setRequestHeader("Content-Type", "application/json");
      x.onload = function () { log("report sent: HTTP " + x.status); resolve(x.status === 200); };
      x.onerror = function () { log("report FAILED (is report-server.mjs running and reachable?)"); resolve(false); };
      x.timeout = 8000;
      x.ontimeout = x.onerror;
      x.send(json);
    });
  }

  function runAll() {
    if (busy) return Promise.resolve();
    busy = true;
    results = [];
    renderRows();
    setVerdict("", "running " + TESTS.length + " tests (~" + Math.round(TESTS.length * (TEST_MS + 6000) / 1000) + " s)…");
    var chain = Promise.resolve();
    TESTS.forEach(function (t, i) {
      chain = chain.then(function () {
        log("test " + (i + 1) + "/" + TESTS.length + ": " + t.name);
        results.push({ id: t.id, name: t.name, status: "run", detail: "", match: "" });
        renderRows();
        var wd;
        var watchdog = new Promise(function (resolve) {
          wd = setTimeout(function () {
            log("  " + t.id + " WATCHDOG: no result after 45 s, moving on");
            resolve({ id: t.id, name: t.name, status: "error", detail: "test hung for 45 s (watchdog)", match: "", msGrab: null });
          }, 45000);
        });
        return Promise.race([runTest(t), watchdog]).catch(function (e) {
          return { id: t.id, name: t.name, status: "error", detail: "uncaught: " + (e && e.message), match: "", msGrab: null };
        }).then(function (r) {
          clearTimeout(wd);
          try { var st = $("stage"); st.innerHTML = ""; st.className = ""; } catch (e) { /* ignore */ }
          results[results.length - 1] = r;
          renderRows();
          log("  " + t.id + " = " + r.status + (r.msGrab !== null ? " (" + r.msGrab + " ms/grab)" : ""));
        });
      });
    });
    return chain.then(function () {
      $("stage").innerHTML = "";
      $("stage").className = "";
      computeVerdict();
      busy = false;
      return sendReport();
    }).catch(function (e) {
      busy = false;
      log("run aborted: " + e.message);
    });
  }

  // ---------------------------------------------------------------- live ambilight preview
  var live = { on: false, video: null, grabber: null, cleanup: null, source: "pattern", token: 0, method: "canvas2d" };

  function bestMethod() {
    var pass = results.filter(function (r) { return r.status === "pass" && r.msGrab !== null; })
      .sort(function (a, b) { return a.msGrab - b.msGrab; });
    if (!pass.length) return { method: "canvas2d", source: "blob" };
    var t = TESTS.filter(function (x) { return x.id === pass[0].id; })[0];
    return { method: t.method, source: t.source === "remote" ? "blob" : t.source };
  }

  function stopLive() {
    live.on = false;
    live.token++;
    if (live.grabber) { try { live.grabber.close(); } catch (e) { /* ignore */ } }
    if (live.video) releaseVideo(live.video);
    if (live.cleanup) live.cleanup();
    live.video = live.grabber = live.cleanup = null;
    $("live").hidden = true;
    $("stage").innerHTML = "";
    $("stage").className = "";
    $("ui").style.display = "";
    mode = "report";
  }

  function layoutLive() {
    var zs = $("live-zones");
    zs.innerHTML = "";
    var segs = [];
    // 8 segments: left edge x3 (top→bottom), right edge x3, top edge x2 (left→right), plus centre.
    for (var i = 0; i < 3; i++) segs.push({ k: "l" + i, x: 0, y: i * 360, w: 150, h: 360 });
    for (i = 0; i < 3; i++) segs.push({ k: "r" + i, x: 1770, y: i * 360, w: 150, h: 360 });
    segs.push({ k: "t0", x: 150, y: 0, w: 810, h: 110 });
    segs.push({ k: "t1", x: 960, y: 0, w: 810, h: 110 });
    segs.push({ k: "c", x: 860, y: 440, w: 200, h: 200 });
    segs.forEach(function (s) {
      var d = document.createElement("div");
      d.id = "seg-" + s.k;
      d.style.cssText = "left:" + s.x + "px;top:" + s.y + "px;width:" + s.w + "px;height:" + s.h + "px;background:#000;" +
        (s.k === "c" ? "border:6px solid #fff;border-radius:100px" : "");
      zs.appendChild(d);
    });
  }

  function regionAvg(d, x0, x1, y0, y1) {
    var r = 0, g = 0, b = 0, n = 0;
    for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) { var i = (y * SW + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return n ? [r / n, g / n, b / n] : [0, 0, 0];
  }

  function startLive(sourceKind) {
    if (busy || mode === "live") return;
    mode = "live";
    live.on = true;
    var token = ++live.token;
    var pick = bestMethod();
    live.method = pick.method;
    live.source = sourceKind || "pattern";
    $("ui").style.display = "none";
    $("live").hidden = false;
    layoutLive();
    var hud = $("live-hud");
    hud.textContent = "starting " + live.method + "…";
    var video = createVideo("full");
    live.video = video;
    var srcName = live.source === "remote" ? "remote" : (pick.source === "remote" ? "blob" : pick.source);
    attachSource(srcName, video).then(function (s) {
      live.cleanup = s.cleanup;
      video.loop = true;
      try { var lp = video.play(); if (lp && lp.catch) lp.catch(function () {}); } catch (e) { /* ignore */ }
    }).then(function () { return waitPlaying(video, 15000); }).then(function () {
      live.grabber = makeGrabber(live.method, video);
      var frames = 0, t0 = now(), hz = 0, ms = 0;
      (function loop() {
        if (!live.on || token !== live.token) return;
        var g0 = now();
        live.grabber.grab().then(function (d) {
          ms = now() - g0;
          function set(id, c) { $("seg-" + id).style.background = hex(c); }
          for (var i = 0; i < 3; i++) {
            var y0 = Math.floor(i * SH / 3), y1 = Math.floor((i + 1) * SH / 3);
            set("l" + i, regionAvg(d, 0, 13, y0, y1));
            set("r" + i, regionAvg(d, 51, SW, y0, y1));
          }
          set("t0", regionAvg(d, 13, 32, 0, 7));
          set("t1", regionAvg(d, 32, 51, 0, 7));
          var c = regionAvg(d, 0, SW, 0, SH);
          set("c", c);
          frames++;
          if (now() - t0 >= 1000) { hz = frames; frames = 0; t0 = now(); }
          hud.textContent = live.method + " · " + srcName + " · " + hz + " Hz · " + Math.round(ms * 10) / 10 + " ms/grab · avg " + hex(c) +
            " · OK: switch source · RETURN: back";
          setTimeout(loop, Math.max(0, 20 - ms));
        }, function (e) { hud.textContent = "grab failed: " + e.message; });
      })();
    }).catch(function (e) { hud.textContent = "live failed: " + (e && e.message); log("live failed: " + (e && e.message)); });
  }

  // ---------------------------------------------------------------- keys + boot
  function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { try { window.close(); } catch (e2) { /* ignore */ } }
  }

  function onKey(e) {
    var k = e.keyCode;
    if (mode === "live") {
      if (k === 10009 || k === 8 || k === 27) { stopLive(); return; }
      if (k === 13) { var next = live.source === "pattern" ? "remote" : "pattern"; stopLive(); startLive(next); return; }
      return;
    }
    if (k === 10009 || k === 27) { exitApp(); return; }
    if (k === 403 || k === 82 || k === 13) runAll();
    else if (k === 404 || k === 71) startLive("pattern");
    else if (k === 405 || k === 89) { $("env").style.maxHeight = $("env").style.maxHeight === "none" ? "" : "none"; }
    else if (k === 406 || k === 66) sendReport();
  }

  function boot() {
    tryCall(function () {
      ["ColorF0Red", "ColorF1Green", "ColorF2Yellow", "ColorF3Blue"].forEach(function (n) { tizen.tvinputdevice.registerKey(n); });
    });
    document.addEventListener("keydown", onKey);
    env = gatherEnv();
    renderEnv(env);
    renderRows();
    log("probe " + VERSION + " ready · report url: " + (CFG.REPORT_URL || "none") + " · remote: " + (remoteUrl() || "none"));
    // Give the TV a moment to finish launching before the first (hardware-decoder) test.
    setTimeout(runAll, 1200);
  }

  window.addEventListener("error", function (e) { log("window error: " + e.message); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
