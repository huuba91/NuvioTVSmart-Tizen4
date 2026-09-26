/* global module, require */
"use strict";

var http = require("http");
var https = require("https");
var url = require("url");

var server = null;
var DEFAULT_PORT = 2712;
var MAX_REDIRECTS = 5;
var MAX_HLS_MANIFEST_BYTES = 4 * 1024 * 1024;
var REQUEST_HEADER_ALLOWLIST = {
  accept: true,
  cookie: true,
  origin: true,
  referer: true,
  "user-agent": true
};
var RESPONSE_HEADER_ALLOWLIST = {
  "content-type": true,
  "content-length": true,
  "content-range": true,
  etag: true,
  "last-modified": true,
  "cache-control": true
};

function writeHttp10Response(response, status, headers, upstreamResponse) {
  var socket = response.socket;
  if (!socket || typeof socket.write !== "function") {
    response.shouldKeepAlive = false;
    response.writeHead(status, headers);
    upstreamResponse.pipe(response);
    return;
  }
  var reason = http.STATUS_CODES[status] || "OK";
  var lines = ["HTTP/1.0 " + status + " " + reason];
  Object.keys(headers).forEach(function (name) {
    var value = headers[name];
    if (Array.isArray(value)) value = value.join(", ");
    lines.push(name + ": " + String(value));
  });
  lines.push("", "");
  response._headerSent = true;
  response.finished = true;
  socket.write(lines.join("\r\n"));
  upstreamResponse.pipe(socket);
}

function writeBrowserResponse(response, status, headers, upstreamResponse) {
  response.shouldKeepAlive = false;
  response.writeHead(status, headers);
  upstreamResponse.pipe(response);
}

function isLikelyHlsManifest(target, headers) {
  var contentType = String((headers && headers["content-type"]) || "").toLowerCase();
  return /mpegurl|m3u8/.test(contentType) || /(?:\.m3u8(?:[?#]|$)|\/api\/manifest(?:[?#]|$))/i.test(String(target || ""));
}

function absoluteHlsUri(value, target) {
  var text = String(value || "").trim();
  if (!text || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(text)) return text;
  return url.resolve(target, text);
}

function rewriteHlsManifest(text, target) {
  return String(text || "")
    .split(/\r?\n/)
    .map(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.charAt(0) !== "#") return absoluteHlsUri(trimmed, target);
      return line.replace(/URI=("([^"]+)"|'([^']+)')/gi, function (match, quoted, doubleValue, singleValue) {
        var quote = quoted.charAt(0);
        return "URI=" + quote + absoluteHlsUri(doubleValue || singleValue, target) + quote;
      });
    })
    .join("\n");
}

function writeBrowserHlsResponse(response, status, headers, upstreamResponse, target) {
  var chunks = [];
  var size = 0;
  upstreamResponse.on("data", function (chunk) {
    size += chunk.length;
    if (size <= MAX_HLS_MANIFEST_BYTES) chunks.push(chunk);
  });
  upstreamResponse.on("end", function () {
    if (size > MAX_HLS_MANIFEST_BYTES) {
      if (!response.headersSent) sendError(response, 502, "HLS manifest is too large");
      return;
    }
    var body = Buffer.concat(chunks).toString("utf8");
    var rewritten = rewriteHlsManifest(body, target);
    var nextHeaders = {};
    Object.keys(headers).forEach(function (name) {
      if (String(name).toLowerCase() !== "content-length") nextHeaders[name] = headers[name];
    });
    nextHeaders["Content-Type"] = "application/vnd.apple.mpegurl";
    nextHeaders["Content-Length"] = Buffer.byteLength(rewritten);
    response.shouldKeepAlive = false;
    response.writeHead(status, nextHeaders);
    response.end(rewritten);
  });
}

function sendError(response, status, message) {
  var body = String(message || "Media bridge error");
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*"
  });
  response.end(body);
}

function validMediaUrl(value) {
  var parsed;
  try {
    parsed = url.parse(String(value || ""));
  } catch (_) {
    return null;
  }
  return parsed && (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname
    ? parsed
    : null;
}

function decodeForwardHeaders(query) {
  var values = query.h || [];
  var headers = {};
  if (!Array.isArray(values)) values = [values];
  values.slice(0, 24).forEach(function (entry) {
    var text = String(entry || "");
    var splitAt = text.indexOf(":");
    if (splitAt <= 0 || text.length > 8192 || /[\r\n]/.test(text)) return;
    var name = text.slice(0, splitAt).trim().toLowerCase();
    var value = text.slice(splitAt + 1).trim();
    if (REQUEST_HEADER_ALLOWLIST[name] && value) headers[name] = value;
  });
  return headers;
}

function forward(target, request, response, declaredHeaders, redirectsLeft, browserTransport) {
  var parsed = validMediaUrl(target);
  if (!parsed) {
    sendError(response, 400, "Invalid media URL");
    return;
  }

  var headers = {};
  Object.keys(declaredHeaders).forEach(function (name) {
    headers[name] = declaredHeaders[name];
  });
  ["range", "if-range"].forEach(function (name) {
    var value = request.headers[name];
    if (value && !/[\r\n]/.test(String(value))) headers[name] = String(value);
  });

  var client = parsed.protocol === "https:" ? https : http;
  var upstream = client.request(
    {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.path || "/",
      method: request.method,
      headers: headers,
      rejectUnauthorized: false
    },
    function (upstreamResponse) {
      var status = Number(upstreamResponse.statusCode || 502);
      var location = upstreamResponse.headers.location;
      if (location && status >= 300 && status < 400 && redirectsLeft > 0) {
        upstreamResponse.resume();
        forward(url.resolve(target, location), request, response, declaredHeaders, redirectsLeft - 1, browserTransport);
        return;
      }

      var responseHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes",
        Connection: "close"
      };
      Object.keys(upstreamResponse.headers || {}).forEach(function (name) {
        if (RESPONSE_HEADER_ALLOWLIST[name] && upstreamResponse.headers[name] != null) {
          responseHeaders[name] = upstreamResponse.headers[name];
        }
      });
      // Samsung's Tizen 4 media loaders fail against otherwise valid local
      // keep-alive responses. Match the controlled HTTP/1.0 probe by closing
      // every media response after its declared payload.
      response.shouldKeepAlive = false;
      upstreamResponse.on("error", function () {
        if (!response.finished) response.destroy();
      });
      if (browserTransport && request.method !== "HEAD" && isLikelyHlsManifest(target, upstreamResponse.headers)) {
        // The local bridge URL becomes XMLHttpRequest.responseURL on legacy
        // Tizen. Without canonicalization, hls.js resolves an add-on's
        // root-relative child manifests against 127.0.0.1 instead of the
        // upstream add-on host and then attempts to parse the bridge's error.
        writeBrowserHlsResponse(response, status, responseHeaders, upstreamResponse, target);
      } else if (browserTransport) writeBrowserResponse(response, status, responseHeaders, upstreamResponse);
      else writeHttp10Response(response, status, responseHeaders, upstreamResponse);
    }
  );
  upstream.setTimeout(30000, function () {
    upstream.destroy(new Error("upstream timeout"));
  });
  upstream.on("error", function (error) {
    if (!response.headersSent) sendError(response, 502, error && error.message);
    else if (!response.finished) response.destroy();
  });
  response.on("close", function () {
    if (!response.finished) upstream.destroy();
  });
  upstream.end();
}

function handleRequest(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, If-Range",
      "Access-Control-Max-Age": "86400"
    });
    response.end();
    return;
  }
  var parsedRequest = url.parse(request.url || "/", true);
  if (parsedRequest.pathname === "/health") {
    var body = '{"status":"ok","service":"tizen-media-bridge"}';
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
    return;
  }
  if (parsedRequest.pathname !== "/media" || (request.method !== "GET" && request.method !== "HEAD")) {
    sendError(response, 404, "Not found");
    return;
  }
  forward(
    parsedRequest.query.url,
    request,
    response,
    decodeForwardHeaders(parsedRequest.query),
    MAX_REDIRECTS,
    parsedRequest.query.transport === "browser"
  );
}

function start(options) {
  if (server) return server;
  options = options || {};
  server = http.createServer(handleRequest);
  server.on("error", function (error) {
    console.warn("[Nuvio Tizen media bridge]", error && error.message ? error.message : error);
  });
  server.listen(Number(options.port || DEFAULT_PORT), options.host || "0.0.0.0");
  return server;
}

function stop() {
  if (!server) return;
  var active = server;
  server = null;
  try {
    active.close();
  } catch (_) {}
}

module.exports = {
  start: start,
  stop: stop,
  handleRequest: handleRequest,
  rewriteHlsManifest: rewriteHlsManifest
};
