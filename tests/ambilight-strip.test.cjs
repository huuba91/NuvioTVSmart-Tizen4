"use strict";

var assert = require("node:assert/strict");
var dgram = require("node:dgram");
var test = require("node:test");
var colour = require("../services/tizen/runtime/ambilight-colour.cjs");
var stripOutput = require("../services/tizen/runtime/ambilight-strip.cjs");
var ambilight = require("../services/tizen/runtime/ambilight.cjs");
var internals = stripOutput._internals;

function picture(pixel) {
  var w = 80, h = 45, data = Buffer.alloc(w * h * 3);
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
  function rgb(name) { return zones[name].colour; }
  ["t"].forEach(function (name) { assert.ok(rgb(name)[0] > 4 * Math.max(rgb(name)[1], rgb(name)[2]), name + " red"); });
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
  assert.equal(parse({ strip: "on" }).ip, stripOutput.DEFAULT_IP);
});

test("the strip sends one DDP packet per changed colour and switches off on close", async function () {
  var socket = dgram.createSocket("udp4"), packets = [];
  await new Promise(function (resolve, reject) {
    socket.on("error", reject);
    socket.on("message", function (message) { packets.push(message); });
    socket.bind(4048, "127.0.0.1", resolve);
  });
  try {
    var strip = new stripOutput.Strip({ ip: "127.0.0.1", start: 0, clockwise: true, bright: 100 });
    strip.open();
    var zones = {};
    colour.STRIP_ZONES.forEach(function (name) {
      zones[name] = { colour: name === "t" ? [1, 0, 0] : [0, 0, 1], brightness: 1, colourfulness: 0.5, overall: 0.5 };
    });
    strip.setGoals(zones);
    strip.tick(0.1, 100);
    strip.tick(0.1, 100); // nothing moved far: same bytes are not sent twice at rest
    await new Promise(function (resolve) { setTimeout(resolve, 80); });
    assert.ok(packets.length >= 1);
    var first = packets[0];
    assert.equal(first.length, 58);
    assert.equal(first[0], 0x41);
    var topRed = first.slice(10 + 6, 10 + 9); // zone 2 = "t"
    assert.ok(topRed[0] > topRed[2], "top segment is red");
    assert.ok(first[10 + 2] > first[10], "top-left is blue");
    assert.deepEqual(Array.from(first.slice(10 + 3, 10 + 6)), [0, 0, 0]); // white chips stay off
    strip.close();
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    var last = packets[packets.length - 1];
    assert.ok(Array.from(last.slice(10)).every(function (v) { return v === 0; }), "off on close");
    assert.ok(strip.describe().sent >= 2);
  } finally {
    socket.close();
  }
});
