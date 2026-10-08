"use strict";

var assert = require("node:assert/strict");
var dgram = require("node:dgram");
var test = require("node:test");
var colour = require("../services/tizen/runtime/ambilight-colour.cjs");
var stripOutput = require("../services/tizen/runtime/ambilight-strip.cjs");
var ambilight = require("../services/tizen/runtime/ambilight.cjs");
var internals = stripOutput._internals;

function picture(pixel) {
  var w = 80,
    h = 45,
    data = Buffer.alloc(w * h * 3);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var c = pixel(x / w, y / h);
      for (var k = 0; k < 3; k++) data[(y * w + x) * 3 + k] = c[k];
    }
  }
  return { w: w, h: h, bpp: 3, data: data };
}

test("segments run round the picture from the controller end, either way", function () {
  assert.deepEqual(internals.segmentOrder(0, true), ["tl", "t", "tr", "r", "br", "b", "bl", "l"]);
  assert.deepEqual(internals.segmentOrder(6, true), ["bl", "l", "tl", "t", "tr", "r", "br", "b"]);
  assert.deepEqual(internals.segmentOrder(6, false), ["bl", "b", "br", "r", "tr", "t", "tl", "l"]);
});

test("a DDP packet has the 10 byte push header and segments on the even pixels", function () {
  var colours = [];
  for (var i = 0; i < 8; i++) colours.push([i + 1, 10, 20]);
  var payload = internals.buildPayload(colours);
  assert.equal(payload.length, 48);
  assert.deepEqual(Array.from(payload.slice(0, 6)), [1, 10, 20, 0, 0, 0]);
  assert.deepEqual(Array.from(payload.slice(6, 9)), [2, 10, 20]);
  var packet = internals.buildPacket(payload, 3);
  assert.equal(packet.length, 58);
  assert.deepEqual(Array.from(packet.slice(0, 10)), [0x41, 3, 1, 1, 0, 0, 0, 0, 0, 48]);
  assert.equal(internals.buildPacket(payload, 16)[1], 1); // sequence 1..15
});

test("each edge zone sees its own part of the picture", function () {
  // red top edge, blue bottom edge, green left edge, yellow right edge, dark grey inside
  var image = picture(function (x, y) {
    if (y < 0.15) return [255, 0, 0];
    if (y > 0.85) return [0, 0, 255];
    if (x < 0.15) return [0, 255, 0];
    if (x > 0.85) return [255, 255, 0];
    return [40, 40, 40];
  });
  var zones = new colour.Analyser().analyse(image, 0.1, true).zones;
  function rgb(name) {
    return zones[name].colour;
  }
  ["t"].forEach(function (name) {
    assert.ok(rgb(name)[0] > 4 * Math.max(rgb(name)[1], rgb(name)[2]), name + " red");
  });
  assert.ok(rgb("b")[2] > 4 * Math.max(rgb("b")[0], rgb("b")[1]), "bottom blue");
  assert.ok(rgb("l")[1] > 4 * Math.max(rgb("l")[0], rgb("l")[2]), "left green");
  assert.ok(rgb("r")[0] > 4 * rgb("r")[2] && rgb("r")[1] > 4 * rgb("r")[2], "right yellow");
  assert.equal(colour.STRIP_ZONES.length, 8);
  assert.equal(new colour.Analyser().analyse(image, 0.1).zones, undefined);
});

test("strip query parsing", function () {
  var parse = ambilight._internals.parseStrip;
  assert.equal(parse({}), null);
  assert.equal(parse({ strip: "off" }), null);
  var config = parse({ strip: "192.168.1.9", stripStart: "6", stripDir: "ccw", stripBright: "40" });
  assert.deepEqual(config, { ip: "192.168.1.9", start: 6, clockwise: false, bright: 40 });
  // the app names the address; the strip's own default is only the last resort
  assert.equal(parse({ strip: "on", stripIp: "10.1.2.3" }).ip, "10.1.2.3");
  assert.equal(parse({ strip: "on", stripIp: "999.1.2.3" }).ip, "");
  assert.equal(parse({ strip: "on" }).ip, "");
  var fallback = new stripOutput.Strip(parse({ strip: "on" }));
  assert.equal(fallback.ip, stripOutput.DEFAULT_IP);
  assert.equal(fallback.ipFallback, true);
  var full = parse({
    strip: "on",
    stripIp: "10.1.2.3",
    ddpPort: "4049",
    stripSat: "150",
    stripSmooth: "HIGH"
  });
  assert.deepEqual(full, {
    ip: "10.1.2.3",
    start: 0,
    clockwise: true,
    bright: 0,
    ddpPort: 4049,
    saturation: 150,
    smoothing: "high"
  });
  var configured = new stripOutput.Strip(full);
  assert.equal(configured.ipFallback, false);
  assert.equal(configured.ddpPort, 4049);
  assert.equal(configured.saturation, 1.5);
  assert.equal(configured.regions.t.options.smoothing, stripOutput.SMOOTHING.high.smoothing);
  assert.equal(new stripOutput.Strip({ ip: "10.1.2.3" }).ddpPort, 4048);
});

function listen(port) {
  var socket = dgram.createSocket("udp4"),
    packets = [];
  return new Promise(function (resolve, reject) {
    socket.on("error", reject);
    socket.on("message", function (message) {
      packets.push(message);
    });
    socket.bind(port || 0, "127.0.0.1", function () {
      resolve({ socket: socket, packets: packets, port: socket.address().port });
    });
  });
}

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function zoneGoals(pick) {
  var zones = {};
  colour.STRIP_ZONES.forEach(function (name) {
    zones[name] = { colour: pick(name), brightness: 1, colourfulness: 0.5, overall: 0.5 };
  });
  return zones;
}

function isBlack(packet) {
  return Array.from(packet.slice(10)).every(function (v) {
    return v === 0;
  });
}

test("pacing: identical frames are not resent, a keep-alive goes out once a second, changes go at once", async function () {
  var rx = await listen();
  var strip = new stripOutput.Strip({
    ip: "127.0.0.1",
    ddpPort: rx.port,
    bright: 100,
    smoothing: "low"
  });
  try {
    strip.open();
    strip.setGoals(
      zoneGoals(function () {
        return [1, 0, 0];
      })
    );
    var t0 = 1000000;
    for (var i = 0; i < 40; i++) strip.tick(0.05, 100, t0 + i * 50); // glides to the goal, then settles
    var settled = strip.describe().sent;
    for (var k = 0; k < 10; k++) strip.tick(0.05, 100, t0 + 2000 + k * 50); // 0.5 s of identical frames
    var afterQuiet = strip.describe().sent;
    assert.ok(
      afterQuiet - settled <= 1,
      "at most one keep-alive in half a second: " + (afterQuiet - settled)
    );
    strip.tick(0.05, 100, t0 + 4000); // > 1 s since the last packet: keep-alive
    assert.equal(strip.describe().sent, afterQuiet + 1);
    assert.ok(strip.describe().keepAlives >= 1);
    strip.tick(0.05, 100, t0 + 4010); // and not again straight after
    assert.equal(strip.describe().sent, afterQuiet + 1);
    strip.setGoals(
      zoneGoals(function () {
        return [0, 0, 1];
      })
    ); // a fresh, different frame
    strip.tick(0.05, 100, t0 + 4020);
    assert.equal(strip.describe().sent, afterQuiet + 2, "a change goes out at once");
    await wait(60);
    assert.equal(rx.packets.length, strip.describe().sent);
    var sequences = rx.packets.map(function (p) {
      return p[1];
    });
    assert.ok(
      sequences.every(function (s) {
        return s >= 1 && s <= 15;
      })
    );
  } finally {
    strip.close();
    await wait(250);
    rx.socket.close();
  }
});

test("blackout sends several black packets, stays black, and resume follows the picture again", async function () {
  var rx = await listen();
  var strip = new stripOutput.Strip({ ip: "127.0.0.1", ddpPort: rx.port, bright: 100 });
  try {
    strip.open();
    strip.setGoals(
      zoneGoals(function () {
        return [0, 1, 0];
      })
    );
    strip.tick(0.1, 100);
    await wait(30);
    var before = rx.packets.length;
    assert.ok(before >= 1 && !isBlack(rx.packets[0]));
    strip.blackout();
    await wait(150);
    var black = rx.packets.slice(before);
    assert.equal(black.length, 3, "three black packets a few tens of ms apart");
    assert.ok(black.every(isBlack));
    strip.tick(0.1, 100); // dark: the colour does not come back on a tick
    await wait(30);
    assert.ok(rx.packets.slice(before).every(isBlack));
    strip.resume();
    strip.tick(0.1, 100);
    await wait(30);
    assert.ok(!isBlack(rx.packets[rx.packets.length - 1]), "colour again after resume");
  } finally {
    strip.close();
    await wait(250);
    rx.socket.close();
  }
});

test("a new address or port from /ambilight/config takes effect without a restart", async function () {
  var first = await listen(),
    second = await listen();
  var strip = new stripOutput.Strip({ ip: "127.0.0.1", ddpPort: first.port, bright: 100 });
  try {
    strip.open();
    strip.setGoals(
      zoneGoals(function () {
        return [1, 0, 0];
      })
    );
    strip.tick(0.1, 100);
    await wait(30);
    assert.equal(first.packets.length, 1);
    strip.configure({ ip: "127.0.0.1", ddpPort: second.port, bright: 100, saturation: 100 });
    strip.tick(0.1, 100);
    await wait(30);
    assert.equal(second.packets.length, 1, "the next frame goes to the new port");
    assert.equal(strip.describe().saturation, 100);
  } finally {
    strip.close();
    await wait(250);
    first.socket.close();
    second.socket.close();
  }
});

test("the strip sends one DDP packet per changed colour and switches off on close", async function () {
  var socket = dgram.createSocket("udp4"),
    packets = [];
  await new Promise(function (resolve, reject) {
    socket.on("error", reject);
    socket.on("message", function (message) {
      packets.push(message);
    });
    socket.bind(4048, "127.0.0.1", resolve);
  });
  try {
    var strip = new stripOutput.Strip({ ip: "127.0.0.1", start: 0, clockwise: true, bright: 100 });
    strip.open();
    var zones = {};
    colour.STRIP_ZONES.forEach(function (name) {
      zones[name] = {
        colour: name === "t" ? [1, 0, 0] : [0, 0, 1],
        brightness: 1,
        colourfulness: 0.5,
        overall: 0.5
      };
    });
    strip.setGoals(zones);
    strip.tick(0.1, 100);
    strip.tick(0.1, 100); // nothing moved far: same bytes are not sent twice at rest
    await new Promise(function (resolve) {
      setTimeout(resolve, 80);
    });
    assert.ok(packets.length >= 1);
    var first = packets[0];
    assert.equal(first.length, 58);
    assert.equal(first[0], 0x41);
    var topRed = first.slice(10 + 6, 10 + 9); // zone 2 = "t"
    assert.ok(topRed[0] > topRed[2], "top segment is red");
    assert.ok(first[10 + 2] > first[10], "top-left is blue");
    assert.deepEqual(Array.from(first.slice(10 + 3, 10 + 6)), [0, 0, 0]); // white chips stay off
    strip.close();
    await new Promise(function (resolve) {
      setTimeout(resolve, 300);
    });
    var last = packets[packets.length - 1];
    assert.ok(
      Array.from(last.slice(10)).every(function (v) {
        return v === 0;
      }),
      "off on close"
    );
    assert.ok(strip.describe().sent >= 2);
  } finally {
    socket.close();
  }
});

test("when the strip counts nothing the sender moves on to the next way and ends on HTTP", async function () {
  var http = require("node:http"),
    requests = [];
  var web = http.createServer(function (request, response) {
    requests.push(request.url);
    response.end("<html>DDP received: 7 packets</html>"); // a counter that never moves
  });
  await new Promise(function (resolve) {
    web.listen(0, "127.0.0.1", resolve);
  });
  var strip = new stripOutput.Strip({
    ip: "127.0.0.1",
    ddpPort: 9,
    webPort: web.address().port,
    healthMs: 60,
    bright: 100
  });
  try {
    strip.open();
    var zones = {};
    colour.STRIP_ZONES.forEach(function (name) {
      zones[name] = { colour: [1, 0, 0], brightness: 1, colourfulness: 0.5, overall: 0.5 };
    });
    strip.setGoals(zones);
    var seen = [];
    for (var round = 0; round < 260; round++) {
      strip.tick(0.05, 100 - (round % 2)); // a slightly different colour each time so every frame is sent
      strip.pacer.reset();
      if (seen[seen.length - 1] !== strip.describe().method) seen.push(strip.describe().method);
      await new Promise(function (resolve) {
        setTimeout(resolve, 6);
      });
    }
    assert.deepEqual(seen, ["udp", "udp-fresh", "udp-bound", "http"]);
    assert.ok(
      requests.some(function (url) {
        return url.indexOf("SM16703P_SetRaw") >= 0;
      }),
      "frames went over HTTP"
    );
    assert.ok(strip.describe().health.switches >= 3);
  } finally {
    strip.close();
    web.close();
  }
});
