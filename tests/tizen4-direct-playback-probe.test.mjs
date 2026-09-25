import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPlaybackSource,
  streamDirectPlaybackUrl
} from "../js/core/streams/playbackSource.js";
import {
  createTizen4DirectPlaybackProbe,
  TIZEN4_DIRECT_PLAYBACK_PROBE_URL
} from "../js/core/streams/tizen4DirectPlaybackProbe.js";

test("controlled Tizen 4 probe follows direct add-on stream normalization", () => {
  const stream = createTizen4DirectPlaybackProbe();
  assert.equal(stream.url, TIZEN4_DIRECT_PLAYBACK_PROBE_URL);
  assert.equal(streamDirectPlaybackUrl(stream), TIZEN4_DIRECT_PLAYBACK_PROBE_URL);
  assert.deepEqual(classifyPlaybackSource(stream), {
    kind: "direct-http",
    url: TIZEN4_DIRECT_PLAYBACK_PROBE_URL
  });
  assert.equal(stream.mimeType, "video/mp4");
  assert.equal(stream.addonName, "Tizen 4 diagnostics");
  assert.equal(stream.behaviorHints.filename, "w3c-sintel-trailer.mp4");
});
