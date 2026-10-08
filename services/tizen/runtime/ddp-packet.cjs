/* global module, Buffer */
"use strict";

// DDP packets for the surround strip, kept free of sockets, timers and colour maths so the same
// bytes can be checked against tests/fixtures/ddp-vectors.json by any other sender (a future native
// C++ one included).
//
// The strip (LSC RGBIC on OpenBeken, `SM16703P_Init 16 BRG; startDriver DDP`) has 16 pixels: the even
// ones are the 8 RGB segments, the odd ones are white chips that stay black.
//
// Packet = 10 byte header + 48 byte payload:
//   byte 0      0x41  DDP version 1 (0x40) with the push flag (0x01)
//   byte 1      sequence 1..15, wrapping (0 means "no sequence" in DDP, so it is never sent)
//   byte 2      0x01  data type: RGB, 8 bit per channel
//   byte 3      0x01  destination: the default output device
//   bytes 4-7   0     data offset (big endian)
//   bytes 8-9   48    data length (big endian)
//   bytes 10-57 zone 1 RGB, black, zone 2 RGB, black, ... zone 8 RGB, black

var ZONES = 8;
var PIXELS = ZONES * 2;
var PAYLOAD_LENGTH = PIXELS * 3;
var HEADER_LENGTH = 10;
var KEEP_ALIVE_MS = 1000;

function channel(value) {
  var n = Math.round(Number(value));
  return n > 0 ? (n < 255 ? n : 255) : 0; // also turns NaN into 0
}

// The sequence number that follows `previous`: 1, 2, ... 15, 1, ...
function nextSequence(previous) {
  var n = Math.floor(Number(previous)) || 0;
  return ((n % 15) + 15) % 15 + 1;
}

// 8 zone colours ([r, g, b] 0..255, already in strip order) -> 48 byte payload.
function buildPayload(zones) {
  var payload = new Buffer(PAYLOAD_LENGTH), i, k, zone;
  payload.fill(0);
  for (i = 0; i < ZONES; i++) {
    zone = (zones && zones[i]) || [0, 0, 0];
    for (k = 0; k < 3; k++) payload[i * 6 + k] = channel(zone[k]);
  }
  return payload;
}

// Header + payload. A sequence outside 1..15 is folded into it (16 -> 1, 0 -> 1).
function buildPacket(payload, sequence) {
  var packet = new Buffer(HEADER_LENGTH + payload.length);
  packet[0] = 0x41;
  packet[1] = sequence & 15 || 1;
  packet[2] = 0x01;
  packet[3] = 0x01;
  packet.writeUInt32BE(0, 4);
  packet.writeUInt16BE(payload.length, 8);
  payload.copy(packet, HEADER_LENGTH);
  return packet;
}

function buildZonePacket(zones, sequence) {
  return buildPacket(buildPayload(zones), sequence);
}

function blackZones() {
  var out = [];
  for (var i = 0; i < ZONES; i++) out.push([0, 0, 0]);
  return out;
}

// Frame pacing: a packet goes out when the colours differ from the last packet sent; identical
// colours are resent at most once per keep-alive period, so OpenBeken keeps seeing the stream
// without the network carrying 20 identical packets a second. There is no queue: the caller asks
// with the newest colours only, so a stale frame can never be sent after a newer one.
function Pacer(keepAliveMs) {
  this.keepAliveMs = keepAliveMs > 0 ? keepAliveMs : KEEP_ALIVE_MS;
  this.reset();
}

Pacer.prototype.reset = function () {
  this.lastKey = "";
  this.lastAt = 0;
};

// "send" (changed), "keepalive" (unchanged, but quiet for a full period) or "skip".
Pacer.prototype.decide = function (key, now) {
  if (key !== this.lastKey) return "send";
  return now - this.lastAt >= this.keepAliveMs ? "keepalive" : "skip";
};

Pacer.prototype.sent = function (key, now) {
  this.lastKey = key;
  this.lastAt = now;
};

module.exports = {
  ZONES: ZONES,
  PIXELS: PIXELS,
  PAYLOAD_LENGTH: PAYLOAD_LENGTH,
  HEADER_LENGTH: HEADER_LENGTH,
  KEEP_ALIVE_MS: KEEP_ALIVE_MS,
  nextSequence: nextSequence,
  buildPayload: buildPayload,
  buildPacket: buildPacket,
  buildZonePacket: buildZonePacket,
  blackZones: blackZones,
  Pacer: Pacer
};
