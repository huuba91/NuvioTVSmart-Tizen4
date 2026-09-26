import assert from "node:assert/strict";
import test from "node:test";
import { buildTizenAddonHlsProxyUrl } from "../js/core/player/tizenAddonHlsProxy.js";

test("Nuvio Live Sports protected HLS uses the add-on manifest proxy", () => {
  const source = "https://cdnlivetv.it/secure/api/v1/channel/playlist.m3u8?token=abc";
  const result = new URL(buildTizenAddonHlsProxyUrl(source, {
    addonId: "community.nuvio.live-sports",
    addonBaseUrl: "https://nuviosports.xyz/config-token",
    requestHeaders: { Referer: "https://cdnlivetv.tv/", Origin: "https://cdnlivetv.tv", "User-Agent": "Mozilla/5.0" }
  }));
  assert.equal(result.origin, "https://nuviosports.xyz");
  assert.equal(result.pathname, "/api/manifest");
  assert.equal(result.searchParams.get("url"), source);
  assert.equal(result.searchParams.get("referer"), "https://cdnlivetv.tv/");
  assert.equal(result.searchParams.get("origin"), "https://cdnlivetv.tv");
});

test("unrelated add-ons and existing sports manifest proxies remain unchanged", () => {
  const existing = "https://nuviosports.xyz/api/manifest?url=child.m3u8";
  assert.equal(buildTizenAddonHlsProxyUrl(existing, {
    addonId: "community.nuvio.live-sports",
    addonBaseUrl: "https://nuviosports.xyz"
  }), existing);
  const unrelated = "https://media.example/live.m3u8";
  assert.equal(buildTizenAddonHlsProxyUrl(unrelated, {
    addonId: "another.addon",
    addonBaseUrl: "https://addon.example"
  }), unrelated);
});
