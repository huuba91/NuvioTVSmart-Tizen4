import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPlaybackSource,
  mapAddonStream,
  streamDirectPlaybackUrl
} from "../js/core/streams/playbackSource.js";
import {
  buildTizenPlaybackProxyUrl,
  buildTizenAvPlayProxyBaseUrl,
  hasTizenUnsupportedPlaybackHeaders,
  TizenPlaybackProxy
} from "../js/platform/tizen/tizenPlaybackProxy.js";
import {
  buildPeerSearchSources,
  buildPlaybackUrl,
  extractInfoHashFromMagnet,
  normalizeBaseUrl
} from "../js/core/p2p/tizenStreamingServerResolver.js";

const LEGAL_TEST_HASH = "0123456789abcdef0123456789abcdef01234567";

test("Stremio-compatible direct streams retain playback and subtitle metadata", () => {
  const mapped = mapAddonStream({
    name: "Controlled legal source",
    url: "https://media.example.test/big-buck-bunny/master.m3u8",
    behaviorHints: { notWebReady: false },
    quality: "1080p",
    qualityValue: "1080",
    subtitles: [
      {
        id: "en",
        url: "https://media.example.test/big-buck-bunny/en.vtt",
        lang: "eng",
        behaviorHints: { proxyHeaders: { request: { Referer: "https://example.test/" } } }
      },
      { id: "invalid-without-url", lang: "nld" }
    ]
  });

  assert.equal(streamDirectPlaybackUrl(mapped), mapped.url);
  assert.deepEqual(classifyPlaybackSource(mapped), { kind: "direct-http", url: mapped.url });
  assert.equal(mapped.qualityValue, 1080);
  assert.deepEqual(mapped.subtitles, [
    {
      id: "en",
      url: "https://media.example.test/big-buck-bunny/en.vtt",
      lang: "eng",
      headers: { Referer: "https://example.test/" }
    }
  ]);
});

test("magnet URLs never bypass the P2P resolver as direct playback", () => {
  const magnet = `magnet:?xt=urn:btih:${LEGAL_TEST_HASH}&tr=https%3A%2F%2Ftracker.example.test%2Fannounce`;
  const stream = mapAddonStream({ url: magnet, infoHash: LEGAL_TEST_HASH, fileIdx: 0 });

  assert.equal(streamDirectPlaybackUrl(stream), "");
  assert.deepEqual(classifyPlaybackSource(stream), { kind: "p2p", url: "" });
  assert.equal(extractInfoHashFromMagnet(magnet), LEGAL_TEST_HASH);
});

test("Tizen playback bridge preserves the complete source URL and declared headers", () => {
  const sourceUrl = "https://media.example.test/video/master.m3u8?token=legal-test";
  const headers = { Referer: "https://catalog.example.test/", "X-Test": "safe" };
  const proxyUrl = buildTizenPlaybackProxyUrl("http://127.0.0.1:2710", sourceUrl, headers);

  assert.equal(hasTizenUnsupportedPlaybackHeaders({ Cookie: "session=test" }), false);
  assert.equal(hasTizenUnsupportedPlaybackHeaders(headers), true);
  assert.match(proxyUrl, /^http:\/\/127\.0\.0\.1:2710\/media\?/);
  assert.match(proxyUrl, /url=https%3A%2F%2Fmedia\.example\.test%2Fvideo%2Fmaster\.m3u8%3Ftoken%3Dlegal-test/);
  assert.match(proxyUrl, /h=Referer%3Ahttps%3A%2F%2Fcatalog\.example\.test%2F/);
});

test("Tizen playback bridge can request browser-compatible HTTP responses", () => {
  const proxyUrl = buildTizenPlaybackProxyUrl(
    "http://127.0.0.1:2710",
    "https://example.com/master.m3u8",
    { Referer: "https://example.com/" },
    { browserTransport: true }
  );
  assert.equal(new URL(proxyUrl).searchParams.get("transport"), "browser");
});

test("Tizen playback proxy can bridge HTTPS media without synthetic headers", () => {
  assert.equal(
    buildTizenPlaybackProxyUrl(
      "http://192.168.129.0:2710",
      "https://media.w3.org/2010/05/bunny/trailer.mp4"
    ),
    "http://192.168.129.0:2710/media?url=https%3A%2F%2Fmedia.w3.org%2F2010%2F05%2Fbunny%2Ftrailer.mp4"
  );
});

test("Tizen 4 AVPlay routes plain HTTPS addon streams through EngineFS", () => {
  assert.equal(
    TizenPlaybackProxy.requiresProxy("https://media.example.test/movie.mp4", {}, {
      playbackEngine: "tizen-avplay",
      capabilities: { isTizen: true, tizenMajorVersion: 4 }
    }),
    true
  );
  assert.equal(
    TizenPlaybackProxy.requiresProxy("https://media.example.test/movie.mp4", {}, {
      playbackEngine: "tizen-avplay",
      capabilities: { isTizen: true, tizenMajorVersion: 6 }
    }),
    false
  );
});

test("Tizen AVPlay proxy advertises the TV LAN address instead of renderer loopback", () => {
  assert.equal(
    buildTizenAvPlayProxyBaseUrl("http://127.0.0.1:2710", { getIp: () => "192.168.129.0" }),
    "http://192.168.129.0:2710"
  );
  assert.equal(
    buildTizenAvPlayProxyBaseUrl("http://127.0.0.1:2710", { getIp: () => "not-an-ip" }),
    "http://127.0.0.1:2710"
  );
});

test("P2P bridge protocol emits only loopback playback URLs and deduplicated peer sources", () => {
  const sources = buildPeerSearchSources(LEGAL_TEST_HASH, [
    "https://tracker.example.test/announce",
    "tracker:https://tracker.example.test/announce"
  ]);
  const playbackUrl = buildPlaybackUrl("http://127.0.0.1:2710", LEGAL_TEST_HASH, 2, sources);

  assert.equal(normalizeBaseUrl(playbackUrl), "http://127.0.0.1:2710");
  assert.equal(normalizeBaseUrl("https://remote.example.test:2710/path"), "");
  assert.deepEqual(sources, [
    `dht:${LEGAL_TEST_HASH}`,
    "tracker:https://tracker.example.test/announce"
  ]);
  assert.match(playbackUrl, new RegExp(`/${LEGAL_TEST_HASH}/2\\?`));
  assert.match(playbackUrl, /tr=dht%3A/);
});
