"use strict";

// Shared by the D-Bus tests: byte-exact messages from an independent implementation (dbus-fast) and a stand-in bus.
var assert = require("node:assert/strict");
var fs = require("node:fs");
var net = require("node:net");
var os = require("node:os");
var path = require("node:path");
var lite = require("../../services/tizen/runtime/dbus-lite.cjs");
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


module.exports = { GOLDEN_CALL: GOLDEN_CALL, GOLDEN_RETURN: GOLDEN_RETURN, GOLDEN_ERROR: GOLDEN_ERROR, GOLDEN_ARRAY: GOLDEN_ARRAY,
  GOLDEN_HELLO: GOLDEN_HELLO, CAPTURE: CAPTURE, hex: hex, withReplySerial: withReplySerial, fakeBus: fakeBus };
