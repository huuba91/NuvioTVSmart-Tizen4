// Verbatim copies of the PlayerController engine-selection methods as they
// were at 1.2.65 (commit 6e21459), before the engine ladder moved to
// js/core/player/backends/engineCandidates.js:
//   playerControllerMethods-12: getPlaybackEngineCandidates, getAlternativePlaybackEngine,
//                               isEngineFsPlaybackUrl, isRemoteDirectHttpSource
//   playerControllerMethods-16: choosePlaybackEngine
//   playerControllerMethods-01: normalizeMimeType, isLikely{Hls,Dash,SmoothStreaming}MimeType
//   playerControllerMethods-11: isTizenHlsSource
// tests/playback-decision.test.mjs uses them as an oracle: the refactored code
// must return exactly what this code returns for every input. Do not edit.
/* eslint-disable */
export function createLegacyEngineSelection(Platform) {
  return {
    getPlaybackEngineCandidates(url, sourceType = null, itemType = this.currentItemType) {
      const normalizedSourceType = String(sourceType || this.guessMediaMimeType(url) || "").trim();
      const avplayEngine = this.getPlatformAvplayEngineName();
      const isTizenRuntime = Platform.isTizen();
      const isLivePlayback = this.isLivePlaybackItemType(itemType);
      const canUseAvPlay = this.canUseAvPlay();
      const preferTvNative = this.shouldPreferTvNativePipeline();
      const canUseHlsJs = this.canUseHlsJs();
      const canUseDashJs = this.canUseDashJs();
      const canPlayNativeHls = this.canPlayNatively("application/vnd.apple.mpegurl");
      const canPlayNativeDash = this.canPlayNatively("application/dash+xml");
      const canPlayNativeSmooth = this.canPlayNatively("application/vnd.ms-sstr+xml");
      const pushCandidate = (target, candidate) => {
        const normalized = String(candidate || "").trim();
        if (!normalized || target.includes(normalized)) {
          return;
        }
        target.push(normalized);
      };

      if (this.isLikelyHlsMimeType(normalizedSourceType)) {
        const candidates = [];
        if (isTizenRuntime && canUseHlsJs) {
          // Match Android's single HLS media pipeline when MSE is available.
          // This also avoids the long AVPlay connection-failure path observed
          // on affected Samsung TVs. AVPlay and native HLS remain fallbacks.
          pushCandidate(candidates, "hls.js");
        }
        if (isTizenRuntime && canUseAvPlay) {
          pushCandidate(candidates, avplayEngine);
        }
        if (preferTvNative && canUseAvPlay) {
          pushCandidate(candidates, avplayEngine);
        }
        if (isTizenRuntime && isLivePlayback) {
          // Keep hls.js in the live fallback ladder even when feature detection
          // is unavailable; the normal path above has already preferred it when
          // MSE support was confirmed.
          pushCandidate(candidates, "hls.js");
        }
        if (!isTizenRuntime) {
          // Android opens HLS through HlsMediaSource, which reports manifest
          // failures directly. Prefer the equivalent hls.js pipeline here; if
          // MSE is unavailable, playWithHlsJs falls back to native playback.
          pushCandidate(candidates, "hls.js");
        }
        if (canPlayNativeHls) {
          pushCandidate(candidates, "native-hls");
        }
        if (isLivePlayback && (canUseHlsJs || isTizenRuntime)) {
          pushCandidate(candidates, "hls.js");
        }
        if (isTizenRuntime && !isLivePlayback) {
          pushCandidate(candidates, "hls.js");
        }
        if (canUseAvPlay) {
          pushCandidate(candidates, avplayEngine);
        }
        return candidates;
      }

      if (this.isLikelyDashMimeType(normalizedSourceType)) {
        const candidates = [];
        if (isTizenRuntime && canUseAvPlay) {
          pushCandidate(candidates, avplayEngine);
        }
        if (preferTvNative && canUseAvPlay) {
          pushCandidate(candidates, avplayEngine);
        }
        if (canPlayNativeDash) {
          pushCandidate(candidates, "native-dash");
        }
        if (isLivePlayback && (canUseDashJs || isTizenRuntime)) {
          pushCandidate(candidates, "dash.js");
        }
        if (isTizenRuntime && !isLivePlayback) {
          pushCandidate(candidates, "dash.js");
        }
        if (!isTizenRuntime && canUseDashJs) {
          pushCandidate(candidates, "dash.js");
        }
        if (canUseAvPlay) {
          pushCandidate(candidates, avplayEngine);
        }
        return candidates;
      }

      if (this.isLikelySmoothStreamingMimeType(normalizedSourceType)) {
        const candidates = [];
        if (isTizenRuntime && canUseAvPlay) {
          pushCandidate(candidates, avplayEngine);
        }
        if (canPlayNativeSmooth) {
          pushCandidate(candidates, "native-file");
        }
        if (canUseAvPlay) {
          pushCandidate(candidates, avplayEngine);
        }
        return candidates;
      }

      const candidates = [];
      const isRemoteDirectHttpSource = this.isRemoteDirectHttpSource(url);
      if (isTizenRuntime && canUseAvPlay) {
        pushCandidate(candidates, avplayEngine);
      }
      // Android keeps progressive network playback in a native Media3/OkHttp
      // pipeline. On Tizen, retrying a remote AVPlay failure with the browser
      // video element creates a second, misleading CORS/Same-Origin failure.
      // Keep the HTML fallback for local EngineFS URLs and non-Tizen platforms;
      // if AVPlay is unavailable, choosePlaybackEngine() keeps the remote source
      // on the AVPlay path and reports a controlled platform error.
      if (!isTizenRuntime || !isRemoteDirectHttpSource) {
        pushCandidate(candidates, "native-file");
      }
      if (!isTizenRuntime && canUseAvPlay) {
        pushCandidate(candidates, avplayEngine);
      }
      return candidates;
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
      return (
        candidates.find(
          (candidate) => candidate !== currentEngine && !attemptedEngines.has(candidate)
        ) || null
      );
    },
    isEngineFsPlaybackUrl(url = "") {
      try {
        const parsedUrl = new URL(String(url || ""));
        return /\/([0-9a-f]{40})\/\d+(?:\/|$)/i.test(parsedUrl.pathname);
      } catch (_) {
        return false;
      }
    },
    isRemoteDirectHttpSource(url = "") {
      const normalizedUrl = String(url || "").trim();
      if (!/^https?:\/\//i.test(normalizedUrl)) {
        return false;
      }
      try {
        const hostname = String(new URL(normalizedUrl).hostname || "")
          .toLowerCase()
          .replace(/^\[|\]$/g, "");
        return !["127.0.0.1", "localhost", "::1"].includes(hostname);
      } catch (_) {
        return !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(normalizedUrl);
      }
    },
    choosePlaybackEngine(url, sourceType, itemType = this.currentItemType) {
      if (Platform.isTizen() && this.canUseAvPlay() && !this.isTizenHlsSource(url, sourceType)) {
        return this.getPlatformAvplayEngineName();
      }
      const candidates = this.getPlaybackEngineCandidates(url, sourceType, itemType);
      if (candidates.length) {
        return candidates[0];
      }
      if (this.canUseAvPlay()) {
        return this.getPlatformAvplayEngineName();
      }
      if (Platform.isTizen() && this.isRemoteDirectHttpSource(url)) {
        // Keep remote progressive playback on the AVPlay path even when the
        // native API is unavailable, so the caller reports a controlled
        // unsupported-platform error instead of leaking the URL to <video>.
        return this.getPlatformAvplayEngineName();
      }
      return "native-file";
    },
    normalizeMimeType(mimeType) {
      return String(mimeType || "")
        .toLowerCase()
        .split(";")[0]
        .trim();
    },
    isLikelyHlsMimeType(mimeType) {
      const normalized = this.normalizeMimeType(mimeType);
      return (
        normalized === "application/vnd.apple.mpegurl" ||
        normalized === "application/x-mpegurl" ||
        normalized === "audio/mpegurl" ||
        normalized === "audio/x-mpegurl"
      );
    },
    isLikelyDashMimeType(mimeType) {
      return this.normalizeMimeType(mimeType) === "application/dash+xml";
    },
    isLikelySmoothStreamingMimeType(mimeType) {
      return this.normalizeMimeType(mimeType) === "application/vnd.ms-sstr+xml";
    },
    isTizenHlsSource(url, sourceType = null) {
      const normalizedSourceType = String(sourceType || this.guessMediaMimeType(url) || "").trim();
      return Platform.isTizen() && this.isLikelyHlsMimeType(normalizedSourceType);
    }
  };
}
