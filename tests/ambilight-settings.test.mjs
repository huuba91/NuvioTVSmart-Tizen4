import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAmbilightSettings,
  getBulbPosition
} from "../js/data/local/ambilightSettingsStore.js";
import { buildAssignQuery } from "../js/core/ambilight/ambilightController.js";

test("ambilight settings keep only known positions and levels", () => {
  const settings = normalizeAmbilightSettings({
    enabled: 1,
    level: 33,
    positions: { a: "LEFT", b: "top", c: "off" },
    bulbs: [
      { id: "a", name: "Desk left", pos: "center" },
      { id: "a", name: "dup" },
      { id: "", name: "x" },
      { id: "c" }
    ]
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.level, 100);
  assert.deepEqual(settings.positions, { a: "left", c: "off" });
  assert.deepEqual(settings.bulbs, [
    { id: "a", name: "Desk left", pos: "center" },
    { id: "c", name: "c", pos: "center" }
  ]);
});

test("the app sends each bulb's chosen position, falling back to the packaged one", () => {
  const settings = normalizeAmbilightSettings({
    positions: { a: "right" },
    bulbs: [
      { id: "a", name: "Desk right", pos: "center" },
      { id: "b:1", name: "Right", pos: "left" }
    ]
  });
  assert.equal(getBulbPosition(settings, settings.bulbs[1]), "left");
  assert.equal(buildAssignQuery(settings), "a:right,b%3A1:left");
});
