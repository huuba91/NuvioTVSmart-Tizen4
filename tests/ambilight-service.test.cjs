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

test("captures decode to raw pixels", function () {
  var image = internals.decodePng(png(8, 4, function (x) { return x < 4 ? [200, 0, 0] : [0, 0, 100]; }));
  assert.equal(image.w, 8);
  assert.equal(image.h, 4);
  assert.deepEqual(Array.from(image.data.slice(0, 3)), [200, 0, 0]);
  assert.deepEqual(Array.from(image.data.slice(7 * 3, 8 * 3)), [0, 0, 100]);
  assert.deepEqual(Array.from(image.data.slice(3 * 8 * 3 + 21, 3 * 8 * 3 + 24)), [0, 0, 100]);
});

test("colour data point carries rgb, hue, saturation and value and never goes fully dark", function () {
  assert.equal(internals.colourHex([255, 0, 0]), "ff0000" + "0000" + "ff" + "ff");
  assert.equal(internals.colourHex([0, 0, 255]), "0000ff" + "00f0" + "ff" + "ff");
  assert.equal(internals.colourHex([0, 0, 0]), "0a0a0a" + "0000" + "00" + "0a");
  assert.deepEqual(internals.hsvToRgb255([0, 1, 0.5]), [128, 0, 0]);
  assert.deepEqual(internals.hsvToRgb255([2 / 3, 1, 1]), [0, 0, 255]);
  assert.deepEqual(internals.hsvToRgb255([0.5, 0, 1]), [255, 255, 255]);
});

test("bulbs with the v2 colour data point get hhhhssssvvvv so brightness reaches them", function () {
  assert.equal(internals.hsv16Hex([0, 1, 0.5]), "0000" + "03e8" + "01f4");
  assert.equal(internals.hsv16Hex([2 / 3, 0.5, 0]), "00f0" + "01f4" + "000a"); // never fully dark
  assert.equal(internals.formatFromDps({ 5: "00f003e803e8" }), "hsv16");
  assert.equal(internals.formatFromDps({ 5: "ff00000000ffff" }), "rgb8");
  assert.equal(internals.formatFromDps({}), "");
  assert.equal(internals.normalizeBulbList([{ id: "a", key: KEY, ip: "1", format: "HSV16" }])[0].format, "hsv16");
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
  assert.deepEqual(internals.parseAssignments("a:left,c%3A1:off:40,d:up,e,f:right:0"), {
    a: { pos: "left", max: 100 },
    "c:1": { pos: "off", max: 40 },
    f: { pos: "right", max: 100 }
  });
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

// A fake Tuya bulb on 127.0.0.1:6668 that records what it is sent and can answer or hang up.
function fakeBulb(options) {
  var net = require("node:net");
  var bulb = { received: [], sockets: [], answer: options && options.answer };
  bulb.server = net.createServer(function (socket) {
    var rx = Buffer.alloc(0);
    bulb.sockets.push(socket);
    socket.on("error", function () {});
    socket.on("data", function (chunk) {
      rx = Buffer.concat([rx, chunk]);
      while (rx.length >= 24 && rx.length >= 16 + rx.readUInt32BE(12)) {
        var total = 16 + rx.readUInt32BE(12), command = rx.readUInt32BE(8), data = rx.slice(16, total - 8);
        rx = rx.slice(total);
        if (data.slice(0, 3).toString() === "3.3") data = data.slice(15);
        bulb.received.push({ command: command, dps: JSON.parse(internals.aes(KEY, data, true).toString()).dps });
        if (bulb.answer) socket.write(internals.tuyaFrame(1, command, Buffer.alloc(4)));
      }
    });
  });
  bulb.listen = function () { return new Promise(function (resolve) { bulb.server.listen(6668, "127.0.0.1", resolve); }); };
  bulb.close = function () {
    bulb.sockets.forEach(function (socket) { socket.destroy(); });
    return new Promise(function (resolve) { bulb.server.close(resolve); });
  };
  return bulb;
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function colourState(h) {
  return { mode: "colour", hsv: [h, 1, 1] };
}

test("a bulb is not sent a new colour before it answered the last one", async function () {
  var fake = fakeBulb({ answer: false });
  await fake.listen();
  var bulb = new internals.Bulb({ id: "a", name: "Desk left", key: KEY, ip: "127.0.0.1", pos: "center", max: 100 });
  try {
    await new Promise(function (resolve) { bulb.connect(resolve); });
    bulb.show(colourState(0), 100);
    bulb.show(colourState(0.3), 100); // at once: too soon
    await wait(200);
    bulb.show(colourState(0.3), 100); // 200 ms on, but the first one is still unanswered
    await wait(50);
    assert.equal(fake.received.length, 1);
    assert.equal(fake.received[0].dps["2"], "colour");
    fake.answer = true;
    await wait(350); // past the answer timeout: the bulb is given the newest colour
    bulb.show(colourState(0.6), 100);
    await wait(150); // answered this time, so the next one may follow after the minimum gap
    bulb.show(colourState(0.9), 100);
    await wait(50);
    assert.equal(fake.received.length, 3);
    assert.deepEqual(Object.keys(fake.received[2].dps), ["5"]);
  } finally {
    bulb.close();
    await fake.close();
  }
});

test("a bulb that drops the connection is taken again and put back in colour mode", async function () {
  var fake = fakeBulb({ answer: true });
  await fake.listen();
  var bulb = new internals.Bulb({ id: "a", name: "Desk left", key: KEY, ip: "127.0.0.1", pos: "center", max: 100 });
  try {
    await new Promise(function (resolve) { bulb.connect(resolve); });
    bulb.autoReconnect = true;
    bulb.show(colourState(0), 100);
    await wait(100);
    fake.sockets[0].destroy(); // what the real bulbs did after ~70 colours
    await wait(300);
    assert.equal(bulb.connected, false);
    bulb.show(colourState(0.3), 100); // nowhere to send it
    await wait(2300);
    assert.equal(bulb.connected, true);
    assert.equal(bulb.reconnects, 1);
    bulb.show(colourState(0.6), 100);
    await wait(100);
    var last = fake.received[fake.received.length - 1];
    assert.equal(fake.received.length, 2);
    assert.equal(last.dps["1"], true);
    assert.equal(last.dps["2"], "colour");
  } finally {
    bulb.close();
    await fake.close();
  }
});

// End to end on Linux: a stand-in for Samsung's capture service (a fake `gdbus` on PATH that
// writes a half red, half blue PNG) and a fake Tuya bulb on 127.0.0.1:6668.
test("a session colours the bulb from its zone, follows live brightness and restores it on stop", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var net = require("node:net");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  var picture = path.join(dir, "capture.png");
  fs.writeFileSync(picture, png(8, 4, function (x) { return x < 4 ? [200, 0, 0] : [0, 0, 100]; }));
  fs.writeFileSync(path.join(dir, "gdbus"), '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\ncp "' + picture + '" "$dir/$last.png"\necho "(0, 320, 180, \'x\')"\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;

  var received = [];
  var state = { 1: false, 2: "white", 3: 500, 5: "00f003e803e8" };
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
    var started = await call("/ambilight/start?level=100&assign=a:left:50");
    assert.equal(started.body.ok, true);
    await new Promise(function (resolve) { setTimeout(resolve, 2600); });
    var colour = received.filter(function (m) { return m.command === 7 && m.dps["5"]; })[0];
    assert.ok(colour, "the bulb received a colour");
    assert.equal(colour.dps["1"], true);
    assert.equal(colour.dps["2"], "colour");
    assert.equal(colour.dps["5"], "000003e80188"); // left edge (200,0,0) at 50%, in the bulb's hsv16 format
    var level = await call("/ambilight/level?value=50");
    assert.equal(level.body.level, 50);
    await new Promise(function (resolve) { setTimeout(resolve, 200); });
    var colours = received.filter(function (m) { return m.command === 7 && m.dps["5"]; });
    assert.deepEqual(colours[colours.length - 1].dps, { 5: "000003e800c4" }); // bulb cap 50% x overall 50%, colour only
    var state1 = (await call("/ambilight/state")).body.state;
    assert.equal(state1.bulbs[0].format, "hsv16"); // read from the bulb's own status (12-digit DP 5)
    assert.equal(JSON.stringify(state1).indexOf(KEY), -1);
    assert.equal(state1.running, true);
    assert.ok(state1.captures > 0);
    await call("/ambilight/stop");
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    var restore = received[received.length - 1];
    assert.equal(restore.command, 7);
    assert.deepEqual(restore.dps, { 1: false, 2: "white", 3: 500, 5: "00f003e803e8" });
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

test("pictureChange measures how much two pictures differ and refuses mismatched ones", function () {
  var a = internals.decodePng(png(8, 8, function () { return [100, 100, 100]; }));
  var same = internals.decodePng(png(8, 8, function () { return [100, 100, 100]; }));
  var brighter = internals.decodePng(png(8, 8, function () { return [110, 100, 90]; }));
  var other = internals.decodePng(png(4, 4, function () { return [100, 100, 100]; }));
  assert.equal(internals.pictureChange(a, same), 0);
  assert.equal(internals.pictureChange(a, brighter), 20 / 3);
  assert.equal(internals.pictureChange(a, other), 255);
  assert.equal(internals.pictureChange(null, a), 255);
});

test("eco activity modes: still, calm and moving pictures", function () {
  var eco = internals.ECO;
  assert.equal(internals.modeForActivity(0), "static");
  assert.equal(internals.modeForActivity(eco.staticBelow), "calm");
  assert.equal(internals.modeForActivity(eco.calmBelow - 0.01), "calm");
  assert.equal(internals.modeForActivity(eco.calmBelow), "active");
  assert.equal(internals.modeForActivity(255), "active");
});

test("eco route toggles pacing and introspect works without a session", async function () {
  var originalPath = process.env.PATH;
  var fake = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "gdbus-"));
  fs.writeFileSync(path.join(fake, "gdbus"),
    "#!/bin/sh\nif [ \"$1\" = introspect ]; then echo 'interface samsung.tizen.dcapture {'; echo '  methods: RequestCaptureToFileSync();'; echo '};'; " +
    "else echo \"(['org.freedesktop.DBus', 'samsung.tizen.dcapture', ':1.5', 'org.tizen.other'],)\"; fi\n", { mode: 493 });
  process.env.PATH = fake + path.delimiter + originalPath;
  function call(url) {
    return new Promise(function (resolve) {
      var response = {
        writeHead: function () {},
        end: function (text) { resolve(JSON.parse(text)); }
      };
      ambilight.handleRequest({ url: url }, response);
    });
  }
  try {
    assert.equal((await call("/ambilight/eco?mode=off")).eco, false);
    assert.equal((await call("/ambilight/eco")).eco, false);
    assert.equal((await call("/ambilight/eco?mode=on")).eco, true);
    var result = await call("/ambilight/introspect");
    assert.deepEqual(result.errors, []);
    assert.ok(result.introspect.some(function (line) { return /RequestCaptureToFileSync/.test(line); }));
    assert.deepEqual(result.names, ["samsung.tizen.dcapture", "org.tizen.other"]);
    assert.ok(fs.readFileSync(result.file, "utf8").indexOf("RequestCaptureToFileSync") >= 0);
  } finally {
    process.env.PATH = originalPath;
    try { fs.unlinkSync("/dev/shm/nuvio-dcapture-introspect.txt"); } catch (_) {}
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test("capture experiments: reply parsing, format sniffing and the sweep route", async function () {
  assert.deepEqual(internals.parseCaptureReply("(0, 320, 180, '/dev/shm/x.png')\n"), { ret: 0, w: 320, h: 180, path: "/dev/shm/x.png" });
  assert.equal(internals.parseCaptureReply("garbage"), null);
  assert.equal(internals.sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "JPEG");
  assert.equal(internals.sniffFormat(Buffer.from("BM123456", "ascii")), "BMP");
  assert.equal(internals.sniffFormat(Buffer.from([0, 0, 0, 100, 0, 0, 0, 7])), "XWD?");
  assert.equal(internals.sniffFormat(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])), "unknown");

  var originalPath = process.env.PATH;
  var fake = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "gdbus-"));
  // comp 1 writes a JPEG-looking file, anything else a BMP-looking one; mode 9 fails
  fs.writeFileSync(path.join(fake, "gdbus"),
    "#!/bin/sh\n" +
    "mode=${12}; comp=${13}; dir=${17}; name=${18}\n" +
    "if [ \"$mode\" = 9 ]; then echo boom >&2; exit 1; fi\n" +
    "if [ \"$comp\" = 1 ]; then printf '\\377\\330\\377\\340abcd' > \"$dir/$name.jpg\"; echo \"(0, 64, 36, '$dir/$name.jpg')\";\n" +
    "else printf 'BMxxxxxx' > \"$dir/$name.bmp\"; echo \"(0, 64, 36, '$dir/$name.bmp')\"; fi\n", { mode: 493 });
  process.env.PATH = fake + path.delimiter + originalPath;
  try {
    var result = await new Promise(function (resolve) {
      ambilight.handleRequest({ url: "/ambilight/capture-sweep?modes=2,9&comps=0,1" }, {
        writeHead: function () {}, end: function (text) { resolve(JSON.parse(text)); }
      });
    });
    assert.equal(result.rows.length, 4);
    var byKey = {};
    result.rows.forEach(function (r) { byKey[r.mode + "/" + r.comp] = r; });
    assert.equal(byKey["2/0"].format, "BMP");
    assert.equal(byKey["2/1"].format, "JPEG");
    assert.equal(byKey["2/1"].w, 64);
    assert.ok(byKey["9/0"].error);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(fake, { recursive: true, force: true });
  }
});
