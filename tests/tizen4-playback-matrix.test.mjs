import assert from "node:assert/strict";
import test from "node:test";

import {
  createTizen4PlaybackMatrixCases,
  scoreTizen4PlaybackResult
} from "../js/core/player/tizen4PlaybackMatrix.js";

test("Tizen 4 playback matrix covers add-on-shaped HTML and AVPlay sources", () => {
  const cases = createTizen4PlaybackMatrixCases("https://app.test/index.html");
  assert.deepEqual(
    cases.map(({ id, engine }) => [id, engine]),
    [
      ["packaged-html", "html"],
      ["remote-mp4-html", "html"],
      ["remote-mp4-avplay", "avplay"],
      ["remote-hls-html", "html"],
      ["remote-hls-avplay", "avplay"]
    ]
  );
  assert.equal(cases[0].source.url, "https://app.test/assets/tizen4-probe.mp4");
  assert.ok(cases.every(({ source }) => source.addonId === "tizen4-playback-matrix"));
});

test("Tizen 4 playback matrix scores time progression and stalls", () => {
  assert.deepEqual(scoreTizen4PlaybackResult({ progressMs: 0 }), { verdict: "FAIL", score: 0 });
  assert.equal(scoreTizen4PlaybackResult({ progressMs: 5000, startupMs: 1000, stalls: 0 }).verdict, "PASS");
  assert.equal(scoreTizen4PlaybackResult({ progressMs: 5000, startupMs: 1000, stalls: 4 }).verdict, "PARTIAL");
});
