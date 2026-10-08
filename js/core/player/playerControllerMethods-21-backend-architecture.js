/* eslint-disable no-unused-vars */
import * as internals from "./playerController.js";

// Backend-neutral layer of PlayerController: stream inspection and playback
// decision per load, the active backend adapter, a neutral event API bridged
// from the <video> element (which also carries AVPlay/hls.js/dash.js synthetic
// events), the fallback history, and small media-element accessors so the UI
// does not read the element directly. See docs/player-architecture.md.

const FALLBACK_HISTORY_LIMIT = 20;
const DEFAULT_PEPPER_ANALYSIS = Object.freeze({ h264: false, hevc: false, hevcMaxHeight: 0 });

export function createPlayerControllerMethods21() {
  const {
    Platform,
    inspectStream,
    decidePlayback,
    createAvplayBackend,
    createHtml5Backend,
    HTML5_ENGINES,
    createPlayerEventEmitter,
    MEDIA_EVENT_TO_BACKEND_EVENT,
    AmbilightController,
    AmbilightSettingsStore
  } = internals;

  return {
    getPlaybackSourceTraits(url, sourceType = null, itemType = this.currentItemType) {
      return {
        mimeType: String(sourceType || this.guessMediaMimeType(url) || "").trim(),
        isLive: this.isLivePlaybackItemType(itemType),
        isRemoteDirectHttp: this.isRemoteDirectHttpSource(url)
      };
    },
    getPlaybackEngineFlags() {
      return {
        avplayEngine: this.getPlatformAvplayEngineName(),
        isTizenRuntime: Platform.isTizen(),
        canUseAvPlay: this.canUseAvPlay(),
        preferTvNative: this.shouldPreferTvNativePipeline(),
        canUseHlsJs: this.canUseHlsJs(),
        canUseDashJs: this.canUseDashJs(),
        canPlayNativeHls: this.canPlayNatively("application/vnd.apple.mpegurl"),
        canPlayNativeDash: this.canPlayNatively("application/dash+xml"),
        canPlayNativeSmooth: this.canPlayNatively("application/vnd.ms-sstr+xml")
      };
    },
    getPlaybackDecisionCapabilities() {
      let screenCapture = false;
      try {
        screenCapture = Boolean(AmbilightController?.isAvailable?.());
      } catch (_) {
        screenCapture = false;
      }
      return {
        engines: this.getPlaybackEngineFlags(),
        ambilight: { screenCapture },
        // The Pepper/NaCl analysis module does not exist yet; a future build
        // sets pepperAnalysisCapabilities once the module reports in.
        pepperAnalysis: { ...DEFAULT_PEPPER_ANALYSIS, ...(this.pepperAnalysisCapabilities || {}) }
      };
    },
    getPlaybackDecisionSettings(forceEngine = null) {
      let ambilightEnabled = false;
      try {
        ambilightEnabled = Boolean(AmbilightSettingsStore?.get?.()?.enabled);
      } catch (_) {
        ambilightEnabled = false;
      }
      return { ambilightEnabled, forceEngine: String(forceEngine || "").trim() || null };
    },
    // Called once per load from play(). A forced replay of the same source (an
    // engine fallback) keeps the load's inspection, decision and history.
    preparePlaybackDecision({ url, sourceType = null, itemType = this.currentItemType, stream = null, forceEngine = null } = {}) {
      const loadKey = String(url || "").trim();
      if (forceEngine && this.playbackDecision && this.playbackDecisionKey === loadKey) {
        return this.playbackDecision;
      }
      this.playbackDecisionKey = loadKey;
      this.playbackFallbackHistory = [];
      this.playbackStreamMetadata = stream && typeof stream === "object" ? stream : null;
      this.playbackEngineMediaInfoKey = "";
      let inspection = null;
      let decision = null;
      try {
        this.playbackInspectionContext = {
          url: loadKey,
          sourceType: sourceType || null,
          urlMimeType: this.guessMediaMimeType(url) || null,
          isLive: this.isLivePlaybackItemType(itemType)
        };
        inspection = inspectStream(this.playbackStreamMetadata || {}, this.playbackInspectionContext);
        decision = decidePlayback(inspection, this.getPlaybackDecisionCapabilities(), this.getPlaybackDecisionSettings(forceEngine));
      } catch (error) {
        // Inspection is advisory. Never let it stop a playback start.
        decision = {
          engineCandidates: this.getPlaybackEngineCandidates(url, sourceType, itemType),
          preferredEngine: String(forceEngine || "").trim() || this.choosePlaybackEngine(url, sourceType, itemType),
          ambilightSource: "off",
          reasons: [`decision unavailable: ${error?.message || error}`]
        };
      }
      this.playbackInspection = inspection;
      this.playbackDecision = decision;
      return decision;
    },
    // Engine-reported codec/size facts refine the load's inspection once the
    // engine knows them. The decision (made before playback) is not changed.
    getEngineMediaInfo() {
      try {
        if (this.isUsingAvPlay()) {
          const avplay = this.getAvPlay();
          const streams = avplay?.getCurrentStreamInfo?.();
          const list = Array.isArray(streams) ? streams : [];
          const videoTrack = list.find((track) => this.normalizeAvPlayTrackType(track?.type) === "VIDEO") || null;
          const extra = videoTrack ? this.parseAvPlayExtraInfo(videoTrack.extra_info || videoTrack.extraInfo || null) || {} : {};
          const audioCodecs = (this.avplayAudioTracks || []).map((track) => track?.codec).filter(Boolean);
          return {
            engine: this.playbackEngine,
            video: {
              codec: extra.fourCC || extra.codec || extra.codec_name || "",
              height: Number(extra.Height || extra.height || 0) || null,
              width: Number(extra.Width || extra.width || 0) || null
            },
            audioCodecs
          };
        }
        if (this.playbackEngine === "hls.js" && this.hlsInstance) {
          const levels = Array.isArray(this.hlsInstance.levels) ? this.hlsInstance.levels : [];
          const levelIndex = Number(this.hlsInstance.currentLevel);
          const level = levels[levelIndex >= 0 ? levelIndex : 0] || null;
          if (level) {
            return {
              engine: "hls.js",
              video: {
                codec: level.videoCodec || "",
                height: Number(level.height || 0) || null,
                frameRate: Number(level.frameRate || 0) || null
              },
              audioCodecs: level.audioCodec ? [level.audioCodec] : []
            };
          }
        }
        const height = Number(this.video?.videoHeight || 0);
        return height > 0 ? { engine: this.playbackEngine, video: { height }, audioCodecs: [] } : null;
      } catch (_) {
        return null;
      }
    },
    refreshPlaybackInspectionFromEngine() {
      if (!this.playbackInspectionContext) {
        return this.playbackInspection;
      }
      const engineInfo = this.getEngineMediaInfo();
      if (!engineInfo) {
        return this.playbackInspection;
      }
      const key = JSON.stringify(engineInfo);
      if (key === this.playbackEngineMediaInfoKey) {
        return this.playbackInspection;
      }
      this.playbackEngineMediaInfoKey = key;
      try {
        this.playbackInspection = inspectStream(this.playbackStreamMetadata || {}, {
          ...this.playbackInspectionContext,
          engineInfo
        });
      } catch (_) {
        // Keep the previous inspection.
      }
      return this.playbackInspection;
    },
    recordPlaybackFallback(from, to, reason = "unspecified") {
      const entry = {
        from: String(from || this.playbackEngine || "none"),
        to: String(to || "none"),
        reason: String(reason || "unspecified"),
        at: Date.now()
      };
      this.playbackFallbackHistory = [...(this.playbackFallbackHistory || []), entry].slice(-FALLBACK_HISTORY_LIMIT);
      console.warn(`Playback engine fallback: ${entry.from} -> ${entry.to} (${entry.reason})`);
      return entry;
    },
    getActiveBackend() {
      const engine = String(this.playbackEngine || "").trim();
      if (engine.endsWith("avplay")) {
        if (!this.avplayBackendAdapter) {
          this.avplayBackendAdapter = createAvplayBackend(this);
        }
        return this.avplayBackendAdapter;
      }
      if (HTML5_ENGINES.includes(engine)) {
        if (!this.html5BackendAdapter) {
          this.html5BackendAdapter = createHtml5Backend(this);
        }
        return this.html5BackendAdapter;
      }
      return null;
    },
    getPlaybackInfo() {
      const backend = this.getActiveBackend();
      return {
        backend: backend ? backend.name : null,
        engine: String(this.playbackEngine || "none"),
        inspection: this.playbackInspection || null,
        decision: this.playbackDecision || null,
        fallbackHistory: (this.playbackFallbackHistory || []).map((entry) => ({ ...entry }))
      };
    },
    getPlayerEventEmitter() {
      if (!this.playerEventEmitter) {
        this.playerEventEmitter = createPlayerEventEmitter();
      }
      return this.playerEventEmitter;
    },
    on(eventName, handler) {
      this.getPlayerEventEmitter().on(eventName, handler);
    },
    off(eventName, handler) {
      this.getPlayerEventEmitter().off(eventName, handler);
    },
    emitPlayerEvent(eventName, detail = null, sourceEvent = null) {
      const emitter = this.getPlayerEventEmitter();
      if (!emitter.count(eventName)) {
        return;
      }
      const backend = this.getActiveBackend();
      emitter.emit(eventName, {
        type: eventName,
        engine: String(this.playbackEngine || "none"),
        backend: backend ? backend.name : null,
        sourceEvent,
        detail: detail ?? null
      });
    },
    // AVPlay, hls.js and dash.js report through emitVideoEvent() on the same
    // <video> element as the browser's own media events, so one set of
    // element listeners produces the neutral events for every engine.
    bindPlayerEventBridge() {
      const video = this.video;
      if (!video || typeof video.addEventListener !== "function" || this.playerEventBridgeVideo === video) {
        return;
      }
      this.playerEventBridgeVideo = video;
      Object.keys(MEDIA_EVENT_TO_BACKEND_EVENT).forEach((mediaEventName) => {
        const eventName = MEDIA_EVENT_TO_BACKEND_EVENT[mediaEventName];
        video.addEventListener(mediaEventName, (event) => {
          if (eventName === "tracks") {
            this.refreshPlaybackInspectionFromEngine();
          }
          this.emitPlayerEvent(eventName, event?.detail ?? null, mediaEventName);
        });
      });
    },
    hasMediaElement() {
      return Boolean(this.video);
    },
    // True only while the HTML5 backend is active and its element is paused.
    // AVPlay pause state is tracked by the player UI (paused flag), matching
    // the pre-refactor `!usingAvPlay && video.paused` checks.
    isMediaElementPaused() {
      return !this.isUsingAvPlay() && Boolean(this.video?.paused);
    },
    getMediaElementErrorCode() {
      return Number(this.video?.error?.code || 0);
    },
    getMediaNetworkState() {
      return Number(this.video?.networkState ?? 0);
    },
    getMediaElementSourceUrl() {
      return String(this.video?.currentSrc || "").trim();
    },
    getMediaElementDiagnostics() {
      const video = this.video || null;
      return {
        error: video?.error || null,
        readyState: video?.readyState,
        networkState: video?.networkState,
        currentSrc: video?.currentSrc || video?.src
      };
    }
  };
}
