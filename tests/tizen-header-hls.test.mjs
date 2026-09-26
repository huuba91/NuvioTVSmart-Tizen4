import assert from "node:assert/strict";
import test from "node:test";

const previousLocalStorage = globalThis.localStorage;
globalThis.localStorage = {
  getItem() {
    return null;
  },
  setItem() {},
  removeItem() {}
};
const { PlayerController } = await import("../js/core/player/playerController.js");
globalThis.localStorage = previousLocalStorage;

test("Tizen header-aware HLS proxies every hls.js request", () => {
  const previousBaseUrl = PlayerController.currentTizenHlsProxyBaseUrl;
  const previousItemType = PlayerController.currentItemType;
  try {
    PlayerController.currentTizenHlsProxyBaseUrl = "http://127.0.0.1:2710";
    PlayerController.currentItemType = "channel";
    const config = PlayerController.buildHlsConfig({
      Origin: "https://sports.example.test",
      Referer: "https://sports.example.test/",
      "User-Agent": "Nuvio-TV-Test"
    });
    const opened = [];
    config.xhrSetup(
      {
        open(method, url, async) {
          opened.push({ method, url, async });
        },
        setRequestHeader() {
          assert.fail("forbidden source headers must be applied by EngineFS, not browser XHR");
        }
      },
      "https://cdn.example.test/live/segment-42.ts?token=abc"
    );
    assert.equal(opened.length, 1);
    const proxy = new URL(opened[0].url);
    assert.equal(opened[0].method, "GET");
    assert.equal(opened[0].async, true);
    assert.equal(proxy.origin, "http://127.0.0.1:2710");
    assert.equal(proxy.pathname, "/media");
    assert.equal(proxy.searchParams.get("url"), "https://cdn.example.test/live/segment-42.ts?token=abc");
    assert.equal(proxy.searchParams.get("transport"), "browser");
    assert.deepEqual(proxy.searchParams.getAll("h"), [
      "Origin:https://sports.example.test",
      "Referer:https://sports.example.test/",
      "User-Agent:Nuvio-TV-Test"
    ]);
  } finally {
    PlayerController.currentTizenHlsProxyBaseUrl = previousBaseUrl;
    PlayerController.currentItemType = previousItemType;
  }
});
