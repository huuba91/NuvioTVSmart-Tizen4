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
    await call("/ambilight/capture-format?mode=png");
    await call("/ambilight/capture-tool?mode=gdbus");
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
    await call("/ambilight/capture-format?mode=jpeg");
    await call("/ambilight/capture-tool?mode=busctl-sh");
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

var jpegDc = require("../services/tizen/runtime/jpeg-dc.cjs");
var JPEG_DIR = path.join(__dirname, "fixtures", "jpeg");

function near(actual, expected, tolerance, label) {
  for (var k = 0; k < 3; k++) assert.ok(Math.abs(actual[k] - expected[k]) <= tolerance, label + " channel " + k + ": " + actual[k] + " vs " + expected[k]);
}

function pixelAt(image, x, y) {
  var p = (y * image.w + x) * image.bpp;
  return [image.data[p], image.data[p + 1], image.data[p + 2]];
}

test("jpeg-dc reads one pixel per 8x8 block and keeps the three zone colours", function () {
  // Fixtures: left fifth red, right fifth blue, green ellipse in the middle, on a gradient (made with Pillow).
  var RED = [230, 40, 40], BLUE = [40, 80, 230], GREEN = [40, 200, 60];
  ["420", "444", "rst"].forEach(function (name) {
    var image = jpegDc.decodeJpegDc(fs.readFileSync(path.join(JPEG_DIR, name + ".jpg")));
    assert.equal(image.w, 60, name);
    assert.equal(image.h, 34, name);
    assert.equal(image.bpp, 3, name);
    near(pixelAt(image, 2, 17), RED, 14, name + " left");
    near(pixelAt(image, 57, 17), BLUE, 14, name + " right");
    near(pixelAt(image, 30, 17), GREEN, 14, name + " centre");
  });
  var a = jpegDc.decodeJpegDc(fs.readFileSync(path.join(JPEG_DIR, "420.jpg")));
  var b = jpegDc.decodeJpegDc(fs.readFileSync(path.join(JPEG_DIR, "rst.jpg")));
  assert.deepEqual(Array.from(a.data), Array.from(b.data), "restart markers decode the same picture");
});

test("jpeg-dc handles greyscale and odd sizes and refuses progressive files", function () {
  var grey = jpegDc.decodeJpegDc(fs.readFileSync(path.join(JPEG_DIR, "grey.jpg")));
  assert.equal(grey.bpp, 1);
  assert.equal(grey.w, 60);
  var odd = jpegDc.decodeJpegDc(fs.readFileSync(path.join(JPEG_DIR, "odd.jpg")));
  assert.equal(odd.w, 13);
  assert.equal(odd.h, 10);
  assert.throws(function () { jpegDc.decodeJpegDc(fs.readFileSync(path.join(JPEG_DIR, "prog.jpg"))); }, /SOF2/);
  assert.throws(function () { jpegDc.decodeJpegDc(Buffer.from("not a jpeg")); }, /not a JPEG/);
  var truncated = fs.readFileSync(path.join(JPEG_DIR, "420.jpg")).slice(0, 1500);
  assert.throws(function () { jpegDc.decodeJpegDc(truncated); });
});

test("capture-format route switches between png and jpeg and clamps the quality", async function () {
  function call(url) {
    return new Promise(function (resolve) {
      ambilight.handleRequest({ url: url }, { writeHead: function () {}, end: function (text) { resolve(JSON.parse(text)); } });
    });
  }
  try {
    assert.equal((await call("/ambilight/capture-format")).format, "jpeg");
    assert.equal((await call("/ambilight/capture-format?mode=png")).format, "png");
    assert.equal((await call("/ambilight/capture-format?mode=jpeg&quality=45")).format, "jpeg");
    assert.equal((await call("/ambilight/capture-format?quality=500")).jpegQuality, 45);
    assert.equal((await call("/ambilight/capture-format?mode=bogus")).format, "jpeg");
  } finally {
    await call("/ambilight/capture-format?mode=jpeg&quality=60");
  }
});

// Same end to end run with the JPEG capture format: the fake capture service answers comp_type 1 with a
// half red, half blue JPEG, which must come out as a red bulb through jpeg-dc.cjs and the colour analysis.
test("a session on JPEG capture colours the bulb and reports its format", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var net = require("node:net");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  var jpeg = path.join(JPEG_DIR, "halves.jpg");
  fs.writeFileSync(path.join(dir, "gdbus"),
    '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\n' +
    'if [ "${13}" = 1 ]; then cp "' + jpeg + '" "$dir/$last.jpg"; else echo "png asked" >&2; exit 1; fi\n' +
    'echo "(0, 480, 270, \'$dir/$last.jpg\')"\n', { mode: 493 });
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
    assert.equal((await call("/ambilight/capture-format?mode=jpeg&quality=60")).body.format, "jpeg");
    await call("/ambilight/capture-tool?mode=gdbus");
    await call("/ambilight/start?level=100&assign=a:left:100");
    await new Promise(function (resolve) { setTimeout(resolve, 2600); });
    var colour = received.filter(function (m) { return m.command === 7 && m.dps["5"]; })[0];
    assert.ok(colour, "the bulb received a colour from the JPEG capture");
    var hue = parseInt(colour.dps["5"].slice(0, 4), 16);
    assert.ok(hue <= 8 || hue >= 352, "left edge is red, hue " + hue);
    var capture = (await call("/ambilight/state")).body.state.capture;
    assert.equal(capture.format, "jpeg");
    assert.equal(capture.picture, "60x34");
    assert.equal(capture.jpegFailures, 0);
  } finally {
    await call("/ambilight/stop");
    await call("/ambilight/capture-format?mode=jpeg&quality=60");
    await call("/ambilight/capture-tool?mode=busctl-sh");
    process.env.PATH = originalPath;
    try { fs.unlinkSync(BULBS_FILE); } catch (_) {}
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("describeJpeg reports frame type, sampling and scans", function () {
  var info = jpegDc.describeJpeg(fs.readFileSync(path.join(JPEG_DIR, "420.jpg")));
  assert.equal(info.frame.type, "SOF0");
  assert.equal(info.frame.w, 480);
  assert.deepEqual(info.frame.comps.map(function (c) { return c.h + "x" + c.v; }), ["2x2", "1x1", "1x1"]);
  assert.equal(info.scans, 1);
  assert.equal(jpegDc.describeJpeg(fs.readFileSync(path.join(JPEG_DIR, "prog.jpg"))).frame.type, "SOF2");
  assert.ok(jpegDc.describeJpeg(fs.readFileSync(path.join(JPEG_DIR, "rst.jpg"))).restartMarkers > 0);
});

test("jpeg-sample route captures one JPEG and reports structure and decode result", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  fs.writeFileSync(path.join(dir, "gdbus"),
    '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\ncp "' + path.join(JPEG_DIR, "420.jpg") + '" "$dir/$last.jpg"\necho "(0, 480, 270, \'$dir/$last.jpg\')"\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  try {
    var result = (await call("/ambilight/jpeg-sample")).body;
    assert.equal(result.ok, true);
    assert.equal(result.structure.frame.type, "SOF0");
    assert.equal(result.decoded.w, 60);
    assert.ok(result.decodeMs >= 0);
    assert.equal(result.decodeError, undefined);
  } finally {
    process.env.PATH = originalPath;
    try { fs.unlinkSync("/dev/shm/nuvio-sample.jpg"); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing JPEG capture falls back to PNG after three failures in a row", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  var picture = path.join(dir, "capture.png");
  fs.writeFileSync(picture, png(8, 4, function (x) { return x < 4 ? [200, 0, 0] : [0, 0, 100]; }));
  // refuses JPEG (comp_type 1), serves PNG
  fs.writeFileSync(path.join(dir, "gdbus"),
    '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\n' +
    'if [ "${13}" = 1 ]; then echo "capture refused" >&2; exit 1; fi\ncp "' + picture + '" "$dir/$last.png"\necho "(0, 320, 180, \'x\')"\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  fs.writeFileSync(BULBS_FILE, JSON.stringify([{ id: "a", name: "Desk left", key: KEY, ip: "127.0.0.1", pos: "center" }]));
  try {
    await call("/ambilight/capture-format?mode=jpeg");
    await call("/ambilight/capture-tool?mode=gdbus");
    await call("/ambilight/start?level=100&assign=a:left:100");
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    var snapshot = (await call("/ambilight/state")).body.state;
    assert.equal(snapshot.capture.format, "png");
    assert.ok(snapshot.errors.some(function (e) { return /switched off/.test(e); }), "the switch is noted");
    assert.ok(snapshot.captures > 0, "pictures keep arriving on PNG");
  } finally {
    await call("/ambilight/stop");
    await call("/ambilight/capture-format?mode=jpeg");
    await call("/ambilight/capture-tool?mode=busctl-sh");
    process.env.PATH = originalPath;
    try { fs.unlinkSync(BULBS_FILE); } catch (_) {}
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capture-tools benchmarks the tools that exist and reports the missing ones", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-"));
  var jpeg = path.join(JPEG_DIR, "420.jpg");
  // gdbus and dbus-send exist and write the capture; busctl does not exist on this "TV"
  fs.writeFileSync(path.join(dir, "gdbus"), '#!/bin/sh\n/bin/cp "' + jpeg + '" /dev/shm/nuvio-tool-probe.jpg\necho "(0, 480, 270, \'x\')"\n', { mode: 493 });
  fs.writeFileSync(path.join(dir, "dbus-send"), '#!/bin/sh\n/bin/cp "' + jpeg + '" /dev/shm/nuvio-tool-probe.jpg\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir; // only the fake tools: busctl must be missing
  try {
    var result = (await call("/ambilight/capture-tools?count=3")).body;
    var byName = {};
    result.tools.forEach(function (t) { byName[t.name] = t; });
    assert.equal(byName["gdbus (current)"].available, true);
    assert.equal(byName["gdbus (current)"].ok, 3);
    assert.equal(byName["gdbus (lean GIO environment)"].available, true);
    assert.equal(byName["dbus-send"].ok, 3);
    assert.equal(byName["busctl"].available, false);
    assert.ok(byName["dbus-send"].cpuVsCurrentPercent >= 0);
  } finally {
    process.env.PATH = originalPath;
    try { fs.unlinkSync("/dev/shm/nuvio-tool-probe.jpg"); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dbus-where reports what the service can see without failing", async function () {
  var result = (await call("/ambilight/dbus-where")).body;
  assert.equal(result.ok, true);
  assert.ok(result.dirs && typeof result.dirs === "object");
  assert.ok(Array.isArray(result.unixSockets));
});


test("busctl replies are parsed and the capture tool route switches tools", async function () {
  assert.deepEqual(internals.parseBusctlReply('iiis 0 480 270 "/dev/shm/nuvio-x.jpg"\n'), { ret: 0, w: 480, h: 270, path: "/dev/shm/nuvio-x.jpg" });
  assert.equal(internals.parseBusctlReply("Failed to call method"), null);
  try {
    assert.equal((await call("/ambilight/capture-tool")).body.tool, "busctl-sh");
    assert.equal((await call("/ambilight/capture-tool?mode=gdbus")).body.tool, "gdbus");
    assert.equal((await call("/ambilight/capture-tool?mode=busctl")).body.tool, "busctl");
    assert.equal((await call("/ambilight/capture-tool?mode=bogus")).body.tool, "busctl");
  } finally {
    await call("/ambilight/capture-tool?mode=busctl-sh");
  }
});

function startFakeBulb() {
  var net = require("node:net");
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
  return new Promise(function (resolve) {
    server.listen(6668, "127.0.0.1", function () { resolve({ received: received, close: function () { server.close(); } }); });
  });
}

test("without a shell on the PATH a session falls back from busctl-sh to busctl and colours the bulb", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  // a fake busctl: writes the JPEG named by its last arguments and prints the reply the way busctl does
  fs.writeFileSync(path.join(dir, "busctl"),
    '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\n/bin/cp "' + path.join(JPEG_DIR, "halves.jpg") + '" "$dir/$last.jpg"\n' +
    'echo "iiis 0 480 270 \\"$dir/$last.jpg\\""\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir; // no gdbus: only busctl can serve the capture
  var bulb = await startFakeBulb();
  fs.writeFileSync(BULBS_FILE, JSON.stringify([{ id: "a", name: "Desk left", key: KEY, ip: "127.0.0.1", pos: "center" }]));
  try {
    await call("/ambilight/capture-format?mode=jpeg");
    await call("/ambilight/start?level=100&assign=a:left:100");
    await new Promise(function (resolve) { setTimeout(resolve, 2600); });
    var colour = bulb.received.filter(function (m) { return m.command === 7 && m.dps["5"]; })[0];
    assert.ok(colour, "the bulb received a colour through busctl");
    var snapshot = (await call("/ambilight/state")).body.state;
    assert.equal(snapshot.capture.tool, "busctl");
    assert.ok(snapshot.errors.some(function (e) { return /busctl-sh capture switched off/.test(e); }));
    var capture = snapshot.capture;
    assert.equal(capture.format, "jpeg");
  } finally {
    await call("/ambilight/stop");
    process.env.PATH = originalPath;
    try { fs.unlinkSync(BULBS_FILE); } catch (_) {}
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    bulb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a TV without busctl falls back to gdbus at once and keeps capturing", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  fs.writeFileSync(path.join(dir, "gdbus"),
    '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\n/bin/cp "' + path.join(JPEG_DIR, "halves.jpg") + '" "$dir/$last.jpg"\n' +
    'echo "(0, 480, 270, \'$dir/$last.jpg\')"\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir; // gdbus only
  var bulb = await startFakeBulb();
  fs.writeFileSync(BULBS_FILE, JSON.stringify([{ id: "a", name: "Desk left", key: KEY, ip: "127.0.0.1", pos: "center" }]));
  try {
    await call("/ambilight/capture-format?mode=jpeg");
    await call("/ambilight/capture-tool?mode=busctl-sh");
    await call("/ambilight/start?level=100&assign=a:left:100");
    await new Promise(function (resolve) { setTimeout(resolve, 2600); });
    var state = (await call("/ambilight/state")).body.state;
    assert.equal(state.capture.tool, "gdbus");
    assert.ok(state.errors.some(function (e) { return /busctl capture switched off/.test(e); }));
    assert.ok(state.captures > 0);
    assert.ok(bulb.received.some(function (m) { return m.command === 7 && m.dps["5"]; }), "the bulb still got colours");
  } finally {
    await call("/ambilight/stop");
    await call("/ambilight/capture-tool?mode=busctl-sh");
    process.env.PATH = originalPath;
    try { fs.unlinkSync(BULBS_FILE); } catch (_) {}
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    bulb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("periodic-probe starts the periodic capture, reports new files and bus traffic, and ends it", { skip: process.platform !== "linux" }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "periodic-"));
  var marker = "/tmp/nuvio-periodic-test-" + process.pid + ".png";
  var log = path.join(dir, "calls.log");
  // a fake busctl: logs each call, "creates a picture" when the periodic capture starts, prints monitor output
  fs.writeFileSync(path.join(dir, "busctl"),
    '#!/bin/sh\necho "$@" >> "' + log + '"\n' +
    'case "$*" in\n *StartPeriodicCaptureWithoutAppInfo*) echo x > "' + marker + '"; echo "" ;;\n *monitor*) echo "Monitoring bus message stream."; echo "Type=signal Member=Captured" ;;\nesac\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  try {
    var result = (await call("/ambilight/periodic-probe?seconds=1&id=probe-test")).body;
    assert.equal(result.ok, true);
    assert.equal(result.tool, "busctl");
    assert.ok(result.newFiles.some(function (f) { return f.file === marker; }), "the new picture file is found");
    assert.match(result.monitor.tail, /Member=Captured/);
    var calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /StartPeriodicCaptureWithoutAppInfo iiiisi 0 2 64 36 probe-test 300/);
    assert.match(calls, /EndPeriodicCapture isi 0 probe-test 0/, "the periodic capture is always ended");
  } finally {
    process.env.PATH = originalPath;
    try { fs.unlinkSync(marker); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("a session captures through long-lived capture shells and the CPU figure includes them", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  var log = path.join(dir, "busctl.log");
  fs.writeFileSync(path.join(dir, "busctl"),
    '#!/bin/sh\necho "$PPID" >> "' + log + '"\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\n/bin/cp "' + path.join(JPEG_DIR, "halves.jpg") + '" "$dir/$last.jpg"\n' +
    'echo "iiis 0 480 270 \\"$dir/$last.jpg\\""\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  var bulb = await startFakeBulb();
  fs.writeFileSync(BULBS_FILE, JSON.stringify([{ id: "a", name: "Desk left", key: KEY, ip: "127.0.0.1", pos: "center" }]));
  try {
    await call("/ambilight/capture-format?mode=jpeg");
    await call("/ambilight/capture-tool?mode=busctl-sh");
    await call("/ambilight/start?level=100&assign=a:left:100");
    await new Promise(function (resolve) { setTimeout(resolve, 2600); });
    var state = (await call("/ambilight/state")).body.state;
    assert.equal(state.capture.tool, "busctl-sh");
    assert.ok(state.captures >= 3, "several captures arrived");
    assert.ok(bulb.received.some(function (m) { return m.command === 7 && m.dps["5"]; }), "the bulb got colours");
    var parents = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    var distinct = {};
    parents.forEach(function (pid) { distinct[pid] = 1; });
    assert.ok(parents.length >= 3, "busctl ran for each capture");
    assert.ok(Object.keys(distinct).length <= 3, "from at most one shell per capture worker, not from Node: " + Object.keys(distinct).join(","));
    assert.ok(distinct[String(process.pid)] === undefined, "Node itself never started busctl");
  } finally {
    await call("/ambilight/stop");
    process.env.PATH = originalPath;
    try { fs.unlinkSync(BULBS_FILE); } catch (_) {}
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    bulb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bus-proxy-probe hands a socket to the proxy, says Hello through it and makes captures", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var fake = require("./helpers/fake-dbus.cjs");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-"));
  // a stand-in systemd-bus-proxyd: its stdin/stdout is the accepted socket, bridged to a stand-in bus
  var script = path.join(dir, "fake-proxyd.cjs");
  fs.writeFileSync(script,
    'var net = require("net");\nvar up = net.connect(process.argv[2]);\n' +
    'var sock = new net.Socket({ fd: 0, readable: true, writable: true });\nsock.pipe(up);\nup.pipe(sock);\n' +
    'up.on("close", function () { process.exit(0); });\n');
  var bus = await fake.fakeBus({
    answer: function (msg) {
      if (msg.fields[3] === "Hello") return fake.withReplySerial(fake.hex(fake.GOLDEN_HELLO), msg.serial);
      if (msg.fields[3] === "RequestCaptureToFileSync") {
        fs.copyFileSync(path.join(JPEG_DIR, "420.jpg"), "/dev/shm/nuvio-bus-proxy.jpg");
        return fake.withReplySerial(fake.hex(fake.GOLDEN_RETURN), msg.serial);
      }
      return fake.withReplySerial(fake.hex(fake.GOLDEN_ERROR), msg.serial);
    }
  });
  internals.setProxyCandidates([{ path: process.execPath, args: [script, bus.path] }]);
  try {
    var result = (await call("/ambilight/bus-proxy-probe?count=4")).body;
    assert.equal(result.ok, true);
    assert.equal(result.attempts.length, 1);
    var attempt = result.attempts[0];
    assert.equal(attempt.stage, "captured", JSON.stringify(attempt));
    assert.equal(attempt.uniqueName, ":1.9");
    assert.equal(attempt.captures.ok, 4);
    assert.ok(result.success, "a working proxy is reported");
  } finally {
    internals.setProxyCandidates(null);
    bus.close();
    try { fs.unlinkSync("/dev/shm/nuvio-bus-proxy.jpg"); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bus-proxy-probe reports when no proxy binary exists", { skip: process.platform !== "linux" }, async function () {
  internals.setProxyCandidates([]);
  try {
    var result = (await call("/ambilight/bus-proxy-probe")).body;
    assert.equal(result.success, null);
    assert.match(result.note, /no executable/);
  } finally {
    internals.setProxyCandidates(null);
  }
});

test("capture-bench tries each setting, reports what came back and skips refused ones", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  // a fake busctl: refuses app_type 3, otherwise writes a JPEG and answers like busctl does
  fs.writeFileSync(path.join(dir, "busctl"),
    '#!/bin/sh\nfor last; do :; done\neval "dir=\\\${$(($# - 1))}"\n' +
    'if [ "${8}" = 3 ]; then echo "refused" >&2; exit 1; fi\n' +
    '/bin/cp "' + path.join(JPEG_DIR, "420.jpg") + '" "$dir/$last.jpg"\necho "iiis 0 480 270 \\"$dir/$last.jpg\\""\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  try {
    var result = (await call("/ambilight/capture-bench?group=modes&count=2")).body;
    assert.equal(result.rows.length, 7);
    var ok = result.rows.filter(function (r) { return !r.error; });
    assert.equal(ok.length, 6);
    assert.equal(ok[0].got, "480x270");
    assert.equal(ok[0].format, "JPEG");
    assert.ok(ok[0].dcDecodeMs >= 0);
    assert.ok(ok[0].msPerCapture >= 0);
    var refused = result.rows.filter(function (r) { return r.error; });
    assert.equal(refused.length, 1);
    assert.equal(refused[0].appType, 3);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fb-check lists the graphics device files and tries to open the framebuffer without failing", async function () {
  var result = (await call("/ambilight/fb-check")).body;
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.devices));
  assert.equal(result.opens.length, 4);
  assert.ok(result.opens.every(function (o) { return typeof o.opened === "boolean"; }));
});

test("capture-image serves one capture as a JPEG for viewing", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "view-"));
  fs.writeFileSync(path.join(dir, "busctl"),
    '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\n/bin/cp "' + path.join(JPEG_DIR, "420.jpg") + '" "$dir/$last.jpg"\necho "iiis 0 480 270 \\"$dir/$last.jpg\\""\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  try {
    var captured = await new Promise(function (resolve) {
      var headers = {};
      ambilight.handleRequest({ url: "/ambilight/capture-image?mode=1" }, {
        writeHead: function (status, h) { headers.status = status; headers.type = h["Content-Type"]; },
        end: function (data) { resolve({ headers: headers, data: data }); }
      });
    });
    assert.equal(captured.headers.status, 200);
    assert.equal(captured.headers.type, "image/jpeg");
    assert.equal(captured.data[0], 0xff);
    assert.equal(captured.data[1], 0xd8);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a session reports how much of Node's CPU is its own JavaScript", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  fs.writeFileSync(path.join(dir, "gdbus"),
    '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\n/bin/cp "' + path.join(JPEG_DIR, "halves.jpg") + '" "$dir/$last.jpg"\necho "(0, 480, 270, \'$dir/$last.jpg\')"\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  var bulb = await startFakeBulb();
  fs.writeFileSync(BULBS_FILE, JSON.stringify([{ id: "a", name: "Desk left", key: KEY, ip: "127.0.0.1", pos: "center" }]));
  try {
    await call("/ambilight/capture-format?mode=jpeg");
    await call("/ambilight/capture-tool?mode=gdbus");
    await call("/ambilight/start?level=100&assign=a:left:100");
    await new Promise(function (resolve) { setTimeout(resolve, 2600); });
    var capture = (await call("/ambilight/state")).body.state.capture;
    assert.ok(capture.jsBusy, "jsBusy is reported");
    assert.ok(capture.jsBusy.decode >= 0 && capture.jsBusy.analyse > 0 && capture.jsBusy.tick >= 0);
    assert.ok(Math.abs(capture.jsBusy.total - (capture.jsBusy.decode + capture.jsBusy.analyse + capture.jsBusy.tick)) < 0.5);
    assert.ok(capture.cpuSplit && typeof capture.cpuSplit.node === "number");
  } finally {
    await call("/ambilight/stop");
    await call("/ambilight/capture-tool?mode=busctl-sh");
    process.env.PATH = originalPath;
    try { fs.unlinkSync(BULBS_FILE); } catch (_) {}
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    bulb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capture-compare serves a page with the four modes side by side", async function () {
  var page = await new Promise(function (resolve) {
    var headers = {};
    ambilight.handleRequest({ url: "/ambilight/capture-compare?quality=80" }, {
      writeHead: function (status, h) { headers.status = status; headers.type = h["Content-Type"]; },
      end: function (html) { resolve({ headers: headers, html: String(html) }); }
    });
  });
  assert.equal(page.headers.status, 200);
  assert.match(page.headers.type, /text\/html/);
  [0, 1, 2, 3].forEach(function (m) { assert.ok(page.html.indexOf("capture-image?mode=" + m + "&quality=80") > 0, "mode " + m); });
});

test("the capture mode is switchable and reaches both the shell and the command line tools", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-"));
  var log = path.join(dir, "args.log");
  // fake busctl: logs the capture_mode argument (9th: after --system call dest path iface method sig app_type)
  fs.writeFileSync(path.join(dir, "busctl"),
    '#!/bin/sh\necho "mode=${9}" >> "' + log + '"\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\n/bin/cp "' + path.join(JPEG_DIR, "420.jpg") + '" "$dir/$last.jpg"\necho "iiis 0 480 270 \\"$dir/$last.jpg\\""\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  try {
    assert.equal((await call("/ambilight/capture-mode")).body.captureMode, 3, "3 is the default (about twice as fast under playback)");
    assert.equal((await call("/ambilight/capture-mode?mode=2")).body.captureMode, 2);
    assert.equal((await call("/ambilight/capture-mode?mode=9")).body.captureMode, 2, "out of range is ignored");
    assert.equal((await call("/ambilight/capture-mode?mode=1.5")).body.captureMode, 2);
    assert.equal((await call("/ambilight/capture-mode?mode=3")).body.captureMode, 3);
    // through a long-lived shell
    var shell = new internals.CaptureShell();
    var viaShell = await new Promise(function (resolve) { shell.run(1, 40, "mode-test", function (error, text) { resolve({ error: error, text: text }); }); });
    shell.kill();
    assert.equal(viaShell.error, null);
    assert.match(fs.readFileSync(log, "utf8"), /mode=3/);
  } finally {
    await call("/ambilight/capture-mode?mode=3");
    process.env.PATH = originalPath;
    try { fs.unlinkSync("/dev/shm/mode-test.jpg"); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("jpeg-dc decodes noisy, high-entropy pictures (long Huffman codes, restart markers) to the true block averages", function () {
  var data = fs.readFileSync(path.join(JPEG_DIR, "noisy.jpg"));
  var expected = JSON.parse(fs.readFileSync(path.join(JPEG_DIR, "noisy.blocks.json"), "utf8")); // block means from an independent decoder
  var image = jpegDc.decodeJpegDc(data);
  assert.equal(image.w, 30);
  assert.equal(image.h, 17);
  var sum = 0, worst = 0, n = 0;
  for (var y = 0; y < 17; y++) {
    for (var x = 0; x < 30; x++) {
      for (var k = 0; k < 3; k++) {
        var error = Math.abs(image.data[(y * 30 + x) * 3 + k] - expected[y][x][k]);
        sum += error; n++;
        if (error > worst) worst = error;
      }
    }
  }
  // the independent decoder clips pixel values to 0-255 before averaging, a block average does not: small extra differences
  assert.ok(sum / n < 1.5, "mean error " + (sum / n));
  assert.ok(worst < 16, "worst error " + worst);
});


test("the checked JPEG decoder compares fast and reference on the first pictures and falls back for good on a disagreement", function () {
  var bytes = fs.readFileSync(path.join(JPEG_DIR, "420.jpg"));
  var state = internals.jpegDecoder;
  var original = jpegDc.decodeJpegDc;
  function reset() { state.useReference = false; state.checked = 0; state.mismatch = null; }
  try {
    // healthy: the fast decoder is used and checked against the reference
    reset();
    var good = internals.decodeJpegChecked(bytes);
    assert.equal(state.useReference, false);
    assert.equal(state.checked, 1);
    assert.equal(good.w, 60);

    // a fast decoder that returns wrong pixels is caught and replaced by the reference for good
    reset();
    jpegDc.decodeJpegDc = function (data) { var image = original(data); image.data[10] = (image.data[10] + 50) & 255; return image; };
    var corrected = internals.decodeJpegChecked(bytes);
    assert.equal(state.useReference, true);
    assert.match(state.mismatch, /disagree/);
    assert.deepEqual(Array.from(corrected.data), Array.from(good.data), "the reference result is returned");
    jpegDc.decodeJpegDc = original;
    assert.deepEqual(Array.from(internals.decodeJpegChecked(bytes).data), Array.from(good.data), "and it stays on the reference");

    // a fast decoder that throws on a file the reference can read
    reset();
    jpegDc.decodeJpegDc = function () { throw new Error("boom"); };
    var viaReference = internals.decodeJpegChecked(bytes);
    assert.equal(state.useReference, true);
    assert.match(state.mismatch, /threw: .*boom/);
    assert.equal(viaReference.w, 60);

    // a file that is bad for both decoders is an error, not a reason to blame the optimisation
    reset();
    jpegDc.decodeJpegDc = original;
    assert.throws(function () { internals.decodeJpegChecked(Buffer.from("not a jpeg at all")); });
    assert.equal(state.useReference, false);
  } finally {
    jpegDc.decodeJpegDc = original;
    reset();
  }
});

test("state reports the decoder in use and the mean colour of the last picture", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  fs.writeFileSync(path.join(dir, "gdbus"),
    '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\n/bin/cp "' + path.join(JPEG_DIR, "halves.jpg") + '" "$dir/$last.jpg"\necho "(0, 480, 270, \'$dir/$last.jpg\')"\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  var bulb = await startFakeBulb();
  fs.writeFileSync(BULBS_FILE, JSON.stringify([{ id: "a", name: "Desk left", key: KEY, ip: "127.0.0.1", pos: "center" }]));
  try {
    await call("/ambilight/capture-format?mode=jpeg");
    await call("/ambilight/capture-tool?mode=gdbus");
    await call("/ambilight/start?level=100&assign=a:left:100");
    await new Promise(function (resolve) { setTimeout(resolve, 2600); });
    var capture = (await call("/ambilight/state")).body.state.capture;
    assert.equal(capture.jpegDecoder.decoder, "fast");
    assert.ok(capture.jpegDecoder.checked >= 1);
    // half red (200,0,0), half blue (0,0,100): the mean is about (100, 0, 50)
    assert.ok(Math.abs(capture.meanColour[0] - 100) < 15 && capture.meanColour[1] < 10 && Math.abs(capture.meanColour[2] - 50) < 15, "mean " + capture.meanColour);
  } finally {
    await call("/ambilight/stop");
    await call("/ambilight/capture-tool?mode=busctl-sh");
    process.env.PATH = originalPath;
    try { fs.unlinkSync(BULBS_FILE); } catch (_) {}
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    bulb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the capture worker count can be changed live and the state reports the last seconds", { skip: process.platform !== "linux" || !fs.existsSync("/dev/shm") }, async function () {
  var os = require("node:os");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambilight-"));
  fs.writeFileSync(path.join(dir, "gdbus"),
    '#!/bin/sh\nfor last; do :; done\neval "dir=\\${$(($# - 1))}"\n/bin/cp "' + path.join(JPEG_DIR, "halves.jpg") + '" "$dir/$last.jpg"\necho "(0, 480, 270, \'$dir/$last.jpg\')"\n', { mode: 493 });
  var originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  var bulb = await startFakeBulb();
  fs.writeFileSync(BULBS_FILE, JSON.stringify([{ id: "a", name: "Desk left", key: KEY, ip: "127.0.0.1", pos: "center" }]));
  try {
    assert.equal((await call("/ambilight/capture-workers")).body.workers, 3);
    assert.equal((await call("/ambilight/capture-workers?count=99")).body.workers, 3, "out of range is ignored");
    assert.equal((await call("/ambilight/capture-workers?count=2.5")).body.workers, 3);
    await call("/ambilight/capture-format?mode=jpeg");
    await call("/ambilight/capture-tool?mode=gdbus");
    await call("/ambilight/eco?mode=off");
    await call("/ambilight/start?level=100&assign=a:left:100");
    await new Promise(function (resolve) { setTimeout(resolve, 2600); });
    var before = (await call("/ambilight/state")).body.state;
    assert.equal(before.capture.workers, 3);
    assert.ok(before.capture.recent, "recent figures after a few seconds");
    assert.ok(before.capture.recent.perSecond > 0);
    assert.ok(before.capture.recent.cpuPercent >= 0 && before.capture.recent.cpuPercent < 1000, "a percentage, not a thousandth: " + before.capture.recent.cpuPercent);
    assert.ok(before.capture.recent.nodePercent < 1000 && before.capture.recent.ambilightJsPercent < 1000);
    assert.ok(Math.abs(before.capture.recent.ambilightJsPercent - (before.capture.recent.decodePercent + before.capture.recent.analysePercent + before.capture.recent.tickPercent)) < 0.5);
    // raise the count live: the extra loops start without a restart
    assert.equal((await call("/ambilight/capture-workers?count=6")).body.workers, 6);
    await new Promise(function (resolve) { setTimeout(resolve, 1000); });
    var raised = (await call("/ambilight/state")).body.state;
    assert.equal(raised.capture.workers, 6);
    assert.equal(Object.keys(ambilight._internals.activeLoopsForTest()).length, 6);
    // lower it: surplus loops end by themselves
    assert.equal((await call("/ambilight/capture-workers?count=2")).body.workers, 2);
    await new Promise(function (resolve) { setTimeout(resolve, 1200); });
    assert.equal(Object.keys(ambilight._internals.activeLoopsForTest()).length, 2);
  } finally {
    await call("/ambilight/stop");
    await call("/ambilight/capture-workers?count=3");
    await call("/ambilight/capture-rate?max=15");
    await call("/ambilight/eco?mode=on");
    await call("/ambilight/capture-tool?mode=busctl-sh");
    process.env.PATH = originalPath;
    try { fs.unlinkSync(BULBS_FILE); } catch (_) {}
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    bulb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("the picture rate cap paces the capture loops and can be changed live", async function () {
  // loops resting between captures: workers / target rate, minus the time the capture itself took
  assert.equal(internals.paceDelayFor(3, 0, 0, 100), 0, "no eco rate and no cap: flat out");
  assert.equal(internals.paceDelayFor(3, 0, 15, 100), 100, "3 loops at 15/s: 200 ms per cycle, 100 ms already used");
  assert.equal(internals.paceDelayFor(3, 0, 15, 250), 0, "a capture slower than the cycle does not wait");
  assert.equal(internals.paceDelayFor(3, 6, 15, 0), 500, "the eco rate wins when lower than the cap");
  assert.equal(internals.paceDelayFor(3, 20, 15, 0), 200, "the cap wins when lower than the eco rate");
  assert.equal(internals.paceDelayFor(5, 3, 0, 0), 1667, "eco alone");
  try {
    assert.equal((await call("/ambilight/capture-rate")).body.maxPerSecond, 15, "capped at 15/s by default");
    assert.equal((await call("/ambilight/capture-rate?max=25")).body.maxPerSecond, 25);
    assert.equal((await call("/ambilight/capture-rate?max=999")).body.maxPerSecond, 25, "out of range is ignored");
    assert.equal((await call("/ambilight/capture-rate?max=7.5")).body.maxPerSecond, 25);
    assert.equal((await call("/ambilight/capture-rate?max=0")).body.maxPerSecond, 0, "0 removes the cap");
  } finally {
    await call("/ambilight/capture-rate?max=15");
  }
});
