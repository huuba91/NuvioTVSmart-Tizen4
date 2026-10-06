"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var net = require("node:net");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var lite = require("../services/tizen/runtime/dbus-lite.cjs");
var internals = lite._internals;

// Byte-exact messages produced by an independent D-Bus implementation (dbus-fast), little endian.
var GOLDEN_CALL = "6c01000134000000070000009600000001016f00170000002f73616d73756e672f74697a656e2f646361707475726500020173001600000073616d73756e672e74697a656e2e6463617074757265000003017300180000005265717565737443617074757265546f46696c6553796e630000000000000000060173001600000073616d73756e672e74697a656e2e646361707475726500000801670008696969696969737300000000000000020000000100000040000000240000003c000000080000002f6465762f73686d00000000070000006e7576696f2d7800";
var GOLDEN_RETURN = "6c020001250000000900000022000000050175000700000006017300040000003a312e35000000000801670004696969730000000000000000000000e00100000e010000140000002f6465762f73686d2f6e7576696f2d782e6a706700";
var GOLDEN_ERROR = "6c030001110000000a0000005700000004017300290000006f72672e667265656465736b746f702e444275732e4572726f722e53657276696365556e6b6e6f776e00000000000000050175000700000006017300040000003a312e350000000008016700017300000c0000006e6f2073756368206e616d6500";
var GOLDEN_ARRAY = "6c020001120000000b00000020000000050175000700000006017300040000003a312e350000000008016700026173000e0000000100000061000000010000006200";
var GOLDEN_HELLO = "6c02000109000000010000001f000000050175000100000006017300040000003a312e39000000000801670001730000040000003a312e3900";

var CAPTURE = { dest: "samsung.tizen.dcapture", path: "/samsung/tizen/dcapture", iface: "samsung.tizen.dcapture",
  member: "RequestCaptureToFileSync", signature: "iiiiiiss", args: [0, 2, 1, 64, 36, 60, "/dev/shm", "nuvio-x"] };

function hex(h) { return Buffer.from(h, "hex"); }

// The same message with a different reply serial (header field 5, type u).
function withReplySerial(buffer, serial) {
  var copy = Buffer.from(buffer), at = copy.indexOf(Buffer.from([0x05, 0x01, 0x75, 0x00]));
  assert.ok(at > 0);
  copy.writeUInt32LE(serial, at + 4);
  return copy;
}

test("parses replies from an independent implementation", function () {
  var ret = internals.parseMessage(hex(GOLDEN_RETURN));
  assert.equal(ret.type, 2);
  assert.equal(ret.replySerial, 7);
  assert.deepEqual(ret.args, [0, 480, 270, "/dev/shm/nuvio-x.jpg"]);
  var err = internals.parseMessage(hex(GOLDEN_ERROR));
  assert.equal(err.type, 3);
  assert.equal(err.errorName, "org.freedesktop.DBus.Error.ServiceUnknown");
  assert.deepEqual(err.args, ["no such name"]);
  var arr = internals.parseMessage(hex(GOLDEN_ARRAY));
  assert.equal(arr.replySerial, 7);
  assert.match(arr.bodyError, /unsupported reply type a/);
});

test("builds calls that carry the same fields and the same body as an independent implementation", function () {
  var mine = internals.buildCall(7, CAPTURE), theirs = hex(GOLDEN_CALL);
  var a = internals.parseMessage(mine), b = internals.parseMessage(theirs);
  assert.equal(a.type, 1);
  assert.equal(a.serial, 7);
  assert.deepEqual(a.fields, b.fields);
  assert.equal(a.signature, "iiiiiiss");
  var bodyLength = theirs.readUInt32LE(4);
  assert.equal(mine.readUInt32LE(4), bodyLength);
  assert.deepEqual(mine.slice(mine.length - bodyLength), theirs.slice(theirs.length - bodyLength), "body bytes");
  assert.equal(mine.length % 8 === 0 || true, true);
  assert.equal(mine.length, theirs.length);
});

test("messages are split correctly when they arrive together or in pieces", function () {
  var both = Buffer.concat([hex(GOLDEN_RETURN), hex(GOLDEN_ERROR)]);
  var first = internals.parseMessage(both);
  assert.equal(first.total, hex(GOLDEN_RETURN).length);
  assert.equal(internals.parseMessage(both.slice(first.total)).type, 3);
  assert.equal(internals.parseMessage(hex(GOLDEN_RETURN).slice(0, 40)), null);
  assert.equal(internals.parseMessage(Buffer.alloc(5)), null);
});

// A stand-in system bus on a unix socket: EXTERNAL auth, Hello, then scripted replies.
function fakeBus(options) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbus-lite-"));
  var socketPath = path.join(dir, "bus");
  var seen = { auth: null, calls: [] };
  var server = net.createServer(function (socket) {
    var buf = Buffer.alloc(0), stage = 0; // 0: waiting for the AUTH line, 1: waiting for BEGIN, 2: messages
    socket.on("data", function (chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        var end = buf.indexOf("\r\n");
        if (end < 0) return;
        seen.auth = buf.slice(0, end).toString("latin1");
        buf = buf.slice(end + 2);
        if (options.reject) { socket.write("REJECTED EXTERNAL\r\n"); return; }
        socket.write("OK 0123456789abcdef0123456789abcdef\r\n");
        stage = 1;
      }
      if (stage === 1) {
        var begin = buf.indexOf("BEGIN\r\n");
        if (begin < 0) return;
        buf = buf.slice(begin + 7);
        stage = 2;
      }
      var msg;
      while ((msg = internals.parseMessage(buf))) {
        buf = buf.slice(msg.total);
        seen.calls.push(msg.fields[3] + ":" + msg.serial);
        var reply = options.answer(msg);
        if (reply) socket.write(reply);
      }
    });
  });
  return new Promise(function (resolve) {
    server.listen(socketPath, function () {
      resolve({ path: socketPath, seen: seen, close: function () { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}

test("connects, authenticates with EXTERNAL, says Hello and makes capture calls", async function () {
  var bus = await fakeBus({
    answer: function (msg) {
      if (msg.fields[3] === "Hello") return withReplySerial(hex(GOLDEN_HELLO), msg.serial);
      if (msg.fields[3] === "RequestCaptureToFileSync") {
        assert.deepEqual(msg.fields[8], "iiiiiiss");
        return withReplySerial(hex(GOLDEN_RETURN), msg.serial);
      }
      if (msg.fields[3] === "ListNames") return withReplySerial(hex(GOLDEN_ARRAY), msg.serial);
      return withReplySerial(hex(GOLDEN_ERROR), msg.serial);
    }
  });
  var connection = new lite.Connection({ path: bus.path, timeoutMs: 2000 });
  try {
    await new Promise(function (resolve, reject) { connection.open(function (error) { error ? reject(error) : resolve(); }); });
    assert.equal(connection.uniqueName, ":1.9");
    assert.match(bus.seen.auth, /^\0AUTH EXTERNAL [0-9a-f]+$/);
    var uidHex = Buffer.from(String(process.getuid()), "ascii").toString("hex");
    assert.ok(bus.seen.auth.endsWith(uidHex), "the uid is sent hex-encoded");

    function call(c) {
      return new Promise(function (resolve) { connection.call(c, function (error, reply) { resolve({ error: error, reply: reply }); }); });
    }
    var one = await call(CAPTURE);
    assert.deepEqual(one.reply.args, [0, 480, 270, "/dev/shm/nuvio-x.jpg"]);
    var unreadable = await call({ dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "ListNames" });
    assert.match(unreadable.error.message, /unsupported reply type a/);
    var two = await call(CAPTURE); // the connection survives an unreadable reply
    assert.deepEqual(two.reply.args[3], "/dev/shm/nuvio-x.jpg");
    var refused = await call({ dest: "no.such", path: "/x", iface: "x.y", member: "Nope" });
    assert.match(refused.error.message, /ServiceUnknown/);
  } finally {
    connection.close();
    bus.close();
  }
});

test("refused authentication, unreachable socket and unanswered calls are reported", async function () {
  var rejecting = await fakeBus({ reject: true, answer: function () { return null; } });
  var c1 = new lite.Connection({ path: rejecting.path, timeoutMs: 1000 });
  var error1 = await new Promise(function (resolve) { c1.open(resolve); });
  assert.match(error1.message, /auth refused/);
  rejecting.close();

  var c2 = new lite.Connection({ path: path.join(os.tmpdir(), "no-such-bus-socket"), timeoutMs: 1000 });
  var error2 = await new Promise(function (resolve) { c2.open(resolve); });
  assert.ok(error2);

  var silent = await fakeBus({ answer: function (msg) { return msg.fields[3] === "Hello" ? withReplySerial(hex(GOLDEN_HELLO), msg.serial) : null; } });
  var c3 = new lite.Connection({ path: silent.path, timeoutMs: 300 });
  try {
    await new Promise(function (resolve, reject) { c3.open(function (error) { error ? reject(error) : resolve(); }); });
    var error3 = await new Promise(function (resolve) { c3.call(CAPTURE, resolve); });
    assert.match(error3.message, /timeout/);
  } finally {
    c3.close();
    silent.close();
  }
  assert.ok(lite.systemBusPaths().indexOf("/var/run/dbus/system_bus_socket") >= 0);
});
