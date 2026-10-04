"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var zlib = require("node:zlib");
var test = require("node:test");
var ambilight = require("../services/tizen/runtime/ambilight.cjs");
var internals = ambilight._internals;

var BULBS_FILE = path.join(__dirname, "..", "services", "tizen", "ambilight-bulbs.json");
var KEY = "0123456789abcdef";

function png(width, height, pixel) {
  function chunk(type, data) {
    var out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(internals.crc32(out.slice(4, 8 + data.length)), 8 + data.length);
    return out;
  }
  var header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2; // RGB
  var raw = Buffer.alloc((width * 3 + 1) * height);
  for (var y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = y % 2 ? 1 : 0; // alternate "none" and "sub" filters
    for (var x = 0; x < width; x++) {
      var c = pixel(x, y), at = y * (width * 3 + 1) + 1 + x * 3;
      for (var k = 0; k < 3; k++) {
        var left = x > 0 ? pixel(x - 1, y)[k] : 0;
        raw[at + k] = y % 2 ? (c[k] - left) & 255 : c[k];
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function call(url) {
  return new Promise(function (resolve) {
    var response = {
      status: 0,
      headers: null,
      writeHead: function (status, headers) { this.status = status; this.headers = headers; },
      end: function (text) { resolve({ status: this.status, body: JSON.parse(text) }); }
    };
    ambilight.handleRequest({ url: url }, response);
  });
}

test("left, right and center averages come from a decoded capture", function () {
  var image = internals.decodePng(png(8, 4, function (x) { return x < 4 ? [200, 0, 0] : [0, 0, 100]; }));
  assert.equal(image.w, 8);
  var z = internals.zones(image);
  assert.deepEqual(z.left, [200, 0, 0]);
  assert.deepEqual(z.right, [0, 0, 100]);
  assert.deepEqual(z.center, [100, 0, 50]);
});

test("colour data point carries rgb, hue, saturation and value and never goes fully dark", function () {
  assert.equal(internals.colourHex([255, 0, 0]), "ff0000" + "0000" + "ff" + "ff");
  assert.equal(internals.colourHex([0, 0, 255]), "0000ff" + "00f0" + "ff" + "ff");
  assert.equal(internals.colourHex([0, 0, 0]), "0a0a0a" + "0000" + "00" + "0a");
  assert.deepEqual(internals.scale([200, 100, 50], 50), [100, 50, 25]);
});

test("Tuya frames use the standard CRC-32 and AES round-trips with the local key", function () {
  assert.equal(internals.crc32(Buffer.from("123456789")), 0xcbf43926);
  var frame = internals.tuyaFrame(3, 7, Buffer.from("abcd"));
  assert.equal(frame.readUInt32BE(0), 0x000055aa);
  assert.equal(frame.readUInt32BE(8), 7);
  assert.equal(frame.readUInt32BE(12), 12);
  assert.equal(frame.readUInt32BE(frame.length - 4), 0x0000aa55);
  var secret = internals.aes(KEY, Buffer.from('{"dps":{"1":true}}'), false);
  assert.equal(internals.aes(KEY, secret, true).toString(), '{"dps":{"1":true}}');
});

test("encrypted UDP announcements reveal a bulb's current address", function () {
  var payload = internals.aes(internals.UDP_KEY, Buffer.from('{"ip":"10.0.0.42","gwId":"bulb1","version":"3.3"}'), false);
  var frame = internals.tuyaFrame(0, 0x13, Buffer.concat([Buffer.alloc(4), payload]));
  assert.deepEqual(internals.parseAnnouncement(frame), { id: "bulb1", ip: "10.0.0.42" });
});

test("the bulb list drops excluded devices and incomplete entries", function () {
  var list = internals.normalizeBulbList([
    { id: "a", name: "Desk left", key: KEY, ip: "10.0.0.3", pos: "center" },
    { id: "g", name: "Groei lamp", key: KEY, ip: "10.0.0.11" },
    { id: "x", name: "Flagged", key: KEY, ip: "10.0.0.12", exclude: true },
    { id: "b", name: "No key", key: "", ip: "10.0.0.4" },
    { id: "a", name: "Duplicate", key: KEY, ip: "10.0.0.5" },
    { id: "c", name: "Odd position", key: KEY, ip: "10.0.0.6", pos: "top" }
  ]);
  assert.deepEqual(list.map(function (b) { return b.id + ":" + b.pos; }), ["a:center", "c:center"]);
  assert.deepEqual(internals.parseAssignments("a:left,c%3A1:off,d:up,e"), { a: "left", "c:1": "off" });
});

test("routes list bulbs without their keys and answer pings without a session", async function () {
  fs.writeFileSync(BULBS_FILE, JSON.stringify([
    { id: "a", name: "Desk left", key: KEY, ip: "10.0.0.3", pos: "center" },
    { id: "g", name: "groei", key: KEY, ip: "10.0.0.11", pos: "left" }
  ]));
  try {
    var bulbs = await call("/ambilight/bulbs");
    assert.equal(bulbs.status, 200);
    assert.deepEqual(bulbs.body.bulbs, [{ id: "a", name: "Desk left", pos: "center" }]);
    assert.equal(JSON.stringify(bulbs.body).indexOf(KEY), -1);
    assert.deepEqual((await call("/ambilight/ping")).body, { ok: true, active: false });
    assert.equal((await call("/ambilight/nope")).status, 404);
    assert.equal(ambilight.isAmbilightRequest("/ambilight/state"), true);
    assert.equal(ambilight.isAmbilightRequest("/media?x=1"), false);
  } finally {
    fs.unlinkSync(BULBS_FILE);
  }
});

// End to end on Linux: a stand-in for Samsung's capture service (a fake `gdbus` on PATH that
// writes a half red, half blue PNG) and a fake Tuya bulb on 127.0.0.1:6668.
test("a session colours the bulb from its zone and restores it on stop", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var net = require("node:net");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  var picture = path.join(dir, "capture.png");
  fs.writeFileSync(picture, png(8, 4, function (x) { return x < 4 ? [200, 0, 0] : [0, 0, 100]; }));
  fs.writeFileSync(path.join(dir, "gdbus"), '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\ncp "' + picture + '" "$dir/$last.png"\necho "(0, 320, 180, \'x\')"\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;

  var received = [];
  var state = { 1: false, 2: "white", 3: 500, 5: "000000000000ff" };
  var server = net.createServer(function (socket) {
    var rx = Buffer.alloc(0);
    socket.on("data", function (chunk) {
      rx = Buffer.concat([rx, chunk]);
      while (rx.length >= 24 && rx.length >= 16 + rx.readUInt32BE(12)) {
        var total = 16 + rx.readUInt32BE(12), command = rx.readUInt32BE(8);
        var data = rx.slice(16, total - 8);
        rx = rx.slice(total);
        if (data.slice(0, 3).toString() === "3.3") data = data.slice(15);
        var body = JSON.parse(internals.aes(KEY, data, true).toString());
        received.push({ command: command, dps: body.dps });
        if (command === 10) {
          var reply = internals.aes(KEY, Buffer.from(JSON.stringify({ dps: state })), false);
          socket.write(internals.tuyaFrame(1, 10, Buffer.concat([Buffer.alloc(4), reply])));
        }
      }
    });
  });
  await new Promise(function (resolve) { server.listen(6668, "127.0.0.1", resolve); });
  fs.writeFileSync(BULBS_FILE, JSON.stringify([{ id: "a", name: "Desk left", key: KEY, ip: "127.0.0.1", pos: "center" }]));
  try {
    var started = await call("/ambilight/start?level=50&assign=a:left");
    assert.equal(started.body.ok, true);
    await new Promise(function (resolve) { setTimeout(resolve, 2600); });
    var colour = received.filter(function (m) { return m.command === 7 && m.dps["5"]; })[0];
    assert.ok(colour, "the bulb received a colour");
    assert.equal(colour.dps["1"], true);
    assert.equal(colour.dps["2"], "colour");
    assert.equal(colour.dps["5"].slice(0, 6), "640000"); // left half (200,0,0) at 50%
    var state1 = (await call("/ambilight/state")).body.state;
    assert.equal(state1.running, true);
    assert.ok(state1.captures > 0);
    await call("/ambilight/stop");
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    var restore = received[received.length - 1];
    assert.equal(restore.command, 7);
    assert.deepEqual(restore.dps, { 1: false, 2: "white", 3: 500, 5: "000000000000ff" });
    assert.deepEqual((await call("/ambilight/ping")).body, { ok: true, active: false });
  } finally {
    ambilight.stop("test");
    process.env.PATH = originalPath;
    fs.unlinkSync(BULBS_FILE);
    await new Promise(function (resolve) { setTimeout(resolve, 1300); });
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
