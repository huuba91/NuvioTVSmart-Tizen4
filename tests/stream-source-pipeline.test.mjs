import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPlaybackSource,
  mapAddonStream,
  streamDirectPlaybackUrl
} from "../js/core/streams/playbackSource.js";
import {
  buildTizenPlaybackProxyUrl,
  hasTizenUnsupportedPlaybackHeaders
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

test("Tizen playback proxy preserves path/query while encoding source headers", () => {
  const sourceUrl = "https://media.example.test/video/master.m3u8?token=legal-test";
  const headers = { Referer: "https://catalog.example.test/", "X-Test": "safe" };
  const proxyUrl = buildTizenPlaybackProxyUrl("http://127.0.0.1:2710", sourceUrl, headers);

  assert.equal(hasTizenUnsupportedPlaybackHeaders({ Cookie: "session=test" }), false);
  assert.equal(hasTizenUnsupportedPlaybackHeaders(headers), true);
  assert.match(proxyUrl, /^http:\/\/127\.0\.0\.1:2710\/proxy\//);
  assert.match(proxyUrl, /\/video\/master\.m3u8\?token=legal-test$/);
  assert.match(proxyUrl, /d=https%3A%2F%2Fmedia\.example\.test/);
  assert.match(proxyUrl, /h=Referer%3Ahttps%3A%2F%2Fcatalog\.example\.test%2F/);
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
