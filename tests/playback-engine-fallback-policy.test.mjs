import assert from "node:assert/strict";
import test from "node:test";

import { canFallbackFromPlaybackEngine } from "../js/core/player/playbackEngineFallbackPolicy.js";

test("automatic playback selection permits backend fallback", () => {
  assert.equal(canFallbackFromPlaybackEngine(null), true);
  assert.equal(canFallbackFromPlaybackEngine(""), true);
});

test("a diagnostic engine override never falls through to another backend", () => {
  assert.equal(canFallbackFromPlaybackEngine("native-file"), false);
  assert.equal(canFallbackFromPlaybackEngine("tizen-avplay"), false);
});
