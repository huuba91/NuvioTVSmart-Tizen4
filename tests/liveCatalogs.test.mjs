import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { collectLiveCatalogDescriptors, isLiveCatalog, promoteLiveCatalogRows } from "../js/core/addons/liveCatalogs.js";

const previousLocalStorage = globalThis.localStorage;
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};
const { LIVE_INITIAL_FOCUS_SELECTOR, LiveScreenController, renderLiveContent, resolveLiveGridMove } = await import("../js/ui/screens/live/liveScreen.js");
if (previousLocalStorage === undefined) delete globalThis.localStorage;
else globalThis.localStorage = previousLocalStorage;

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

test("live loading content owns a harmless focus target", () => {
  const markup = renderLiveContent({ loading: true });
  assert.match(markup, /live-focus-anchor focusable/);
  assert.match(markup, /data-action="waitForLiveCatalogs"/);
  assert.match(markup, /tabindex="0"/);
});

test("live initial focus cannot fall through to the earlier profile control", () => {
  assert.equal(LIVE_INITIAL_FOCUS_SELECTOR, ".live-event-card.focusable, .live-focus-anchor.focusable");
  assert.doesNotMatch(LIVE_INITIAL_FOCUS_SELECTOR, /(^|,\s*)\.focusable(?:,|$)/);

  const emptyMarkup = renderLiveContent({ loading: false, rows: [] });
  assert.match(emptyMarkup, /live-empty live-focus-anchor focusable/);
  assert.match(emptyMarkup, /data-action="waitForLiveCatalogs"/);
});

test("live screen cleanup invalidates pending loads and removes its UI", () => {
  const screen = new LiveScreenController();
  let childrenCleared = false;
  screen.container = {
    style: { display: "block" },
    childNodes: [{}],
    replaceChildren() {
      childrenCleared = true;
    }
  };
  screen.loadToken = 4;

  screen.cleanup();

  assert.equal(screen.loadToken, 5);
  assert.equal(childrenCleared, true);
  assert.equal(screen.container, null);
});

test("live receives remote keys only through the app-wide focus engine", async () => {
  const source = await readFile(new URL("../js/ui/screens/live/liveScreen.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /document\.addEventListener\(["']keydown["']/);
  assert.doesNotMatch(source, /document\.removeEventListener\(["']keydown["']/);
});

test("live horizontal navigation visits every adjacent stream without skipping", () => {
  const rowLengths = [5];
  assert.deepEqual(resolveLiveGridMove({ row: 0, col: 1, direction: "right", rowLengths }),
    { zone: "content", row: 0, col: 2 });
  assert.deepEqual(resolveLiveGridMove({ row: 0, col: 2, direction: "left", rowLengths }),
    { zone: "content", row: 0, col: 1 });
  assert.equal(resolveLiveGridMove({ row: 0, col: 4, direction: "right", rowLengths }), null);
});

test("live navigation enters the sidebar only from the first card", () => {
  const rowLengths = [4, 2];
  assert.deepEqual(resolveLiveGridMove({ row: 0, col: 0, direction: "left", rowLengths }), { zone: "sidebar" });
  assert.deepEqual(resolveLiveGridMove({ row: 0, col: 1, direction: "left", rowLengths }),
    { zone: "content", row: 0, col: 0 });
});

test("live vertical navigation preserves the column and clamps shorter rows", () => {
  const rowLengths = [5, 2, 4];
  assert.deepEqual(resolveLiveGridMove({ row: 0, col: 4, direction: "down", rowLengths }),
    { zone: "content", row: 1, col: 1 });
  assert.deepEqual(resolveLiveGridMove({ row: 1, col: 1, direction: "down", rowLengths }),
    { zone: "content", row: 2, col: 1 });
  assert.equal(resolveLiveGridMove({ row: 0, col: 0, direction: "up", rowLengths }), null);
});
