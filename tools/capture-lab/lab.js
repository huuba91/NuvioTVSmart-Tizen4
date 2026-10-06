/* global webapis, tizen, wrt */
(function () {
  "use strict";

  var PORTS = [2720, 2721, 2722, 2723];
  var SERVICE_ID = "CaptureLab.LabService";
  var CLIPS = ["h264-720p.mp4", "h264-1080p.mp4", "hevc-1080p-8bit.mp4", "hevc-1080p-10bit.mp4"];
  var base = "";
  var current = null; // { engine, clip, video }
  var $ = function (id) { return document.getElementById(id); };

  function log(text) {
    var el = $("log");
    el.textContent = (new Date().toTimeString().slice(0, 8) + " " + text + "\n" + el.textContent).slice(0, 1800);
  }
  function status(a, b) { $("line1").textContent = a; if (b !== undefined) $("line2").textContent = b; }

  function xhr(method, path, body, timeoutMs, cb) {
    var req = new XMLHttpRequest(), done = false;
    req.open(method, base + path, true);
    req.timeout = timeoutMs || 10000;
    function finish(error, value) { if (done) return; done = true; cb(error, value); }
    req.onload = function () {
      try { finish(null, JSON.parse(req.responseText)); } catch (e) { finish(e); }
    };
    req.onerror = function () { finish(new Error("network error")); };
    req.ontimeout = function () { finish(new Error("timeout")); };
    req.send(body ? JSON.stringify(body) : null);
  }

  // ------------------------------------------------------------ finding / starting the service
  function probePort(index, cb) {
    if (index >= PORTS.length) { cb(false); return; }
    base = "http://127.0.0.1:" + PORTS[index];
    xhr("GET", "/lab/health", null, 1500, function (error, answer) {
      if (!error && answer && answer.lab) cb(true); else probePort(index + 1, cb);
    });
  }

  function startService(cb) {
    var attempts = [
      function (ok, fail) { tizen.application.launch(SERVICE_ID, ok, fail); },
      function (ok, fail) { (wrt.service || webapis.service).startService(SERVICE_ID, ok, fail); },
      function (ok, fail) {
        var control = new tizen.ApplicationControl("http://tizen.org/appcontrol/operation/default");
        tizen.application.launchAppControl(control, SERVICE_ID, ok, fail);
      }
    ];
    var i = 0;
    (function next() {
      if (i >= attempts.length) { cb(); return; }
      var attempt = attempts[i++], settled = false;
      var after = function (note) { if (settled) return; settled = true; log("start service: " + note); setTimeout(next, 1500); };
      try { attempt(function () { after("requested"); }, function (e) { after("failed " + (e && e.message)); }); } catch (e) { after("unavailable " + (e && e.message)); }
    })();
  }

  function connect(cb) {
    status("looking for the lab service...");
    probePort(0, function (found) {
      if (found) { cb(); return; }
      status("starting the lab service...");
      startService(function () {
        var tries = 0;
        (function again() {
          probePort(0, function (ok) {
            if (ok) { cb(); return; }
            if (++tries > 10) { status("lab service did not start", "reinstall the lab or check the service in config.xml"); setTimeout(function () { connect(cb); }, 5000); return; }
            setTimeout(again, 1500);
          });
        })();
      });
    });
  }

  // ------------------------------------------------------------ players
  function stopCurrent() {
    if (!current) return;
    try {
      if (current.engine === "html") {
        current.video.pause();
        current.video.removeAttribute("src");
        current.video.load();
        if (current.video.parentNode) current.video.parentNode.removeChild(current.video);
      } else {
        try { webapis.avplay.stop(); } catch (e) {}
        try { webapis.avplay.close(); } catch (e2) {}
        document.body.className = "";
      }
    } catch (e3) { log("stop: " + e3.message); }
    current = null;
  }

  function playHtml(clip, cb) {
    var video = document.createElement("video"), t0 = Date.now(), done = false;
    video.muted = true;
    video.loop = true;
    video.setAttribute("playsinline", "");
    $("stage").appendChild(video);
    current = { engine: "html", clip: clip, video: video };
    var finish = function (error, data) { if (done) return; done = true; clearTimeout(timer); cb(error, data); };
    var timer = setTimeout(function () { finish(new Error("video did not start playing in 20 s (readyState " + video.readyState + ", error " + (video.error && video.error.code) + ")")); }, 20000);
    video.addEventListener("error", function () { finish(new Error("video error code " + (video.error && video.error.code))); });
    video.addEventListener("playing", function () {
      var check = function () {
        // wait until the first frame has really advanced
        if (video.currentTime > 0.05) finish(null, { clipStartEpoch: Date.now() - video.currentTime * 1000, startupMs: Date.now() - t0, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
        else setTimeout(check, 30);
      };
      check();
    });
    video.src = base + "/media/" + clip;
    var p = video.play();
    if (p && p.catch) p.catch(function () {}); // the 'playing' event is what counts
  }

  function playAvplay(clip, cb) {
    var t0 = Date.now(), done = false;
    var finish = function (error, data) { if (done) return; done = true; clearTimeout(timer); cb(error, data); };
    var timer = setTimeout(function () { finish(new Error("AVPlay did not start in 25 s")); }, 25000);
    try {
      document.body.className = "avplay";
      current = { engine: "avplay", clip: clip };
      webapis.avplay.open(base + "/media/" + clip);
      webapis.avplay.setListener({
        onbufferingstart: function () {}, onbufferingprogress: function () {}, onbufferingcomplete: function () {},
        oncurrentplaytime: function () {},
        onstreamcompleted: function () { try { webapis.avplay.seekTo(0); webapis.avplay.play(); } catch (e) { log("loop: " + e.message); } },
        onerror: function (type) { finish(new Error("AVPlay error " + type)); },
        onevent: function () {}, onsubtitlechange: function () {}, ondrmevent: function () {}
      });
      webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
      webapis.avplay.prepareAsync(function () {
        try {
          webapis.avplay.play();
          var check = function () {
            var time = 0;
            try { time = webapis.avplay.getCurrentTime(); } catch (e) { time = 0; }
            if (time > 50) finish(null, { clipStartEpoch: Date.now() - time, startupMs: Date.now() - t0 });
            else setTimeout(check, 30);
          };
          check();
        } catch (e) { finish(e); }
      }, function (e) { finish(new Error("prepare failed " + (e && (e.message || e.name || e)))); });
    } catch (error) { finish(error); }
  }

  function play(command, cb) {
    stopCurrent();
    var fn = command.engine === "avplay" ? playAvplay : playHtml;
    status("playing " + command.clip, command.engine);
    fn(command.clip, function (error, data) {
      if (error) { stopCurrent(); cb(error); return; }
      data.engine = command.engine; data.clip = command.clip;
      cb(null, data);
    });
  }

  function info() {
    var data = { userAgent: navigator.userAgent, screen: [window.screen.width, window.screen.height], dpr: window.devicePixelRatio, avplay: false, codecs: {} };
    var probe = document.createElement("video");
    ["video/mp4; codecs=\"avc1.640028\"", "video/mp4; codecs=\"hvc1.1.6.L120.90\"", "video/mp4; codecs=\"hev1.2.4.L120.B0\"", "video/webm; codecs=\"vp9\""].forEach(function (type) {
      try { data.codecs[type] = probe.canPlayType(type); } catch (e) { data.codecs[type] = "error"; }
    });
    try { data.avplay = typeof webapis !== "undefined" && !!webapis.avplay; data.avplayVersion = webapis.avplay.getVersion && webapis.avplay.getVersion(); } catch (e) { data.avplayError = e.message; }
    try { data.tizenVersion = tizen.systeminfo ? "systeminfo" : "no systeminfo"; } catch (e2) {}
    return data;
  }

  function execute(command, cb) {
    switch (command.type) {
      case "play": play(command, cb); return;
      case "stop": stopCurrent(); status("stopped", ""); cb(null, {}); return;
      case "info": cb(null, info()); return;
      case "say": status(String(command.text || ""), ""); cb(null, {}); return;
      default: cb(new Error("unknown command " + command.type));
    }
  }

  // ------------------------------------------------------------ command loop
  function report(id, error, data) {
    xhr("POST", "/lab/event", { id: id, status: error ? "error" : "done", error: error ? String(error.message || error) : undefined, data: data }, 8000, function (e) {
      if (e) log("report failed: " + e.message);
    });
  }

  function loop() {
    var summary = encodeURIComponent(JSON.stringify({ playing: current ? current.engine + " " + current.clip : null, ua: navigator.userAgent.slice(0, 80) }));
    xhr("GET", "/lab/poll?info=" + summary, null, 30000, function (error, answer) {
      if (error) { log("poll: " + error.message); setTimeout(function () { connect(loop); }, 2000); return; }
      var command = answer && answer.command;
      if (!command) { loop(); return; }
      log("command " + command.type + (command.clip ? " " + command.clip + " " + command.engine : ""));
      execute(command, function (err, data) { report(command.id, err, data); loop(); });
    });
  }

  // ------------------------------------------------------------ remote keys
  var localIndex = 0;
  document.addEventListener("keydown", function (e) {
    switch (e.keyCode) {
      case 403: $("panel").classList.toggle("hidden"); break; // red
      case 404: // green: play next clip with HTML
        play({ clip: CLIPS[localIndex++ % CLIPS.length], engine: "html" }, function (err) { if (err) log(err.message); });
        break;
      case 406: stopCurrent(); status("stopped", ""); break; // blue
      case 10009: try { stopCurrent(); tizen.application.getCurrentApplication().exit(); } catch (x) {} break; // back
      default: break;
    }
  });
  try { tizen.tvinputdevice.registerKey("ColorF0Red"); tizen.tvinputdevice.registerKey("ColorF1Green"); tizen.tvinputdevice.registerKey("ColorF3Blue"); } catch (e) {}

  connect(function () { status("connected, waiting for the PC", "service " + base); loop(); });
})();
