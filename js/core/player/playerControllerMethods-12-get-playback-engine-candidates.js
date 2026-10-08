/* eslint-disable no-unused-vars */
import * as internals from "./playerController.js";

export function createPlayerControllerMethods12() {
  const {
    Platform,
    nativeVideoEngine,
    WEBOS_MEDIA_TYPE_PROBE_TIMEOUT_MS,
    computePlaybackEngineCandidates,
    isEngineFsUrl,
    isRemoteDirectHttpUrl
  } = internals;

  return {
    getPlaybackEngineCandidates(url, sourceType = null, itemType = this.currentItemType) {
      // The ladder itself lives in backends/engineCandidates.js so that
      // decidePlayback() and this method can never disagree.
      return computePlaybackEngineCandidates(this.getPlaybackSourceTraits(url, sourceType, itemType), this.getPlaybackEngineFlags());
    },
    getAlternativePlaybackEngine(
      url = this.currentPlaybackUrl,
      sourceType = this.currentPlaybackMediaSourceType,
      itemType = this.currentItemType
    ) {
      const normalizedUrl = String(url || "").trim();
      if (!normalizedUrl) {
        return null;
      }
      const attemptedEngines = this.getAttemptedPlaybackEngines(normalizedUrl);
      const currentEngine = String(this.playbackEngine || "").trim();
      if (Platform.isTizen() && currentEngine === "hls.js" && this.currentTizenHlsProxyBaseUrl) {
        // Native HLS and AVPlay cannot propagate arbitrary add-on headers to
        // every child request. Do not replace an actionable hls.js error with
        // a guaranteed header-loss fallback.
        return null;
      }
      const candidates = this.getPlaybackEngineCandidates(normalizedUrl, sourceType, itemType);
      return candidates.find((candidate) => candidate !== currentEngine && !attemptedEngines.has(candidate)) || null;
    },
    isEngineFsPlaybackUrl(url = "") {
      return isEngineFsUrl(url);
    },
    isRemoteDirectHttpSource(url = "") {
      return isRemoteDirectHttpUrl(url);
    },
    getPlaybackCapabilities() {
      const supports = (mimeType) => this.canPlayNatively(mimeType);
      const capabilities = {
        avplay: this.canUseAvPlay(),
        hls: supports("application/vnd.apple.mpegurl"),
        dash: supports("application/dash+xml"),
        smoothStreaming: supports("application/vnd.ms-sstr+xml"),
        mp4: supports("video/mp4"),
        mp4H264: supports('video/mp4; codecs="avc1.4d401f,mp4a.40.2"'),
        mp4Hevc: supports('video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"') || supports('video/mp4; codecs="hev1.1.6.L93.B0,mp4a.40.2"'),
        mp4HevcMain10:
          supports('video/mp4; codecs="hvc1.2.4.L153.B0,mp4a.40.2"') || supports('video/mp4; codecs="hev1.2.4.L153.B0,mp4a.40.2"'),
        mp4Av1: supports('video/mp4; codecs="av01.0.08M.08,mp4a.40.2"'),
        webmVp9: supports('video/webm; codecs="vp9,opus"'),
        webm: supports("video/webm"),
        mkvH264: supports('video/x-matroska; codecs="avc1.4d401f,mp4a.40.2"') || supports("video/x-matroska"),
        quicktime: supports("video/quicktime"),
        mpegTs: supports("video/mp2t"),
        audioAac: supports('audio/mp4; codecs="mp4a.40.2"'),
        audioMp3: supports("audio/mpeg"),
        audioFlac: supports("audio/flac"),
        audioAc3: supports('audio/mp4; codecs="ac-3"') || supports('audio/mp4; codecs="dac3"'),
        audioEac3: supports('audio/mp4; codecs="ec-3"') || supports('audio/mp4; codecs="dec3"'),
        dolbyVision: supports('video/mp4; codecs="dvh1.05.06,ec-3"') || supports('video/mp4; codecs="dvhe.05.06,ec-3"')
      };
      capabilities.hdrLikely = capabilities.mp4HevcMain10 || capabilities.mp4Av1;
      capabilities.atmosLikely = capabilities.audioEac3;
      return capabilities;
    },
    teardownHlsInstance() {
      this.clearHlsBufferStallWarning();
      if (!this.hlsInstance) {
        return;
      }
      try {
        this.hlsInstance.destroy();
      } catch (_) {
        // Ignore HLS cleanup failures.
      }
      this.hlsInstance = null;
    },
    teardownDashInstance() {
      if (!this.dashInstance) {
        return;
      }
      try {
        this.dashInstance.reset?.();
      } catch (_) {
        // Ignore DASH cleanup failures.
      }
      this.dashInstance = null;
    },
    teardownAdaptiveInstances() {
      this.teardownHlsInstance();
      this.teardownDashInstance();
      if (!this.isUsingAvPlay()) {
        this.playbackEngine = "none";
      }
    },
    applyNativeSource(url, mimeType = null, engineName = "native-file") {
      const normalizedMimeType = this.normalizeMimeType(mimeType);
      const sourceMimeType =
        Platform.isWebOS() && (this.isEngineFsPlaybackUrl(url) || normalizedMimeType === "video/x-matroska") ? null : mimeType;
      const preferDirectSrc = Platform.isTizen() && String(engineName || "") === "native-file";
      if (!nativeVideoEngine.load(this.video, url, sourceMimeType, { preferDirectSrc })) {
        return false;
      }
      this.playbackEngine = String(engineName || "native-file");
      return true;
    },
    applyWebOsStagedNativeSource(url, engineName = "native-file") {
      if (!this.video) {
        return false;
      }
      Array.from(this.video.querySelectorAll("source")).forEach((node) => node.remove());
      this.video.src = url;
      this.playbackEngine = String(engineName || "native-file");
      return true;
    },
    async prepareWebOsStagedNativePlayback(playToken = null, url = null) {
      await this.waitForNativeMediaId();
      if (!this.isPlaybackRequestActive(playToken, url)) {
        return;
      }
      try {
        this.video?.load?.();
      } catch (_) {
        // webOS may throw during staged native startup; play() will surface the real failure.
      }
    },
    shouldForwardHeaderToHls(name) {
      const lower = String(name || "")
        .trim()
        .toLowerCase();
      if (!lower) {
        return false;
      }
      if (lower === "range") {
        return false;
      }
      if (lower.startsWith("sec-")) {
        return false;
      }
      const forbidden = new Set([
        "host",
        "origin",
        "referer",
        "referrer",
        "user-agent",
        "content-length",
        "accept-encoding",
        "connection",
        "cookie"
      ]);
      return !forbidden.has(lower);
    },
    normalizePlaybackHeaders(headers) {
      if (!headers || typeof headers !== "object") {
        return {};
      }
      const entries = Object.entries(headers)
        .map(([key, value]) => [String(key || "").trim(), String(value ?? "").trim()])
        .filter(([key, value]) => key && value)
        .filter(([key]) => this.shouldForwardHeaderToHls(key));
      return Object.fromEntries(entries);
    },
    async probeRemoteMediaSourceType(url, requestHeaders = {}) {
      if (!Platform.isWebOS() || !this.isRemoteDirectHttpSource(url)) {
        return null;
      }

      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), WEBOS_MEDIA_TYPE_PROBE_TIMEOUT_MS) : null;
      try {
        const response = await fetch(url, {
          method: "HEAD",
          headers: this.normalizePlaybackHeaders(requestHeaders),
          cache: "no-store",
          redirect: "follow",
          ...(controller ? { signal: controller.signal } : {})
        });
        if (!response.ok) {
          return null;
        }
        return this.resolveRuntimeSourceType(response.headers?.get?.("content-type"));
      } catch (_) {
        return null;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }
  };
}
