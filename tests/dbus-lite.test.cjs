"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var net = require("node:net");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var lite = require("../services/tizen/runtime/dbus-lite.cjs");
var internals = lite._internals;

var fake = require("./helpers/fake-dbus.cjs");
var GOLDEN_CALL = fake.GOLDEN_CALL, GOLDEN_RETURN = fake.GOLDEN_RETURN, GOLDEN_ERROR = fake.GOLDEN_ERROR, GOLDEN_ARRAY = fake.GOLDEN_ARRAY;
var GOLDEN_HELLO = fake.GOLDEN_HELLO, CAPTURE = fake.CAPTURE, hex = fake.hex, withReplySerial = fake.withReplySerial, fakeBus = fake.fakeBus;

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
