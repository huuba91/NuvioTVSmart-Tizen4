import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyEngineSelection } from "./fixtures/legacyPlaybackEngineSelection.mjs";
import {
  decidePlayback,
  decideAmbilightSource
} from "../js/core/player/backends/playbackDecision.js";
import { inspectStream } from "../js/core/player/inspection/streamInspection.js";

// Each test file runs in its own process; keep a quiet in-memory store for the
// settings reads PlayerController does while deciding.
globalThis.localStorage = {
  getItem() {
    return null;
  },
  setItem() {},
  removeItem() {}
};
const { PlayerController, Platform } = await import("../js/core/player/playerController.js");

const ENGINEFS_URL = "http://127.0.0.1:11470/0123456789abcdef0123456789abcdef01234567/0";

// Representative sources: [label, url, declared source type]
const SOURCES = [
  ["remote mkv", "https://cdn.example.test/movies/Movie.2160p.HEVC.mkv", null],
  ["remote mp4", "https://cdn.example.test/movies/movie.mp4", null],
  ["remote mp4 declared", "https://cdn.example.test/play/12345", "video/mp4"],
  ["remote matroska declared", "https://cdn.example.test/play/12345", "video/x-matroska"],
  ["remote no extension", "https://cdn.example.test/play/12345", null],
  ["debrid download", "https://abc.download.real-debrid.com/d/XYZ/Movie.1080p.x264.mkv", null],
  ["enginefs local", ENGINEFS_URL, null],
  ["localhost file", "http://localhost:8080/file.mkv", null],
  ["hls m3u8", "https://cdn.example.test/live/index.m3u8", null],
  ["hls query", "https://cdn.example.test/stream?format=hls", null],
  [
    "hls nested",
    "https://proxy.example.test/get?url=https%3A%2F%2Fcdn.example.test%2Fa%2Fmaster.m3u8",
    null
  ],
  ["hls declared x-mpegURL", "https://cdn.example.test/channel/7", "application/x-mpegURL"],
  ["hls playlist path", "https://cdn.example.test/playlist/7", null],
  ["dash mpd", "https://cdn.example.test/manifest.mpd", null],
  ["dash declared", "https://cdn.example.test/channel/8", "application/dash+xml"],
  ["smooth streaming", "https://cdn.example.test/video.ism/manifest", null],
  ["empty url", "", null]
];
const ITEM_TYPES = ["movie", "series", "channel", "tv"];

function* flagCombinations() {
  for (let mask = 0; mask < 1 << 9; mask += 1) {
    const bit = (index) => Boolean(mask & (1 << index));
    yield {
      isTizenRuntime: bit(0),
      canUseAvPlay: bit(1),
      preferTvNative: bit(2),
      canUseHlsJs: bit(3),
      canUseDashJs: bit(4),
      canPlayNativeHls: bit(5),
      canPlayNativeDash: bit(6),
      canPlayNativeSmooth: bit(7),
      avplayEngine: bit(8) ? "tizen-avplay" : "none"
    };
  }
}

function withPlatform(name, run) {
  const previous = Platform.getName;
  Platform.getName = () => name;
  try {
    return run();
  } finally {
    Platform.getName = previous;
  }
}

function createRuntime(flags) {
  const base = Object.create(PlayerController);
  Object.assign(base, {
    currentSeason: null,
    currentEpisode: null,
    currentItemType: "movie",
    playbackEngine: "none",
    playbackEngineAttempts: new Map(),
    currentTizenHlsProxyBaseUrl: "",
    getPlatformAvplayEngineName: () => flags.avplayEngine,
    canUseAvPlay: () => flags.canUseAvPlay,
    shouldPreferTvNativePipeline: () => flags.preferTvNative,
    canUseHlsJs: () => flags.canUseHlsJs,
    canUseDashJs: () => flags.canUseDashJs,
    canPlayNatively: (mimeType) =>
      ({
        "application/vnd.apple.mpegurl": flags.canPlayNativeHls,
        "application/dash+xml": flags.canPlayNativeDash,
        "application/vnd.ms-sstr+xml": flags.canPlayNativeSmooth
      })[mimeType] || false
  });
  const legacy = Object.assign(Object.create(base), createLegacyEngineSelection(Platform));
  return { current: base, legacy };
}

function decisionFor(runtime, url, sourceType, itemType, settings = {}) {
  const inspection = inspectStream(
    {},
    {
      url,
      sourceType,
      urlMimeType: runtime.guessMediaMimeType(url),
      isLive: runtime.isLivePlaybackItemType(itemType)
    }
  );
  return decidePlayback(inspection, { engines: runtime.getPlaybackEngineFlags() }, settings);
}

test("engineCandidates and preferredEngine equal the pre-refactor engine ladder for every input", () => {
  let compared = 0;
  for (const flags of flagCombinations()) {
    withPlatform(flags.isTizenRuntime ? "tizen" : "browser", () => {
      const { current, legacy } = createRuntime(flags);
      for (const [label, url, sourceType] of SOURCES) {
        for (const itemType of ITEM_TYPES) {
          const context = `${label} ${itemType} ${JSON.stringify(flags)}`;
          const expectedCandidates = legacy.getPlaybackEngineCandidates(url, sourceType, itemType);
          const expectedEngine = legacy.choosePlaybackEngine(url, sourceType, itemType);
          assert.deepEqual(
            current.getPlaybackEngineCandidates(url, sourceType, itemType),
            expectedCandidates,
            context
          );
          assert.equal(
            current.choosePlaybackEngine(url, sourceType, itemType),
            expectedEngine,
            context
          );
          const decision = decisionFor(current, url, sourceType, itemType);
          assert.deepEqual(decision.engineCandidates, expectedCandidates, context);
          assert.equal(decision.preferredEngine, expectedEngine, context);
          compared += 1;
        }
      }
    });
  }
  assert.equal(compared, 512 * SOURCES.length * ITEM_TYPES.length);
});

test("getAlternativePlaybackEngine matches the pre-refactor fallback choice", () => {
  const flags = {
    isTizenRuntime: true,
    canUseAvPlay: true,
    preferTvNative: true,
    canUseHlsJs: true,
    canUseDashJs: true,
    canPlayNativeHls: true,
    canPlayNativeDash: false,
    canPlayNativeSmooth: false,
    avplayEngine: "tizen-avplay"
  };
  for (const platform of ["tizen", "browser"]) {
    withPlatform(platform, () => {
      for (const [label, url, sourceType] of SOURCES) {
        for (const engine of [
          "none",
          "tizen-avplay",
          "hls.js",
          "native-hls",
          "native-file",
          "dash.js"
        ]) {
          for (const proxyBase of ["", "http://127.0.0.1:2710"]) {
            const { current, legacy } = createRuntime({
              ...flags,
              isTizenRuntime: platform === "tizen"
            });
            for (const runtime of [current, legacy]) {
              runtime.playbackEngine = engine;
              runtime.currentTizenHlsProxyBaseUrl = proxyBase;
              runtime.playbackEngineAttempts = new Map([[url, new Set([engine])]]);
            }
            assert.equal(
              current.getAlternativePlaybackEngine(url, sourceType, "movie"),
              legacy.getAlternativePlaybackEngine(url, sourceType, "movie"),
              `${platform} ${label} ${engine} ${proxyBase}`
            );
          }
        }
      }
    });
  }
});

const TIZEN_TV = {
  isTizenRuntime: true,
  canUseAvPlay: true,
  preferTvNative: true,
  canUseHlsJs: true,
  canUseDashJs: false,
  canPlayNativeHls: false,
  canPlayNativeDash: false,
  canPlayNativeSmooth: false,
  avplayEngine: "tizen-avplay"
};

// Readable decision table for the Samsung UE49NU7100 (Tizen 4, AVPlay + hls.js).
const TIZEN_DECISION_TABLE = [
  ["remote mkv", "https://cdn.example.test/m.mkv", null, "movie", ["tizen-avplay"], "tizen-avplay"],
  ["enginefs file", ENGINEFS_URL, null, "movie", ["tizen-avplay", "native-file"], "tizen-avplay"],
  [
    "hls vod",
    "https://cdn.example.test/v.m3u8",
    null,
    "movie",
    ["hls.js", "tizen-avplay"],
    "hls.js"
  ],
  [
    "hls live",
    "https://cdn.example.test/v.m3u8",
    null,
    "channel",
    ["hls.js", "tizen-avplay"],
    "hls.js"
  ],
  [
    "dash vod",
    "https://cdn.example.test/v.mpd",
    null,
    "movie",
    ["tizen-avplay", "dash.js"],
    "tizen-avplay"
  ],
  [
    "smooth",
    "https://cdn.example.test/v.ism/manifest",
    null,
    "movie",
    ["tizen-avplay"],
    "tizen-avplay"
  ]
];

test("Tizen decision table", () => {
  withPlatform("tizen", () => {
    const { current } = createRuntime(TIZEN_TV);
    for (const [label, url, sourceType, itemType, candidates, preferred] of TIZEN_DECISION_TABLE) {
      const decision = decisionFor(current, url, sourceType, itemType);
      assert.deepEqual(decision.engineCandidates, candidates, label);
      assert.equal(decision.preferredEngine, preferred, label);
      assert.ok(decision.reasons.length >= 3, label);
    }
  });
});

test("a forced engine wins over the automatic choice and is explained", () => {
  withPlatform("tizen", () => {
    const { current } = createRuntime(TIZEN_TV);
    const decision = decisionFor(current, "https://cdn.example.test/m.mkv", null, "movie", {
      forceEngine: "native-file"
    });
    assert.equal(decision.preferredEngine, "native-file");
    assert.deepEqual(decision.engineCandidates, ["tizen-avplay"]);
    assert.ok(decision.reasons.some((reason) => reason.includes("forced")));
  });
});

const CAPTURE_ONLY = {
  ambilight: { screenCapture: true },
  pepperAnalysis: { h264: false, hevc: false, hevcMaxHeight: 0 }
};
const PEPPER_ALL = {
  ambilight: { screenCapture: true },
  pepperAnalysis: { h264: true, hevc: true, hevcMaxHeight: 1080 }
};
const PEPPER_NO_CAPTURE = {
  ambilight: { screenCapture: false },
  pepperAnalysis: { h264: true, hevc: true, hevcMaxHeight: 1080 }
};
const NOTHING = {
  ambilight: { screenCapture: false },
  pepperAnalysis: { h264: false, hevc: false, hevcMaxHeight: 0 }
};

function inspection(fields) {
  return {
    videoCodec: null,
    bitDepth: null,
    height: null,
    ...fields,
    confidence: { videoCodec: "filename", ...(fields.confidence || {}) }
  };
}

const AMBILIGHT_TABLE = [
  ["disabled", inspection({ videoCodec: "h264" }), PEPPER_ALL, false, "off"],
  ["unsupported platform", inspection({ videoCodec: "h264" }), NOTHING, true, "off"],
  [
    "production today: h264",
    inspection({ videoCodec: "h264", height: 1080 }),
    CAPTURE_ONLY,
    true,
    "screen-capture"
  ],
  [
    "production today: hevc",
    inspection({ videoCodec: "hevc", height: 1080, bitDepth: 8 }),
    CAPTURE_ONLY,
    true,
    "screen-capture"
  ],
  ["production today: unknown", inspection({}), CAPTURE_ONLY, true, "screen-capture"],
  [
    "pepper h264 from filename",
    inspection({ videoCodec: "h264" }),
    PEPPER_ALL,
    true,
    "pepper-h264"
  ],
  [
    "pepper h264 from metadata",
    inspection({ videoCodec: "h264", confidence: { videoCodec: "metadata" } }),
    PEPPER_ALL,
    true,
    "pepper-h264"
  ],
  [
    "pepper h264 text only",
    inspection({ videoCodec: "h264", confidence: { videoCodec: "text" } }),
    PEPPER_ALL,
    true,
    "screen-capture"
  ],
  [
    "libde265 8-bit 1080p",
    inspection({ videoCodec: "hevc", bitDepth: 8, height: 1080 }),
    PEPPER_ALL,
    true,
    "libde265-hevc"
  ],
  [
    "libde265 unknown depth 720p",
    inspection({ videoCodec: "hevc", height: 720 }),
    PEPPER_ALL,
    true,
    "libde265-hevc"
  ],
  [
    "hevc 10-bit",
    inspection({ videoCodec: "hevc", bitDepth: 10, height: 1080 }),
    PEPPER_ALL,
    true,
    "screen-capture"
  ],
  [
    "hevc too tall",
    inspection({ videoCodec: "hevc", bitDepth: 8, height: 2160 }),
    PEPPER_ALL,
    true,
    "screen-capture"
  ],
  [
    "hevc unknown height",
    inspection({ videoCodec: "hevc", bitDepth: 8 }),
    PEPPER_ALL,
    true,
    "screen-capture"
  ],
  [
    "hevc text only",
    inspection({ videoCodec: "hevc", height: 720, confidence: { videoCodec: "text" } }),
    PEPPER_ALL,
    true,
    "screen-capture"
  ],
  [
    "av1 has no pepper path",
    inspection({ videoCodec: "av1", height: 1080 }),
    PEPPER_ALL,
    true,
    "screen-capture"
  ],
  [
    "av1 without capture",
    inspection({ videoCodec: "av1", height: 1080 }),
    PEPPER_NO_CAPTURE,
    true,
    "off"
  ],
  [
    "pepper only hevc caps",
    inspection({ videoCodec: "h264" }),
    { ...PEPPER_ALL, pepperAnalysis: { h264: false, hevc: true, hevcMaxHeight: 1080 } },
    true,
    "screen-capture"
  ]
];

test("ambilight source decision table", () => {
  for (const [label, inspected, capabilities, enabled, expected] of AMBILIGHT_TABLE) {
    const result = decideAmbilightSource(inspected, capabilities, { ambilightEnabled: enabled });
    assert.equal(result.ambilightSource, expected, label);
    assert.ok(result.reason.startsWith("ambilight:"), label);
  }
});

test("the ambilight source never changes the engine ladder", () => {
  withPlatform("tizen", () => {
    const { current } = createRuntime(TIZEN_TV);
    const inspected = inspectStream(
      { behaviorHints: { filename: "Movie.720p.x265.8bit.mkv" } },
      { url: "https://cdn.example.test/m.mkv", urlMimeType: "video/x-matroska" }
    );
    const engines = current.getPlaybackEngineFlags();
    const off = decidePlayback(inspected, { engines, ...NOTHING }, { ambilightEnabled: false });
    const pepper = decidePlayback(
      inspected,
      { engines, ...PEPPER_ALL },
      { ambilightEnabled: true }
    );
    assert.equal(off.ambilightSource, "off");
    assert.equal(pepper.ambilightSource, "libde265-hevc");
    assert.deepEqual(pepper.engineCandidates, off.engineCandidates);
    assert.equal(pepper.preferredEngine, off.preferredEngine);
  });
});

test("controller capabilities keep pepper analysis off in production", () => {
  withPlatform("tizen", () => {
    const { current } = createRuntime(TIZEN_TV);
    const capabilities = current.getPlaybackDecisionCapabilities();
    assert.deepEqual(capabilities.pepperAnalysis, { h264: false, hevc: false, hevcMaxHeight: 0 });
    assert.equal(capabilities.ambilight.screenCapture, true);
  });
  withPlatform("browser", () => {
    const { current } = createRuntime({ ...TIZEN_TV, isTizenRuntime: false });
    assert.equal(current.getPlaybackDecisionCapabilities().ambilight.screenCapture, false);
  });
});

test("preparePlaybackDecision matches choosePlaybackEngine and is kept per load", () => {
  withPlatform("tizen", () => {
    const { current } = createRuntime(TIZEN_TV);
    current.playbackDecision = null;
    current.playbackFallbackHistory = [];
    for (const [label, url, sourceType] of SOURCES) {
      for (const itemType of ITEM_TYPES) {
        const decision = current.preparePlaybackDecision({ url, sourceType, itemType, stream: {} });
        assert.equal(
          decision.preferredEngine,
          current.choosePlaybackEngine(url, sourceType, itemType),
          `${label} ${itemType}`
        );
        assert.deepEqual(
          decision.engineCandidates,
          current.getPlaybackEngineCandidates(url, sourceType, itemType),
          `${label} ${itemType}`
        );
      }
    }
    const first = current.preparePlaybackDecision({
      url: "https://cdn.example.test/m.mkv",
      itemType: "movie"
    });
    const replay = current.preparePlaybackDecision({
      url: "https://cdn.example.test/m.mkv",
      itemType: "movie",
      forceEngine: "native-file"
    });
    assert.equal(replay, first, "a forced replay of the same source keeps the load's decision");
    const fresh = current.preparePlaybackDecision({
      url: "https://cdn.example.test/m.mkv",
      itemType: "movie"
    });
    assert.notEqual(fresh, first, "a new automatic load computes a new decision");
  });
});
