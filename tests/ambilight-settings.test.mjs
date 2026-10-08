import assert from "node:assert/strict";
import test from "node:test";
import {
  AMBILIGHT_SETTINGS_DEFAULTS,
  AMBILIGHT_SETTINGS_VERSION,
  createAmbilightSettingsStore,
  normalizeAmbilightIp,
  normalizeAmbilightSettings,
  getBulbPosition
} from "../js/data/local/ambilightSettingsStore.js";
import {
  buildAssignQuery,
  buildConfigQuery,
  buildStripQuery,
  normalizeZoneFrame
} from "../js/core/ambilight/ambilightController.js";

function memoryBackend(initial) {
  const data = new Map(
    initial === undefined ? [] : [["ambilightSettings", JSON.parse(JSON.stringify(initial))]]
  );
  return {
    data,
    writes: 0,
    get(key, fallback) {
      return data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : fallback;
    },
    set(key, value) {
      this.writes += 1;
      data.set(key, JSON.parse(JSON.stringify(value)));
    }
  };
}

test("ambilight settings keep only known positions and levels", () => {
  assert.equal(normalizeAmbilightSettings({ level: "x" }).level, 100);
  assert.equal(normalizeAmbilightSettings({ level: 250 }).level, 100);
  const settings = normalizeAmbilightSettings({
    enabled: 1,
    level: 33,
    positions: { a: "LEFT", b: "top", c: "off" },
    maxBrightness: { a: 40, b: 100, c: "nope", d: 72 },
    bulbs: [
      { id: "a", name: "Desk left", pos: "center" },
      { id: "a", name: "dup" },
      { id: "", name: "x" },
      { id: "c" }
    ]
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.level, 30); // rounded to the slider's 10% steps
  assert.deepEqual(settings.positions, { a: "left", c: "off" });
  assert.deepEqual(settings.maxBrightness, { a: 40, d: 70 });
  assert.deepEqual(settings.bulbs, [
    { id: "a", name: "Desk left", pos: "center" },
    { id: "c", name: "c", pos: "center" }
  ]);
});

test("defaults hold the whole configuration, including the strip address and DDP port", () => {
  const settings = normalizeAmbilightSettings({});
  assert.deepEqual(settings, normalizeAmbilightSettings(AMBILIGHT_SETTINGS_DEFAULTS));
  assert.equal(settings.version, AMBILIGHT_SETTINGS_VERSION);
  assert.equal(settings.enabled, false);
  assert.equal(settings.blackoutOnPause, true);
  assert.deepEqual(settings.strip, {
    enabled: false,
    start: "bl",
    clockwise: true,
    level: 60,
    ip: "192.168.129.20",
    port: 4048,
    saturation: 130,
    smoothing: "medium",
    layout: "edges-8"
  });
});

test("a version 1 stored shape migrates with its values kept and the new fields defaulted", () => {
  const v1 = {
    enabled: true,
    level: 70,
    positions: { a: "right" },
    maxBrightness: { a: 50 },
    strip: { enabled: true, start: "tr", clockwise: false, level: 40 },
    bulbs: [{ id: "a", name: "Desk", pos: "left" }]
  };
  const backend = memoryBackend(v1);
  const store = createAmbilightSettingsStore(backend);
  const settings = store.get();
  assert.equal(settings.version, AMBILIGHT_SETTINGS_VERSION);
  assert.equal(settings.enabled, true);
  assert.equal(settings.level, 70);
  assert.deepEqual(settings.positions, { a: "right" });
  assert.deepEqual(settings.maxBrightness, { a: 50 });
  assert.equal(settings.blackoutOnPause, true);
  assert.deepEqual(settings.strip, {
    enabled: true,
    start: "tr",
    clockwise: false,
    level: 40,
    ip: "192.168.129.20",
    port: 4048,
    saturation: 130,
    smoothing: "medium",
    layout: "edges-8"
  });
  // migrated once and written back; reading again does not write
  assert.equal(backend.writes, 1);
  assert.equal(backend.data.get("ambilightSettings").version, AMBILIGHT_SETTINGS_VERSION);
  store.get();
  assert.equal(backend.writes, 1);
});

test("an empty store returns defaults without writing", () => {
  const backend = memoryBackend();
  const store = createAmbilightSettingsStore(backend);
  assert.equal(store.get().strip.ip, "192.168.129.20");
  assert.equal(backend.writes, 0);
});

test("strip fields are validated: address, port, saturation steps, smoothing, layout", () => {
  const strip = (value) => normalizeAmbilightSettings({ strip: value }).strip;
  assert.equal(strip({ ip: " 10.0.0.007 " }).ip, "10.0.0.7");
  assert.equal(strip({ ip: "300.1.1.1" }).ip, "192.168.129.20");
  assert.equal(strip({ ip: "strip.local" }).ip, "192.168.129.20");
  assert.equal(strip({ port: 70000 }).port, 4048);
  assert.equal(strip({ port: "4049" }).port, 4049);
  assert.equal(strip({ saturation: 140 }).saturation, 130); // nearest step
  assert.equal(strip({ saturation: 400 }).saturation, 170);
  assert.equal(strip({ saturation: -1 }).saturation, 130);
  assert.equal(strip({ smoothing: "HIGH" }).smoothing, "high");
  assert.equal(strip({ smoothing: "silky" }).smoothing, "medium");
  assert.equal(strip({ layout: "edges-12" }).layout, "edges-8");
  assert.equal(normalizeAmbilightIp("1.2.3"), "");
  assert.equal(normalizeAmbilightSettings({ blackoutOnPause: false }).blackoutOnPause, false);
});

test("the store saves partial strip changes without losing the rest", () => {
  const store = createAmbilightSettingsStore(memoryBackend());
  store.setStrip({ enabled: true, ip: "10.1.1.9" });
  store.setStrip({ smoothing: "low" });
  store.setBlackoutOnPause(false);
  const settings = store.get();
  assert.equal(settings.strip.enabled, true);
  assert.equal(settings.strip.ip, "10.1.1.9");
  assert.equal(settings.strip.smoothing, "low");
  assert.equal(settings.blackoutOnPause, false);
});

test("the app sends each bulb's chosen position and brightness cap, falling back to the packaged one", () => {
  const settings = normalizeAmbilightSettings({
    positions: { a: "right" },
    maxBrightness: { "b:1": 60 },
    bulbs: [
      { id: "a", name: "Desk right", pos: "center" },
      { id: "b:1", name: "Right", pos: "left" }
    ]
  });
  assert.equal(getBulbPosition(settings, settings.bulbs[1]), "left");
  assert.equal(buildAssignQuery(settings), "a:right:100,b%3A1:left:60");
});

test("start/config requests carry the whole strip configuration from the store", () => {
  const settings = normalizeAmbilightSettings({
    bulbs: [{ id: "a", name: "A", pos: "left" }],
    blackoutOnPause: false,
    strip: {
      enabled: true,
      start: "BR",
      clockwise: false,
      level: 45,
      ip: "10.0.0.5",
      saturation: 150,
      smoothing: "high"
    }
  });
  assert.equal(settings.strip.start, "br");
  assert.equal(settings.strip.level, 50);
  assert.equal(
    buildStripQuery(settings),
    "&strip=on&stripIp=10.0.0.5&ddpPort=4048&stripStart=4&stripDir=ccw&stripBright=50&stripSat=150&stripSmooth=high&zones=8"
  );
  assert.equal(normalizeAmbilightSettings({ strip: { start: "up" } }).strip.start, "bl");
  assert.equal(buildStripQuery(normalizeAmbilightSettings({})), "&strip=off");
  const query = buildConfigQuery(settings, { external: true });
  assert.ok(
    query.startsWith("level=100&assign=a%3Aleft%3A100&pause=hold&source=external&strip=on"),
    query
  );
  assert.ok(
    buildConfigQuery(normalizeAmbilightSettings({})).includes(
      "&pause=black&source=capture&strip=off"
    )
  );
});

test("zone frames are validated and packed as 8 x rrggbb", () => {
  const zones = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [1, 2, 3],
    [300, -4, 7.6],
    [0, 0, 0],
    [0, 0, 0],
    [16, 16, 16]
  ];
  const frame = normalizeZoneFrame({ zones, frameId: 7, ptsMs: 1234.4 });
  assert.equal(
    frame.hex,
    "ff0000" + "00ff00" + "0000ff" + "010203" + "ff0008" + "000000" + "000000" + "101010"
  );
  assert.equal(frame.frameId, 7);
  assert.equal(frame.ptsMs, 1234);
  assert.equal(normalizeZoneFrame({ zones: zones.slice(0, 7) }), null);
  assert.equal(normalizeZoneFrame({ zones: [...zones.slice(0, 7), [1, 2]] }), null);
  assert.equal(normalizeZoneFrame(null), null);
});
