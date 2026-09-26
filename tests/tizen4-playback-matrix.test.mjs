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
      ["google-hls-hlsjs", "hls.js"],
      ["google-dash-dashjs", "dash.js"]
    ]
  );
  assert.equal(cases[0].source.url, "http://192.0.2.1/probe.mp4");
  assert.equal(cases[2].source.sourceType, "application/dash+xml");
  assert.ok(cases.every(({ source }) => source.addonId === "tizen4-playback-matrix"));
});

test("Tizen 4 playback matrix scores time progression and stalls", () => {
  assert.deepEqual(scoreTizen4PlaybackResult({ progressMs: 0 }), { verdict: "FAIL", score: 0 });
  assert.equal(scoreTizen4PlaybackResult({ progressMs: 5000, startupMs: 1000, stalls: 0 }).verdict, "PASS");
  assert.equal(scoreTizen4PlaybackResult({ progressMs: 5000, startupMs: 1000, stalls: 4 }).verdict, "PARTIAL");
  assert.deepEqual(scoreTizen4PlaybackResult({ progressMs: 5000, error: "seek failed" }), {
    verdict: "FAIL",
    score: 0
  });
});

test("Tizen 4 playback matrix can add controlled on-device P2P cases", () => {
  const cases = createTizen4PlaybackMatrixCases(
    "https://app.test/index.html",
    "http://192.0.2.1/probe.mp4",
    true
  );
  assert.deepEqual(
    cases.slice(-2).map(({ id, engine, viaP2p }) => [id, engine, viaP2p]),
    [
      ["sintel-p2p-html", "html", true],
      ["sintel-p2p-avplay", "avplay", true]
    ]
  );
  assert.ok(cases.slice(-2).every(({ exerciseLifecycle }) => exerciseLifecycle));
});
