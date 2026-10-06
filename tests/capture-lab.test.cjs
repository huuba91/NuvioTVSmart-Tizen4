"use strict";

var assert = require("node:assert/strict");
var http = require("node:http");
var test = require("node:test");
var core = require("../tools/capture-lab/service/lab-core.cjs");

function sample(t, L, C, R, bytes, sum) { return { t: t, L: L, C: C, R: R, bytes: bytes || 1000 + Math.round(t), sum: sum || Math.round(t) }; }
var COL = { R: [230, 10, 10], G: [10, 230, 10], B: [10, 10, 230] };

// A series that follows the clip exactly (clip starts at epoch 0, series at epoch 0).
function followingSeries() {
  var samples = [];
  for (var t = 0; t < 11000; t += 100) {
    var set = core.expectedAt(t / 1000 + 0.9) || core.SETS[Math.floor(t / 2000) % 3];
    set = core.SETS[Math.floor(t / 2000) % 3];
    samples.push(sample(t, COL[set[0]], COL[set[1]], COL[set[2]]));
  }
  return { ok: true, startEpoch: 0, samples: samples, errors: [], perSecond: 10 };
}

test("classify names saturated colours, black and white", function () {
  assert.equal(core.classify([230, 10, 10]), "R");
  assert.equal(core.classify([10, 220, 30]), "G");
  assert.equal(core.classify([5, 5, 5]), "K");
  assert.equal(core.classify([240, 240, 240]), "W");
});

test("scoreSeries passes pictures that follow the clip", function () {
  var scored = core.scoreSeries(followingSeries(), 0);
  assert.equal(scored.verdict, "PASS");
  assert.ok(scored.score >= 0.95);
});

test("scoreSeries recognises a delay between the request and the picture", function () {
  var series = followingSeries();
  series.samples.forEach(function (s) { s.t += 400; });
  assert.equal(core.scoreSeries(series, 0).verdict, "PASS");
});

test("scoreSeries calls an unchanging picture STATIC, a dark one BLACK, a wrong one WRONG", function () {
  var still = [];
  for (var i = 0; i < 20; i++) still.push(sample(i * 300, COL.B, COL.G, COL.B, 32132, 777));
  assert.equal(core.scoreSeries({ startEpoch: 0, samples: still, errors: [], perSecond: 3 }, 0).verdict, "STATIC");
  var dark = [];
  for (i = 0; i < 20; i++) dark.push(sample(i * 300, [1, 1, 1], [2, 2, 2], [1, 1, 1], 900 + i, i));
  assert.equal(core.scoreSeries({ startEpoch: 0, samples: dark, errors: [], perSecond: 3 }, 0).verdict, "BLACK");
  var wrong = [];
  for (i = 0; i < 30; i++) wrong.push(sample(i * 350, COL.G, COL.G, COL.G, 900 + i, i));
  assert.equal(core.scoreSeries({ startEpoch: 0, samples: wrong, errors: [], perSecond: 3 }, 0).verdict, "WRONG");
  assert.equal(core.scoreSeries({ samples: [], errors: ["x"], perSecond: 0 }, 0).verdict, "NO PICTURES");
});

test("Hub hands commands to the polling page and resolves them from its events", function () {
  var hub = new core.Hub();
  return hub.send({ type: "stop" }).then(function () { assert.fail("must reject"); }, function (error) {
    assert.match(error.message, /not connected/);
    var got = null;
    hub.poll(50, { x: 1 }, function (command) { got = command; });
    assert.ok(hub.uiConnected());
    var answer = hub.send({ type: "info" }, 2000);
    assert.equal(got.type, "info");
    hub.event({ id: got.id, status: "done", data: { fine: true } });
    return answer.then(function (data) { assert.deepEqual(data, { fine: true }); });
  });
});

test("Hub reports page errors and times out silent pages", function () {
  var hub = new core.Hub();
  hub.poll(10, null, function () {});
  var failing = hub.send({ type: "play" }, 2000);
  var queued = hub.queue[0] || { id: 1 };
  hub.event({ id: queued.id, status: "error", error: "no codec" });
  return failing.then(function () { assert.fail("must reject"); }, function (error) {
    assert.match(error.message, /no codec/);
    return hub.send({ type: "info" }, 30).then(function () { assert.fail("must time out"); }, function (e2) { assert.match(e2.message, /did not answer/); });
  });
});

test("runMatrix plays every clip x engine, captures each mode cold, and records failed plays", function () {
  var hub = new core.Hub(), sent = [], log = [];
  hub.send = function (command) {
    sent.push(command.type + ":" + (command.clip || "") + ":" + (command.engine || ""));
    if (command.type === "play" && command.engine === "avplay") return Promise.reject(new Error("AVPlay error"));
    return Promise.resolve({ clipStartEpoch: 0, startupMs: 120 });
  };
  var modes = [];
  return core.runMatrix({
    hub: hub, sleep: function () { return Promise.resolve(); }, progress: function (t) { log.push(t); },
    series: function (mode) { modes.push(mode); return Promise.resolve(followingSeries()); }
  }, { clips: ["a.mp4"], engines: ["html", "avplay"], modes: [1, 3], seconds: 5 }).then(function (results) {
    assert.deepEqual(modes, [1, 3]);
    assert.equal(results.length, 4);
    assert.equal(results[0].verdict, "PASS");
    assert.equal(results[0].startupMs, 120);
    assert.equal(results[2].verdict, "PLAY FAILED");
    assert.equal(sent.filter(function (s) { return s.indexOf("play") === 0; }).length, 4); // cold: a play per mode
    assert.equal(log.length, 4);
  });
});

test("the lab service serves clips with byte ranges and routes commands", function () {
  var service = require("../tools/capture-lab/service/lab-service.js");
  var server = http.createServer(service._test.handle);
  return new Promise(function (resolve) { server.listen(0, resolve); }).then(function () {
    var port = server.address().port;
    service._test.setPort(port);
    function get(path, headers) {
      return new Promise(function (resolve, reject) {
        http.get({ port: port, path: path, headers: headers || {} }, function (res) {
          var chunks = [];
          res.on("data", function (c) { chunks.push(c); });
          res.on("end", function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
        }).on("error", reject);
      });
    }
    return get("/media/h264-720p.mp4").then(function (full) {
      assert.equal(full.status, 200);
      assert.equal(full.headers["accept-ranges"], "bytes");
      return get("/media/h264-720p.mp4", { Range: "bytes=0-99" }).then(function (part) {
        assert.equal(part.status, 206);
        assert.equal(part.body.length, 100);
        assert.equal(part.headers["content-range"], "bytes 0-99/" + full.body.length);
        assert.deepEqual(part.body, full.body.slice(0, 100));
        return get("/media/..%2f..%2fconfig.xml");
      }).then(function (escape) {
        assert.equal(escape.status, 404);
        return get("/lab/command?type=info&wait=1");
      }).then(function (command) {
        assert.equal(JSON.parse(command.body).ok, false); // no page connected
        return get("/lab/health");
      }).then(function (health) {
        assert.equal(JSON.parse(health.body).lab, true);
      });
    }).then(function () { server.close(); }, function (e) { server.close(); throw e; });
  });
});
