/* global module, require, process, Buffer */
"use strict";

// Kept in its own file and loaded only when /netcheck is asked for, so nothing here can stop the
// service from starting.
// Diagnostic: what this service process can reach, measured on the TV itself. Streams and torrents
// both depend on it, and the TV has no usable shell or log to look at instead.
function handle(response) {
  var net = require("net"), dns = require("dns"), dgram = require("dgram"), os = require("os");
  var report = { interfaces: {}, env: {}, tcp: [], dns: [], udp: [], uid: null, groups: null }, pending = 0, done = false;
  function finish() {
    if (done) return;
    done = true;
    var body = JSON.stringify(report);
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
  }
  function settle() { if (--pending <= 0) finish(); }
  function describe(error) { return String((error && (error.code || error.name)) || "") + " " + String((error && error.message) || error); }
  try {
    var all = os.networkInterfaces();
    Object.keys(all).forEach(function (name) {
      report.interfaces[name] = all[name].map(function (a) { return a.family + " " + a.address + " " + a.netmask + (a.internal ? " internal" : ""); });
    });
  } catch (error) { report.interfaces = describe(error); }
  ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY"].forEach(function (name) {
    if (process.env[name]) report.env[name] = process.env[name];
  });
  try { report.uid = process.getuid(); report.groups = process.getgroups(); } catch (_) {}
  report.node = process.version;
  try { report.handles = process._getActiveHandles().length; } catch (_) {}
  function tcp(host, port) {
    var started = Date.now(), entry = { target: host + ":" + port, result: "" }, socket, over = false;
    function end(result) {
      if (over) return;
      over = true; entry.result = result; entry.ms = Date.now() - started;
      try { socket.destroy(); } catch (_) {}
      settle();
    }
    report.tcp.push(entry); pending++;
    try {
      socket = net.connect({ host: host, port: port });
      socket.on("connect", function () { end("connected"); });
      socket.on("error", function (error) { end(describe(error)); });
      setTimeout(function () { end("no answer in 45 s"); }, 45000);
    } catch (error) { end(describe(error)); }
  }
  function lookup(name) {
    var started = Date.now(), entry = { name: name, result: "" };
    report.dns.push(entry); pending++;
    var over = false;
    function end(result) { if (over) return; over = true; entry.result = result; entry.ms = Date.now() - started; settle(); }
    try {
      dns.lookup(name, function (error, address) { end(error ? describe(error) : address); });
      setTimeout(function () { end("no answer in 8 s"); }, 8000);
    } catch (error) { end(describe(error)); }
  }
  // One DNS question over UDP to a public resolver: shows whether UDP gets out and back.
  function udp(host) {
    var started = Date.now(), entry = { target: host + ":53", result: "" }, socket, over = false;
    function end(result) {
      if (over) return;
      over = true; entry.result = result; entry.ms = Date.now() - started;
      try { socket.close(); } catch (_) {}
      settle();
    }
    report.udp.push(entry); pending++;
    try {
      var query = new Buffer("123401000001000000000000076578616d706c6503636f6d0000010001", "hex");
      socket = dgram.createSocket("udp4");
      socket.on("message", function (message) { end("answer of " + message.length + " bytes"); });
      socket.on("error", function (error) { end(describe(error)); });
      socket.send(query, 0, query.length, 53, host, function (error) { if (error) end(describe(error)); });
      setTimeout(function () { end("no answer in 8 s"); }, 8000);
    } catch (error) { end(describe(error)); }
  }
  // Name lookups four ways, on a name not asked before, to see which is slow.
  function timed(label, run) {
    var started = Date.now(), entry = { how: label, result: "" }, over = false;
    report.dns.push(entry); pending++;
    function end(result) { if (over) return; over = true; entry.result = result; entry.ms = Date.now() - started; settle(); }
    try {
      run(function (error, value) { end(error ? describe(error) : JSON.stringify(value)); });
      setTimeout(function () { end("no answer in 20 s"); }, 20000);
    } catch (error) { end(describe(error)); }
  }
  var fast = null, stamp = String(Date.now() % 100000);
  try { fast = require("./fast-dns.cjs"); report.fastDns = { installed: fast.isInstalled(), stats: fast.stats }; } catch (error) { report.fastDns = describe(error); }
  try { report.servers = dns.getServers(); } catch (error) { report.servers = describe(error); }
  var system = fast && fast.systemLookup ? fast.systemLookup : dns.lookup;
  timed("system lookup, any family", function (cb) { system("a" + stamp + ".example.org", cb); });
  timed("system lookup, IPv4 only", function (cb) { system("b" + stamp + ".example.org", { family: 4 }, cb); });
  timed("direct question to the DNS server (resolve4)", function (cb) { dns.resolve4("www.wikipedia.org", cb); });
  timed("direct question for IPv6 (resolve6)", function (cb) { dns.resolve6("www.wikipedia.org", cb); });
  timed("system lookup of a real name, any family", function (cb) { system("www.wikipedia.org", cb); });
  timed("system lookup of a real name, IPv4 only", function (cb) { system("www.mozilla.org", { family: 4 }, cb); });
  timed("lookup as the service now does it", function (cb) { dns.lookup("www.debian.org", cb); });
  pending++;
  tcp("1.1.1.1", 80); tcp("1.1.1.1", 443); tcp("8.8.8.8", 53); tcp("192.168.128.1", 80); tcp("192.168.128.1", 53);
  lookup("api.nuvio.tv");
  udp("1.1.1.1"); udp("192.168.128.1");
  settle();
}

module.exports = { handle: handle };
