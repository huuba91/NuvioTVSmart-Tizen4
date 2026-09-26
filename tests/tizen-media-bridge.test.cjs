"use strict";

var assert = require("node:assert/strict");
var http = require("node:http");
var test = require("node:test");
var bridge = require("../services/tizen/runtime/tizen-media-bridge.cjs");

function listen(server) {
  return new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", function () {
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise(function (resolve) { server.close(resolve); });
}

function request(port, path, headers) {
  return new Promise(function (resolve, reject) {
    http.get({ hostname: "127.0.0.1", port: port, path: path, headers: headers || {} }, function (response) {
      var chunks = [];
      response.on("data", function (chunk) { chunks.push(chunk); });
      response.on("end", function () {
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      });
    }).on("error", reject);
  });
}

test("Tizen media bridge preserves byte ranges and required media headers", async function () {
  var payload = Buffer.from("0123456789");
  var upstream = http.createServer(function (req, res) {
    assert.equal(req.headers.referer, "https://catalog.example/");
    assert.equal(req.headers.range, "bytes=2-5");
    res.writeHead(206, {
      "Content-Type": "video/mp4",
      "Content-Length": "4",
      "Content-Range": "bytes 2-5/10",
      "Accept-Ranges": "bytes",
      Connection: "close"
    });
    res.end(payload.subarray(2, 6));
  });
  var upstreamPort = await listen(upstream);
  var proxy = http.createServer(bridge.handleRequest);
  var proxyPort = await listen(proxy);

  try {
    var target = "http://127.0.0.1:" + upstreamPort + "/movie.mp4";
    var path = "/media?url=" + encodeURIComponent(target) + "&h=" + encodeURIComponent("Referer:https://catalog.example/");
    var result = await request(proxyPort, path, { Range: "bytes=2-5" });
    assert.equal(result.status, 206);
    assert.equal(result.body.toString(), "2345");
    assert.equal(result.headers["content-range"], "bytes 2-5/10");
    assert.equal(result.headers["accept-ranges"], "bytes");
    assert.equal(result.headers["access-control-allow-origin"], "*");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
