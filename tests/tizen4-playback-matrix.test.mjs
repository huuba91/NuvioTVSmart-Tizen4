import assert from "node:assert/strict";
import test from "node:test";

import {
  createTizen4PlaybackMatrixCases,
  scoreTizen4PlaybackResult
} from "../js/core/player/tizen4PlaybackMatrix.js";

test("Tizen 4 playback matrix compares controlled HTTP with direct HTTPS native and MSE paths", () => {
  const cases = createTizen4PlaybackMatrixCases("https://app.test/index.html", "http://192.0.2.1/probe.mp4");
  assert.deepEqual(
    cases.map(({ id, engine }) => [id, engine]),
    [
      ["controlled-http-html", "html"],
      ["controlled-http-avplay", "avplay"],
      ["direct-https-mp4-html", "html"],
      ["direct-https-hls-hlsjs", "hls.js"],
      ["direct-https-hls-avplay", "avplay"],
      ["direct-https-mp4-avplay", "avplay"]
    ]
  );
  assert.equal(cases[0].source.url, "http://192.0.2.1/probe.mp4");
  assert.equal(cases[3].source.sourceType, "application/vnd.apple.mpegurl");
  assert.ok(cases.every(({ source }) => source.addonId === "tizen4-playback-matrix"));
});

test("Tizen 4 playback matrix scores time progression and stalls", () => {
  assert.deepEqual(scoreTizen4PlaybackResult({ progressMs: 0 }), { verdict: "FAIL", score: 0 });
  assert.equal(scoreTizen4PlaybackResult({ progressMs: 5000, startupMs: 1000, stalls: 0 }).verdict, "PASS");
  assert.equal(scoreTizen4PlaybackResult({ progressMs: 5000, startupMs: 1000, stalls: 4 }).verdict, "PARTIAL");
});
