/* global module, require */
"use strict";

// Name lookups in this service took 5 s each on the UE49NU7100 (measured with /netcheck: the
// system resolver waits out a timeout before it answers), and they run four at a time. A torrent
// asking 21 trackers, or a stream fetched through the proxy, queued behind them for half a minute
// and more. This asks the network's DNS server directly for the IPv4 address instead, remembers
// the answer for a minute, and falls back to the system resolver when that fails.
var CACHE_MS = 60000;
var MAX_CACHED = 400;

var installed = false;
var stats = { direct: 0, cached: 0, fallback: 0 };

function install() {
  if (installed) return true;
  var dns = require("dns"), net = require("net");
  var systemLookup = dns.lookup, cache = {}, cachedNames = 0;

  dns.lookup = function (hostname, options, callback) {
    var args = arguments;
    if (typeof options === "function") { callback = options; options = {}; }
    var family = typeof options === "number" ? options : (options && options.family) || 0;
    var all = Boolean(options && typeof options === "object" && options.all);
    function system() { stats.fallback++; return systemLookup.apply(dns, args); }
    // Addresses, local names and IPv6-only questions keep the system's own answer.
    if (typeof callback !== "function" || typeof hostname !== "string" || !hostname || net.isIP(hostname) ||
        hostname === "localhost" || hostname.indexOf(".") < 0 || family === 6) {
      return system();
    }
    function answer(addresses) {
      if (all) callback(null, addresses.map(function (address) { return { address: address, family: 4 }; }));
      else callback(null, addresses[0], 4);
    }
    var key = hostname.toLowerCase(), hit = cache[key], now = Date.now();
    if (hit && now - hit.at < CACHE_MS) {
      stats.cached++;
      setTimeout(function () { answer(hit.addresses); }, 0);
      return {};
    }
    try {
      dns.resolve4(hostname, function (error, addresses) {
        if (error || !addresses || !addresses.length) { system(); return; }
        if (!cache[key]) {
          if (cachedNames >= MAX_CACHED) { cache = {}; cachedNames = 0; }
          cachedNames++;
        }
        cache[key] = { at: Date.now(), addresses: addresses };
        stats.direct++;
        answer(addresses);
      });
    } catch (_) {
      return system();
    }
    return {};
  };
  module.exports.systemLookup = function () { return systemLookup.apply(dns, arguments); };
  installed = true;
  return true;
}

module.exports = { install: install, stats: stats, isInstalled: function () { return installed; } };
