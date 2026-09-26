import assert from "node:assert/strict";
import test from "node:test";

import { Platform } from "../js/platform/index.js";
import {
  TizenStreamingServerResolver,
  buildPlaybackUrl,
  buildResolvedStream,
  normalizeBaseUrl
} from "../js/core/p2p/tizenStreamingServerResolver.js";

const HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";

test("Tizen torrent bridge accepts only loopback service origins", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:2710/settings"), "http://127.0.0.1:2710");
  assert.equal(normalizeBaseUrl("http://localhost:2710"), "http://localhost:2710");
  assert.equal(normalizeBaseUrl("https://127.0.0.1:2710"), "");
  assert.equal(normalizeBaseUrl("http://example.test:2710"), "");
});

test("Tizen torrent bridge keeps trackers encoded on the local range URL", () => {
  const url = buildPlaybackUrl("http://127.0.0.1:2710", HASH, 5, [
    `dht:${HASH}`,
    "tracker:udp://tracker.example.test:80/announce"
  ]);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, `/${HASH}/5`);
  assert.deepEqual(parsed.searchParams.getAll("tr"), [
    `dht:${HASH}`,
    "tracker:udp://tracker.example.test:80/announce"
  ]);
});

test("resolved Tizen torrents retain cleanup identity and selected media type", () => {
  const stream = buildResolvedStream(
    { name: "Legal test torrent" },
    {
      baseUrl: "http://127.0.0.1:2710",
      infoHash: HASH,
      fileIdx: 5,
      playbackUrl: `http://127.0.0.1:2710/${HASH}/5`,
      filename: "Sintel.mp4"
    }
  );
  assert.equal(stream.url, `http://127.0.0.1:2710/${HASH}/5`);
  assert.equal(stream.mimeType, "video/mp4");
  assert.deepEqual(stream.tizenP2p, {
    kind: "tizen-streaming-server",
    baseUrl: "http://127.0.0.1:2710",
    baseUrlKind: "local-service",
    infoHash: HASH,
    fileIdx: 5,
    playbackUrl: `http://127.0.0.1:2710/${HASH}/5`,
    sources: [],
    mimeType: "video/mp4"
  });
});

test("Tizen torrent removal is bounded and targets the local service", async () => {
  const previousPlatform = globalThis.__NUVIO_PLATFORM__;
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.__NUVIO_PLATFORM__ = "tizen";
    Platform.current = null;
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true, status: 200 };
    };
    const result = await TizenStreamingServerResolver.remove(HASH, {
      baseUrl: "http://127.0.0.1:2710",
      timeoutMs: 100
    });
    assert.deepEqual(result, { status: "success", baseUrl: "http://127.0.0.1:2710" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `http://127.0.0.1:2710/${HASH}/remove`);
    assert.equal(requests[0].options.cache, "no-cache");
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__NUVIO_PLATFORM__ = previousPlatform;
    Platform.current = null;
  }
});
