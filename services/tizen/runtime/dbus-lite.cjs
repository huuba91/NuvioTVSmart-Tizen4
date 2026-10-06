"use strict";

// A very small D-Bus client for the ambilight (Node 4 on the TV: plain ES5, no Buffer.alloc).
//
// It exists to replace "spawn gdbus for every capture": one connection to the system bus is opened once and
// every capture request is a method call over it. Only what is needed is implemented:
//   - SASL EXTERNAL authentication on a unix socket,
//   - method calls whose arguments are int32 / uint32 ('i', 'u') and strings ('s', 'o'),
//   - replies with those types (METHOD_RETURN or ERROR); signals are skipped.
// Anything else throws, and the caller keeps using gdbus.

var net = require("net");

var TYPE_METHOD_CALL = 1, TYPE_METHOD_RETURN = 2, TYPE_ERROR = 3;

function Writer() {
  this.bytes = [];
}
Writer.prototype.align = function (n) { while (this.bytes.length % n) this.bytes.push(0); };
Writer.prototype.u8 = function (v) { this.bytes.push(v & 255); };
Writer.prototype.u32 = function (v) {
  this.align(4);
  this.bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
};
Writer.prototype.str = function (s) { // 's' and 'o'
  var b = new Buffer(String(s), "utf8");
  this.u32(b.length);
  for (var i = 0; i < b.length; i++) this.bytes.push(b[i]);
  this.bytes.push(0);
};
Writer.prototype.sig = function (s) { // 'g'
  this.bytes.push(s.length);
  for (var i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i));
  this.bytes.push(0);
};

// Body of a call: values typed by a signature made of i, u, s and o.
function marshalBody(signature, values) {
  var w = new Writer();
  if (signature.length !== values.length) throw new Error("signature and arguments differ");
  for (var i = 0; i < signature.length; i++) {
    var t = signature.charAt(i);
    if (t === "i" || t === "u") w.u32(Number(values[i]));
    else if (t === "s" || t === "o") w.str(values[i]);
    else throw new Error("unsupported D-Bus type " + t);
  }
  return w.bytes;
}

// A complete METHOD_CALL message (little endian) as a Buffer.
function buildCall(serial, call) {
  var body = call.signature ? marshalBody(call.signature, call.args || []) : [];
  var fields = new Writer(); // starts at message offset 16, a multiple of 8, so alignment can be taken locally
  function field(code, type, value) {
    fields.align(8);
    fields.u8(code);
    fields.sig(type);
    if (type === "g") fields.sig(value); else fields.str(value);
  }
  field(1, "o", call.path);
  if (call.iface) field(2, "s", call.iface);
  field(3, "s", call.member);
  if (call.dest) field(6, "s", call.dest);
  if (call.signature) field(8, "g", call.signature);
  var head = new Writer();
  head.u8(0x6c); head.u8(TYPE_METHOD_CALL); head.u8(0); head.u8(1);
  head.u32(body.length);
  head.u32(serial);
  head.u32(fields.bytes.length);
  var all = head.bytes.concat(fields.bytes);
  while (all.length % 8) all.push(0);
  all = all.concat(body);
  return new Buffer(all);
}

function Reader(buffer, offset, end) {
  this.b = buffer; this.p = offset; this.end = end;
}
Reader.prototype.need = function (n) { if (this.p + n > this.end) throw new Error("short D-Bus message"); };
Reader.prototype.align = function (n) { while (this.p % n) this.p++; };
Reader.prototype.u8 = function () { this.need(1); return this.b[this.p++]; };
Reader.prototype.u32 = function () { this.align(4); this.need(4); var v = this.b.readUInt32LE(this.p); this.p += 4; return v; };
Reader.prototype.i32 = function () { this.align(4); this.need(4); var v = this.b.readInt32LE(this.p); this.p += 4; return v; };
Reader.prototype.str = function () {
  var n = this.u32(); this.need(n + 1);
  var s = this.b.toString("utf8", this.p, this.p + n);
  this.p += n + 1;
  return s;
};
Reader.prototype.sig = function () {
  var n = this.u8(); this.need(n + 1);
  var s = this.b.toString("ascii", this.p, this.p + n);
  this.p += n + 1;
  return s;
};

// One message from the front of `buffer`, or null when it is incomplete. Offsets are relative to the buffer start.
function parseMessage(buffer) {
  if (buffer.length < 16) return null;
  if (buffer[0] !== 0x6c) throw new Error("only little-endian D-Bus messages are supported");
  var bodyLen = buffer.readUInt32LE(4), fieldsLen = buffer.readUInt32LE(12);
  var headerEnd = 16 + fieldsLen, bodyStart = (headerEnd + 7) & ~7, total = bodyStart + bodyLen;
  if (buffer.length < total) return null;
  var msg = { type: buffer[1], serial: buffer.readUInt32LE(8), total: total, fields: {}, args: [] };
  var r = new Reader(buffer, 16, headerEnd);
  while (r.p < headerEnd) {
    r.align(8);
    if (r.p >= headerEnd) break;
    var code = r.u8(), vt = r.sig(), value;
    if (vt === "s" || vt === "o") value = r.str();
    else if (vt === "g") value = r.sig();
    else if (vt === "u") value = r.u32();
    else throw new Error("unsupported header field type " + vt);
    msg.fields[code] = value;
  }
  msg.replySerial = msg.fields[5];
  msg.errorName = msg.fields[4];
  msg.signature = msg.fields[8] || "";
  if (msg.type === TYPE_METHOD_RETURN || msg.type === TYPE_ERROR) {
    // An unreadable body fails only the call it answers; the connection stays usable.
    try {
      var br = new Reader(buffer, bodyStart, total);
      for (var i = 0; i < msg.signature.length; i++) {
        var t = msg.signature.charAt(i);
        if (t === "i") msg.args.push(br.i32());
        else if (t === "u") msg.args.push(br.u32());
        else if (t === "s" || t === "o") msg.args.push(br.str());
        else throw new Error("unsupported reply type " + t);
      }
    } catch (problem) {
      msg.bodyError = problem.message;
    }
  }
  return msg;
}

function Connection(options) {
  this.path = options.path;
  this.timeoutMs = options.timeoutMs || 5000;
  this.socket = null;
  this.serial = 0;
  this.pending = {};
  this.rx = new Buffer(0);
  this.ready = false;
  this.closed = false;
  this.uniqueName = null;
}

// Connects, authenticates (EXTERNAL, uid) and says Hello. cb(error).
Connection.prototype.open = function (cb) {
  var self = this, state = "auth", finished = false, authBuf = new Buffer(0);
  function done(error) {
    if (finished) return;
    finished = true;
    if (error) self.close();
    cb(error || null);
  }
  var timer = setTimeout(function () { done(new Error("D-Bus connect timeout")); }, this.timeoutMs);
  var socket = this.socket = net.connect({ path: this.path });
  socket.on("error", function (error) { clearTimeout(timer); self.fail(error); done(error); });
  socket.on("close", function () { self.fail(new Error("D-Bus connection closed")); done(new Error("D-Bus connection closed")); });
  socket.on("connect", function () {
    var uid = typeof process.getuid === "function" ? String(process.getuid()) : "0";
    socket.write(Buffer.concat([new Buffer([0]), new Buffer("AUTH EXTERNAL " + new Buffer(uid, "ascii").toString("hex") + "\r\n", "ascii")]));
  });
  socket.on("data", function (chunk) {
    if (state === "auth") {
      authBuf = Buffer.concat([authBuf, chunk]);
      var end = authBuf.toString("latin1").indexOf("\r\n");
      if (end < 0) return;
      var reply = authBuf.toString("latin1", 0, end), rest = authBuf.slice(end + 2);
      if (reply.indexOf("OK") !== 0) { clearTimeout(timer); done(new Error("D-Bus auth refused: " + reply.slice(0, 80))); return; }
      state = "msg";
      socket.write(new Buffer("BEGIN\r\n", "ascii"));
      self.call({ dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "Hello" }, function (error, reply2) {
        clearTimeout(timer);
        if (error) { done(error); return; }
        self.uniqueName = reply2.args[0];
        self.ready = true;
        done(null);
      });
      if (rest.length) self.onData(rest);
      return;
    }
    self.onData(chunk);
  });
};

Connection.prototype.onData = function (chunk) {
  this.rx = Buffer.concat([this.rx, chunk]);
  var msg;
  try {
    while ((msg = parseMessage(this.rx))) {
      this.rx = this.rx.slice(msg.total);
      if ((msg.type === TYPE_METHOD_RETURN || msg.type === TYPE_ERROR) && this.pending[msg.replySerial]) {
        var entry = this.pending[msg.replySerial];
        delete this.pending[msg.replySerial];
        clearTimeout(entry.timer);
        if (msg.bodyError && msg.type !== TYPE_ERROR) entry.cb(new Error(msg.bodyError));
        else if (msg.type === TYPE_ERROR) entry.cb(new Error("D-Bus error " + msg.errorName + (msg.args[0] ? ": " + msg.args[0] : "")));
        else entry.cb(null, msg);
      }
    }
  } catch (error) {
    this.fail(error);
  }
};

// call: { dest, path, iface, member, signature, args }. cb(error, { args, signature }).
Connection.prototype.call = function (call, cb) {
  var self = this;
  if (this.closed || !this.socket) { cb(new Error("D-Bus connection is closed")); return; }
  var serial = ++this.serial, message;
  try { message = buildCall(serial, call); } catch (error) { cb(error); return; }
  this.pending[serial] = {
    cb: cb,
    timer: setTimeout(function () {
      if (self.pending[serial]) { delete self.pending[serial]; cb(new Error("D-Bus call timeout")); }
    }, this.timeoutMs)
  };
  this.socket.write(message);
};

Connection.prototype.fail = function (error) {
  var pending = this.pending;
  this.pending = {};
  this.ready = false;
  this.closed = true;
  Object.keys(pending).forEach(function (k) { clearTimeout(pending[k].timer); pending[k].cb(error); });
};

Connection.prototype.close = function () {
  this.closed = true;
  this.ready = false;
  if (this.socket) { try { this.socket.destroy(); } catch (_) { /* ignore */ } }
};

// Where the system bus listens: DBUS_SYSTEM_BUS_ADDRESS ("unix:path=...") or the usual places.
function systemBusPaths() {
  var out = [], address = process.env.DBUS_SYSTEM_BUS_ADDRESS, match;
  if (address && (match = /unix:path=([^,;]+)/.exec(address))) out.push(match[1]);
  ["/var/run/dbus/system_bus_socket", "/run/dbus/system_bus_socket"].forEach(function (p) { if (out.indexOf(p) < 0) out.push(p); });
  return out;
}

module.exports = {
  Connection: Connection,
  systemBusPaths: systemBusPaths,
  _internals: { buildCall: buildCall, parseMessage: parseMessage, marshalBody: marshalBody }
};
