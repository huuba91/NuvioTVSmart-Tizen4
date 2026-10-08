"use strict";

var assert = require("node:assert/strict");
var test = require("node:test");
var ddp = require("../services/tizen/runtime/ddp-packet.cjs");
var vectors = require("./fixtures/ddp-vectors.json").vectors;

test("every fixture vector builds byte for byte (shared with any other DDP sender)", function () {
  assert.ok(vectors.length >= 6);
  vectors.forEach(function (vector) {
    var payload = ddp.buildPayload(vector.zones);
    assert.equal(payload.toString("hex"), vector.payloadHex, vector.name + " payload");
    assert.equal(
      ddp.buildPacket(payload, vector.sequence).toString("hex"),
      vector.packetHex,
      vector.name + " packet"
    );
    assert.equal(
      ddp.buildZonePacket(vector.zones, vector.sequence).toString("hex"),
      vector.packetHex,
      vector.name
    );
  });
});

test("the fixture itself follows the DDP layout (written out by hand, not by the builder)", function () {
  var red = vectors.filter(function (v) {
    return v.name === "all red";
  })[0];
  var expected = "41" + "02" + "01" + "01" + "00000000" + "0030";
  for (var i = 0; i < 8; i++) expected += "ff0000" + "000000";
  assert.equal(red.packetHex, expected);
  vectors.forEach(function (vector) {
    var bytes = Buffer.from(vector.packetHex, "hex");
    assert.equal(bytes.length, 58, vector.name);
    assert.equal(bytes[0], 0x41);
    assert.ok(bytes[1] >= 1 && bytes[1] <= 15, vector.name + " sequence");
    assert.equal(bytes[2], 0x01);
    assert.equal(bytes[3], 0x01);
    assert.equal(bytes.readUInt32BE(4), 0);
    assert.equal(bytes.readUInt16BE(8), 48);
    for (var p = 1; p < 16; p += 2) {
      assert.deepEqual(
        Array.from(bytes.slice(10 + p * 3, 13 + p * 3)),
        [0, 0, 0],
        vector.name + " odd pixel " + p
      );
    }
  });
});

test("sequence numbers run 1..15 and wrap, never 0", function () {
  var seq = 0,
    seen = [];
  for (var i = 0; i < 31; i++) {
    seq = ddp.nextSequence(seq);
    seen.push(seq);
  }
  assert.deepEqual(seen.slice(0, 16), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1]);
  assert.ok(
    seen.every(function (s) {
      return s >= 1 && s <= 15;
    })
  );
  assert.equal(ddp.buildPacket(ddp.buildPayload(ddp.blackZones()), 16)[1], 1);
  assert.equal(ddp.buildPacket(ddp.buildPayload(ddp.blackZones()), 0)[1], 1);
});

test("missing or bad zone values become black instead of throwing", function () {
  var payload = ddp.buildPayload([[NaN, "x", 12], null]);
  assert.equal(payload.length, ddp.PAYLOAD_LENGTH);
  assert.deepEqual(Array.from(payload.slice(0, 3)), [0, 0, 12]);
  assert.ok(
    Array.from(payload.slice(3)).every(function (v) {
      return v === 0;
    })
  );
});

test("pacer: changed frames go at once, identical ones only as a once-a-second keep-alive", function () {
  var pacer = new ddp.Pacer(1000);
  assert.equal(pacer.decide("a", 0), "send");
  pacer.sent("a", 0);
  assert.equal(pacer.decide("a", 50), "skip");
  assert.equal(pacer.decide("a", 999), "skip");
  assert.equal(pacer.decide("a", 1000), "keepalive");
  pacer.sent("a", 1000);
  assert.equal(pacer.decide("a", 1500), "skip");
  assert.equal(pacer.decide("b", 1501), "send");
  pacer.reset();
  assert.equal(pacer.decide("a", 1502), "send");
});
