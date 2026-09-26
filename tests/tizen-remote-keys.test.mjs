import assert from "node:assert/strict";
import test from "node:test";

import { normalizeKeyEvent } from "../js/platform/sharedKeys.js";
import { tizenAdapter } from "../js/platform/adapters/tizenAdapter.js";

test("Samsung Return key name remains Enter while hardware Back stays Back", () => {
  const enter = normalizeKeyEvent({ keyName: "Return" }, [461, 10009, 27, 8]);
  assert.equal(enter.keyCode, 13);
  assert.equal(enter.isEnter, true);
  assert.equal(enter.isBack, false);

  const back = normalizeKeyEvent({ keyName: "Back", keyCode: 10009 }, [461, 10009, 27, 8]);
  assert.equal(back.isBack, true);
  assert.equal(back.isEnter, false);
});

test("Samsung media keys are never misclassified as Back", () => {
  for (const event of [
    { keyName: "MediaPlayPause", keyCode: 10252 },
    { keyName: "MediaPlay", keyCode: 415 },
    { keyName: "MediaPause", keyCode: 19 },
    { keyName: "MediaFastForward", keyCode: 417 },
    { keyName: "MediaRewind", keyCode: 412 }
  ]) {
    assert.equal(normalizeKeyEvent(event, [461, 10009, 27, 8]).isBack, false);
  }
});

test("Tizen adapter registers the complete transport-key batch", () => {
  const previousTizen = globalThis.tizen;
  const batches = [];
  try {
    globalThis.tizen = {
      tvinputdevice: {
        registerKeyBatch(keys) {
          batches.push([...keys]);
        }
      }
    };
    tizenAdapter.init();
    assert.deepEqual(batches, [[
      "MediaPlayPause",
      "MediaPlay",
      "MediaPause",
      "MediaStop",
      "MediaFastForward",
      "MediaRewind",
      "MediaTrackPrevious",
      "MediaTrackNext"
    ]]);
  } finally {
    globalThis.tizen = previousTizen;
  }
});
