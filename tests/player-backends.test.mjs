import assert from "node:assert/strict";
import test from "node:test";

import { createAvplayBackend } from "../js/core/player/backends/avplayBackend.js";
import { createHtml5Backend } from "../js/core/player/backends/html5Backend.js";
import {
  createPlayerEventEmitter,
  isPlayerBackend,
  PLAYER_BACKEND_EVENTS,
  timeRangesToArray
} from "../js/core/player/backends/playerBackend.js";

// Each test file runs in its own process; keep a quiet in-memory store for the
// settings reads PlayerController does while deciding.
globalThis.localStorage = {
  getItem() {
    return null;
  },
  setItem() {},
  removeItem() {}
};
const { PlayerController, Platform, TizenPlaybackProxy } =
  await import("../js/core/player/playerController.js");

const ENGINEFS_URL = "http://127.0.0.1:11470/0123456789abcdef0123456789abcdef01234567/0";

function withPlatform(name, run) {
  const previous = Platform.getName;
  Platform.getName = () => name;
  const restore = () => {
    Platform.getName = previous;
  };
  try {
    const result = run();
    if (result && typeof result.then === "function") {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function quietWarnings(run) {
  const previous = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  const restore = () => {
    console.warn = previous;
  };
  try {
    const result = run(warnings);
    if (result && typeof result.then === "function") {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

class FakeVideo extends EventTarget {
  constructor(overrides = {}) {
    super();
    this.currentTime = 0;
    this.duration = NaN;
    this.paused = true;
    this.seeking = false;
    this.ended = false;
    this.readyState = 0;
    this.networkState = 0;
    this.error = null;
    this.volume = 1;
    this.muted = false;
    this.src = "";
    this.currentSrc = "";
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.playCalls = 0;
    this.playResult = () => Promise.resolve();
    Object.assign(this, overrides);
  }
  querySelectorAll() {
    return [];
  }
  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
  getAttribute(name) {
    return name === "src" ? this.src || null : null;
  }
  load() {}
  pause() {
    this.paused = true;
  }
  play() {
    this.playCalls += 1;
    return this.playResult();
  }
  canPlayType() {
    return "";
  }
}

function createFakeAvplay(state = "PLAYING") {
  return {
    state,
    calls: [],
    open() {},
    getState() {
      return this.state;
    },
    getCurrentTime() {
      return 42_000;
    },
    getDuration() {
      return 120_000;
    },
    pause() {
      this.calls.push("pause");
    },
    play() {
      this.calls.push("play");
    },
    getCurrentStreamInfo() {
      return [
        { index: 0, type: "VIDEO", extra_info: '{"fourCC":"HEVC","Width":"1920","Height":"1080"}' },
        { index: 1, type: "AUDIO", extra_info: '{"fourCC":"AAC","language":"eng"}' }
      ];
    },
    getTotalTrackInfo() {
      return [];
    }
  };
}

function createController(overrides = {}) {
  const controller = Object.create(PlayerController);
  Object.assign(controller, {
    video: new FakeVideo(),
    playbackEngine: "none",
    avplayActive: false,
    avplayReady: false,
    avplayEnded: false,
    avplaySeekInFlight: false,
    avplayCurrentTimeMs: 0,
    avplayDurationMs: 0,
    avplayAudioTracks: [],
    avplaySubtitleTracks: [],
    lastKnownDurationSeconds: 0,
    currentItemType: "movie",
    currentSeason: null,
    currentEpisode: null,
    playbackDecision: null,
    playbackDecisionKey: "",
    playbackInspection: null,
    playbackInspectionContext: null,
    playbackFallbackHistory: [],
    playbackEngineAttempts: new Map(),
    avplayFallbackAttempts: new Set(),
    playerEventEmitter: null,
    playerEventBridgeVideo: null,
    avplayBackendAdapter: null,
    html5BackendAdapter: null,
    progressSaveTimer: null,
    progressSeekSyncTimer: null,
    avplayTickTimer: null,
    playRequestToken: 0,
    ...overrides
  });
  return controller;
}

test("the event emitter isolates handler failures", () => {
  quietWarnings((warnings) => {
    const emitter = createPlayerEventEmitter();
    const seen = [];
    const failing = () => {
      throw new Error("boom");
    };
    emitter.on("playing", failing);
    emitter.on("playing", (payload) => seen.push(payload));
    emitter.on("playing", (payload) => seen.push(payload));
    emitter.emit("playing", 1);
    assert.deepEqual(seen, [1, 1]);
    assert.equal(warnings.length, 1);
    emitter.off("playing", failing);
    assert.equal(emitter.count("playing"), 2);
  });
});

test("timeRangesToArray reads TimeRanges and survives broken objects", () => {
  const ranges = { length: 2, start: (index) => [0, 30][index], end: (index) => [10, 45][index] };
  assert.deepEqual(timeRangesToArray(ranges), [
    { start: 0, end: 10 },
    { start: 30, end: 45 }
  ]);
  assert.deepEqual(
    timeRangesToArray({
      length: 1,
      start() {
        throw new Error("changed");
      }
    }),
    []
  );
  assert.deepEqual(timeRangesToArray(null), []);
});

test("AVPlay backend adapts PlayerController's AVPlay state", () => {
  const avplay = createFakeAvplay("PAUSED");
  const previousWebapis = globalThis.webapis;
  globalThis.webapis = { avplay };
  try {
    withPlatform("tizen", () => {
      const controller = createController({
        playbackEngine: "tizen-avplay",
        avplayActive: true,
        avplayReady: true,
        avplayAudioTracks: [{ id: "avplay-audio-1", avplayTrackIndex: 1, codec: "AAC" }],
        avplaySubtitleTracks: [{ id: "avplay-text-2" }]
      });
      const backend = controller.getActiveBackend();
      assert.equal(backend.name, "avplay");
      assert.equal(backend.engine, "tizen-avplay");
      assert.ok(isPlayerBackend(backend));
      assert.equal(backend.getCurrentTime(), 42);
      assert.equal(backend.getDuration(), 120);
      assert.deepEqual(backend.getBufferedRanges(), []);
      assert.equal(backend.getReadyState(), 4);
      assert.equal(backend.isPaused(), true);
      avplay.state = "PLAYING";
      assert.equal(backend.isPaused(), false);
      assert.equal(backend.isSeeking(), false);
      controller.avplaySeekInFlight = true;
      assert.equal(backend.isSeeking(), true);
      controller.avplaySeekInFlight = false;
      assert.equal(backend.setVolume(0.5), false, "AVPlay has no app-level volume");
      assert.equal(backend.getVolume(), null);
      assert.deepEqual(
        backend.getAudioTracks().map((track) => track.id),
        ["avplay-audio-1"]
      );
      assert.deepEqual(
        backend.getSubtitleTracks().map((track) => track.id),
        ["avplay-text-2"]
      );
      assert.equal(controller.getActiveBackend(), backend, "the adapter is reused");
      assert.equal(controller.getPlaybackInfo().backend, "avplay");
    });
  } finally {
    globalThis.webapis = previousWebapis;
  }
});

test("HTML5 backend adapts the video element and the MSE engines", () => {
  withPlatform("browser", () => {
    const video = new FakeVideo({
      currentTime: 10,
      duration: 100,
      paused: false,
      seeking: true,
      readyState: 3,
      buffered: { length: 1, start: () => 0, end: () => 50 },
      textTracks: [{ id: "t1" }, { id: "t2" }],
      audioTracks: [{ id: "a1" }]
    });
    const controller = createController({ video, playbackEngine: "native-file" });
    const backend = controller.getActiveBackend();
    assert.equal(backend.name, "html5");
    assert.equal(backend.engine, "native-file");
    assert.ok(isPlayerBackend(backend));
    assert.equal(backend.getCurrentTime(), 10);
    assert.equal(backend.getDuration(), 100);
    assert.deepEqual(backend.getBufferedRanges(), [{ start: 0, end: 50 }]);
    assert.equal(backend.isPaused(), false);
    assert.equal(backend.isSeeking(), true);
    assert.equal(backend.getReadyState(), 3);
    assert.equal(backend.setVolume(0.25), true);
    assert.equal(video.volume, 0.25);
    backend.setVolume(4);
    assert.equal(video.volume, 1);
    assert.equal(backend.getVolume(), 1);
    assert.deepEqual(
      backend.getSubtitleTracks().map((track) => track.id),
      ["t1", "t2"]
    );
    assert.deepEqual(
      backend.getAudioTracks().map((track) => track.id),
      ["a1"]
    );

    controller.playbackEngine = "hls.js";
    controller.hlsInstance = {
      audioTracks: [{ name: "en" }, { name: "de" }],
      subtitleTracks: [{ name: "nl" }],
      audioTrack: 0
    };
    assert.equal(backend.engine, "hls.js", "the adapter follows the active HTML5 engine");
    assert.equal(backend.getAudioTracks().length, 2);
    assert.equal(backend.getSubtitleTracks().length, 1);

    controller.playbackEngine = "none";
    assert.equal(controller.getActiveBackend(), null);
  });
});

function createRecordingController() {
  const calls = [];
  const record =
    (name, result = true) =>
    (...args) => {
      calls.push([name, ...args]);
      return result;
    };
  return {
    calls,
    playbackEngine: "dash.js",
    video: new FakeVideo(),
    getPlatformAvplayEngineName: () => "tizen-avplay",
    play: record("play", Promise.resolve()),
    resume: record("resume"),
    pause: record("pause"),
    stop: record("stop"),
    seekToSeconds: record("seekToSeconds"),
    getDurationSeconds: () => 5,
    getCurrentTimeSeconds: () => 1,
    isPlaybackEnded: () => false,
    getPlaybackReadyState: () => 2,
    getAvPlayState: () => "PLAYING",
    getAvPlayAudioTracks: () => ["avplay-audio"],
    getAvPlaySubtitleTracks: () => ["avplay-text"],
    setAvPlayAudioTrack: record("setAvPlayAudioTrack"),
    setAvPlaySubtitleTrack: record("setAvPlaySubtitleTrack"),
    getHlsAudioTracks: () => ["hls-audio"],
    getHlsSubtitleTracks: () => ["hls-text"],
    setHlsAudioTrack: record("setHlsAudioTrack"),
    setHlsSubtitleTrack: record("setHlsSubtitleTrack"),
    getDashAudioTracks: () => ["dash-audio"],
    getDashTextTracks: () => ["dash-text"],
    setDashAudioTrack: record("setDashAudioTrack"),
    setDashTextTrack: record("setDashTextTrack"),
    nativeAudioTrackListToArray: () => ["native-audio"],
    setNativeAudioTrack: record("setNativeAudioTrack"),
    setNativeTextTrack: record("setNativeTextTrack"),
    on: record("on"),
    off: record("off")
  };
}

test("backend adapters delegate to the existing PlayerController methods", async () => {
  const controller = createRecordingController();
  const avplay = createAvplayBackend(controller);
  await avplay.load("https://cdn.example.test/m.mkv", { itemType: "movie" });
  avplay.play();
  avplay.pause();
  avplay.seek(12);
  avplay.stop({ flushProgress: false });
  avplay.selectAudioTrack(3);
  avplay.selectSubtitleTrack(4);
  assert.deepEqual(controller.calls, [
    ["play", "https://cdn.example.test/m.mkv", { itemType: "movie", forceEngine: "tizen-avplay" }],
    ["resume"],
    ["pause"],
    ["seekToSeconds", 12],
    ["stop", { flushProgress: false }],
    ["setAvPlayAudioTrack", 3],
    ["setAvPlaySubtitleTrack", 4]
  ]);

  controller.calls.length = 0;
  const dash = createHtml5Backend(controller);
  assert.equal(dash.engine, "dash.js");
  assert.deepEqual(dash.getAudioTracks(), ["dash-audio"]);
  assert.deepEqual(dash.getSubtitleTracks(), ["dash-text"]);
  dash.selectAudioTrack(1);
  dash.selectSubtitleTrack(0);
  controller.playbackEngine = "hls.js";
  assert.deepEqual(dash.getAudioTracks(), ["hls-audio"]);
  dash.selectAudioTrack(2);
  dash.selectSubtitleTrack(-1);
  controller.playbackEngine = "native-hls";
  assert.deepEqual(dash.getAudioTracks(), ["native-audio"]);
  dash.selectAudioTrack(0);
  dash.selectSubtitleTrack(1);
  await createHtml5Backend(controller, "native-file").load("https://cdn.example.test/a.mp4");
  const handler = () => {};
  dash.on("playing", handler);
  dash.off("playing", handler);
  assert.deepEqual(controller.calls, [
    ["setDashAudioTrack", 1],
    ["setDashTextTrack", 0],
    ["setHlsAudioTrack", 2],
    ["setHlsSubtitleTrack", -1],
    ["setNativeAudioTrack", 0],
    ["setNativeTextTrack", 1],
    ["play", "https://cdn.example.test/a.mp4", { forceEngine: "native-file" }],
    ["on", "playing", handler],
    ["off", "playing", handler]
  ]);
});

test("PlayerController.on/off emits neutral events for HTML5 and AVPlay engines", () => {
  withPlatform("browser", () => {
    const controller = createController({ playbackEngine: "native-file" });
    controller.bindPlayerEventBridge();
    controller.bindPlayerEventBridge();
    const seen = [];
    const handlers = {};
    for (const eventName of PLAYER_BACKEND_EVENTS) {
      handlers[eventName] = (payload) => seen.push(payload);
      controller.on(eventName, handlers[eventName]);
    }
    const video = controller.video;
    for (const mediaEvent of [
      "canplay",
      "playing",
      "pause",
      "seeking",
      "seeked",
      "timeupdate",
      "waiting",
      "ended",
      "error",
      "loadedmetadata"
    ]) {
      video.dispatchEvent(new Event(mediaEvent));
    }
    assert.deepEqual(
      seen.map((payload) => payload.type),
      [
        "ready",
        "playing",
        "paused",
        "seeking",
        "seeked",
        "timeupdate",
        "buffering",
        "ended",
        "error",
        "tracks"
      ],
      "each media event is bridged exactly once"
    );
    assert.ok(
      seen.every((payload) => payload.engine === "native-file" && payload.backend === "html5")
    );

    seen.length = 0;
    controller.playbackEngine = "tizen-avplay";
    controller.emitVideoEvent("playing", { playbackEngine: "tizen-avplay" });
    controller.emitVideoEvent("waiting", { playbackEngine: "tizen-avplay" });
    controller.emitVideoEvent("avplaytrackschanged", { playbackEngine: "tizen-avplay" });
    controller.emitVideoEvent("error", { mediaErrorCode: 4 });
    assert.deepEqual(
      seen.map((payload) => [payload.type, payload.backend, payload.sourceEvent]),
      [
        ["playing", "avplay", "playing"],
        ["buffering", "avplay", "waiting"],
        ["tracks", "avplay", "avplaytrackschanged"],
        ["error", "avplay", "error"]
      ]
    );
    assert.equal(seen[3].detail.mediaErrorCode, 4);

    seen.length = 0;
    controller.off("playing", handlers.playing);
    video.dispatchEvent(new Event("playing"));
    assert.equal(seen.length, 0);
  });
});

test("forced replays keep the fallback history; a new load resets it", () => {
  quietWarnings((warnings) => {
    withPlatform("tizen", () => {
      const controller = createController({
        canUseAvPlay: () => true,
        getPlatformAvplayEngineName: () => "tizen-avplay"
      });
      controller.preparePlaybackDecision({
        url: ENGINEFS_URL,
        itemType: "movie",
        stream: { behaviorHints: { filename: "Movie.1080p.x264.mkv" } }
      });
      controller.recordPlaybackFallback(
        "tizen-avplay",
        "native-file",
        "startup-error mediaErrorCode=4"
      );
      controller.preparePlaybackDecision({
        url: ENGINEFS_URL,
        itemType: "movie",
        forceEngine: "native-file"
      });
      const info = controller.getPlaybackInfo();
      assert.deepEqual(
        info.fallbackHistory.map(({ from, to, reason }) => ({ from, to, reason })),
        [{ from: "tizen-avplay", to: "native-file", reason: "startup-error mediaErrorCode=4" }]
      );
      assert.equal(info.inspection.videoCodec, "h264");
      assert.equal(info.decision.preferredEngine, "tizen-avplay");
      assert.equal(
        info.decision.ambilightSource === "off" ||
          info.decision.ambilightSource === "screen-capture",
        true
      );
      assert.deepEqual(warnings, [
        "Playback engine fallback: tizen-avplay -> native-file (startup-error mediaErrorCode=4)"
      ]);

      info.fallbackHistory.push({ from: "x" });
      assert.equal(
        controller.getPlaybackInfo().fallbackHistory.length,
        1,
        "getPlaybackInfo returns a copy"
      );

      controller.preparePlaybackDecision({
        url: "https://cdn.example.test/other.mkv",
        itemType: "movie"
      });
      assert.deepEqual(controller.getPlaybackInfo().fallbackHistory, []);
    });
  });
});

test("engine-reported AVPlay tracks refine the inspection without changing the decision", () => {
  const avplay = createFakeAvplay("PLAYING");
  const previousWebapis = globalThis.webapis;
  globalThis.webapis = { avplay };
  try {
    withPlatform("tizen", () => {
      const controller = createController({ canUseAvPlay: () => true });
      controller.preparePlaybackDecision({
        url: ENGINEFS_URL,
        itemType: "movie",
        stream: { behaviorHints: { filename: "Movie.720p.x264.mkv" } }
      });
      const decision = controller.playbackDecision;
      assert.equal(controller.playbackInspection.videoCodec, "h264");
      controller.playbackEngine = "tizen-avplay";
      controller.avplayActive = true;
      controller.avplayAudioTracks = [{ codec: "AAC" }];
      controller.bindPlayerEventBridge();
      controller.emitVideoEvent("avplaytrackschanged", {});
      const info = controller.getPlaybackInfo();
      assert.equal(info.inspection.videoCodec, "hevc");
      assert.equal(info.inspection.confidence.videoCodec, "metadata");
      assert.equal(info.inspection.height, 1080);
      assert.deepEqual(info.inspection.audioCodecs, ["aac"]);
      assert.equal(info.decision, decision);
    });
  } finally {
    globalThis.webapis = previousWebapis;
  }
});

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("play() records an internal hls.js -> native HLS fallback and emits loading", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { src: "", type: "", remove() {} };
    }
  };
  try {
    await quietWarnings(async (warnings) => {
      await withPlatform("browser", async () => {
        const video = new FakeVideo();
        video.appendChild = () => {};
        const controller = createController({
          video,
          canUseAvPlay: () => false,
          ensureAdaptiveLibrariesForSource: async () => {},
          playWithHlsJs: () => false
        });
        const loading = [];
        controller.on("loading", (payload) => loading.push(payload.detail.url));
        try {
          await controller.play("https://cdn.example.test/live/index.m3u8", {
            itemType: "movie",
            stream: { name: "Addon 1080p", title: "Channel x264 AAC" }
          });
          await settle();
          const info = controller.getPlaybackInfo();
          assert.deepEqual(loading, ["https://cdn.example.test/live/index.m3u8"]);
          assert.equal(info.decision.preferredEngine, "hls.js");
          assert.equal(info.inspection.streamType, "hls");
          assert.equal(info.inspection.videoCodec, "h264");
          assert.equal(controller.playbackEngine, "native-hls");
          assert.equal(info.backend, "html5");
          assert.deepEqual(
            info.fallbackHistory.map(({ from, to, reason }) => [from, to, reason]),
            [["hls.js", "native-hls", "hls.js-start-failed"]]
          );
          assert.ok(
            warnings.includes(
              "Playback engine fallback: hls.js -> native-hls (hls.js-start-failed)"
            )
          );
        } finally {
          controller.stopProgressSaving();
        }
      });
    });
  } finally {
    globalThis.document = previousDocument;
  }
});

test("play() records an AVPlay startup failure on Tizen before the native fallback", async () => {
  const previousResolve = TizenPlaybackProxy.resolve;
  TizenPlaybackProxy.resolve = async (url) => ({ url, proxied: false });
  try {
    await quietWarnings(async (warnings) => {
      await withPlatform("tizen", async () => {
        const controller = createController({
          canUseAvPlay: () => true,
          getPlatformAvplayEngineName: () => "tizen-avplay",
          playWithAvPlay: () => false
        });
        try {
          await controller.play(ENGINEFS_URL, { itemType: "movie" });
          await settle();
          const info = controller.getPlaybackInfo();
          assert.equal(info.decision.preferredEngine, "tizen-avplay");
          assert.equal(controller.playbackEngine, "native-file");
          assert.equal(info.backend, "html5");
          assert.deepEqual(
            info.fallbackHistory.map(({ from, to, reason }) => [from, to, reason]),
            [["tizen-avplay", "native-file", "avplay-start-failed"]]
          );
          assert.equal(
            warnings.filter((line) => line.startsWith("Playback engine fallback")).length,
            1
          );
        } finally {
          controller.stopProgressSaving();
        }
      });
    });
  } finally {
    TizenPlaybackProxy.resolve = previousResolve;
  }
});
