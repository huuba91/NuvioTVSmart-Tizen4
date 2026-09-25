import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem() {
    return null;
  },
  setItem() {},
  removeItem() {},
  clear() {}
};

const { addonRepository } = await import("../js/data/repository/addonRepository.js");

test("manifest URLs and relative assets are normalized without losing configuration", () => {
  assert.equal(
    addonRepository.canonicalizeUrl(" https://legal.example.test/addon/manifest.json?key=value "),
    "https://legal.example.test/addon?key=value"
  );
  assert.equal(
    addonRepository.buildManifestUrl("https://legal.example.test/addon/?key=value"),
    "https://legal.example.test/addon/manifest.json?key=value"
  );
  assert.equal(
    addonRepository.normalizeManifestAssetUrl(
      "images/logo.png",
      "https://legal.example.test/addon"
    ),
    "https://legal.example.test/addon/images/logo.png"
  );
});

test("Stremio resource declarations gate stream requests by type and ID prefix", () => {
  const addon = addonRepository.mapManifest(
    {
      id: "org.example.legal",
      name: "Legal Test Add-on",
      version: "1.0.0",
      types: ["movie", "series"],
      idPrefixes: ["legal:"],
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["legal:movie:"] }, "subtitles"],
      catalogs: [{ id: "public-domain", name: "Public Domain", type: "movie" }]
    },
    "https://legal.example.test/addon"
  );

  assert.equal(
    addonRepository.resolveResourceRequestType(addon, "stream", "movie", "legal:movie:bbb"),
    "movie"
  );
  assert.equal(
    addonRepository.resolveResourceRequestType(addon, "stream", "series", "legal:movie:bbb"),
    ""
  );
  assert.equal(
    addonRepository.resolveResourceRequestType(addon, "stream", "movie", "tt1254207"),
    ""
  );
  assert.equal(addon.catalogs[0].name, "Public Domain");
});
