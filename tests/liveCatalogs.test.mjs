import test from "node:test";
import assert from "node:assert/strict";
import { collectLiveCatalogDescriptors, isLiveCatalog, promoteLiveCatalogRows } from "../js/core/addons/liveCatalogs.js";

test("live catalogs include channels and sports addons without matching ordinary movies", () => {
  assert.equal(isLiveCatalog({}, { apiType: "channel", id: "news" }), true);
  assert.equal(isLiveCatalog({ displayName: "Nuvio Sports" }, { apiType: "movie", id: "events" }), true);
  assert.equal(isLiveCatalog({ displayName: "Cinemeta" }, { apiType: "movie", id: "top" }), false);
});

test("live catalog descriptors are deduplicated and retain playback identity", () => {
  const addon = { id: "sports", displayName: "Sports", baseUrl: "https://sports.example", catalogs: [
    { id: "live", name: "Live football", apiType: "movie" },
    { id: "live", name: "Live football", apiType: "movie" }
  ] };
  const descriptors = collectLiveCatalogDescriptors([addon]);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].addonBaseUrl, addon.baseUrl);
  assert.equal(descriptors[0].category, "Football");
});

test("live rows are promoted while preserving order within both partitions", () => {
  const rows = [
    { catalogName: "Movies", addonName: "Cinemeta" },
    { catalogName: "Live football", addonName: "Sports" },
    { catalogName: "Series", addonName: "Cinemeta" },
    { catalogName: "Live basketball", addonName: "Sports" }
  ];
  assert.deepEqual(promoteLiveCatalogRows(rows).map((row) => row.catalogName),
    ["Live football", "Live basketball", "Movies", "Series"]);
});
