// Pure playback-engine ladder.
//
// This is the engine-candidate algorithm that used to live inline in
// PlayerController.getPlaybackEngineCandidates() and choosePlaybackEngine().
// It was extracted unchanged so that decidePlayback() can reuse it without a
// PlayerController instance. The controller gathers the runtime facts (what
// the platform supports, what the source looks like) and delegates here, so
// both paths always produce the same answer.

export function normalizeMimeType(mimeType) {
  return String(mimeType || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
}

export function isLikelyHlsMimeType(mimeType) {
  const normalized = normalizeMimeType(mimeType);
  return (
    normalized === "application/vnd.apple.mpegurl" ||
    normalized === "application/x-mpegurl" ||
    normalized === "audio/mpegurl" ||
    normalized === "audio/x-mpegurl"
  );
}

export function isLikelyDashMimeType(mimeType) {
  return normalizeMimeType(mimeType) === "application/dash+xml";
}

export function isLikelySmoothStreamingMimeType(mimeType) {
  return normalizeMimeType(mimeType) === "application/vnd.ms-sstr+xml";
}

export function isEngineFsUrl(url = "") {
  try {
    const parsedUrl = new URL(String(url || ""));
    return /\/([0-9a-f]{40})\/\d+(?:\/|$)/i.test(parsedUrl.pathname);
  } catch (_) {
    return false;
  }
}

export function isRemoteDirectHttpUrl(url = "") {
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
}

/**
 * @typedef {object} PlaybackSourceTraits
 * @property {string} mimeType            declared/resolved source type, or the type guessed from the URL ("" when unknown)
 * @property {boolean} isLive              live item type (channel/live/tv without episode identity)
 * @property {boolean} isRemoteDirectHttp  http(s) URL that is not served from this TV (localhost/127.0.0.1/::1)
 */

/**
 * @typedef {object} PlaybackEngineFlags
 * @property {string} avplayEngine         platform AVPlay engine name ("tizen-avplay" or "none")
 * @property {boolean} isTizenRuntime
 * @property {boolean} canUseAvPlay
 * @property {boolean} preferTvNative
 * @property {boolean} canUseHlsJs
 * @property {boolean} canUseDashJs
 * @property {boolean} canPlayNativeHls
 * @property {boolean} canPlayNativeDash
 * @property {boolean} canPlayNativeSmooth
 */

/**
 * Ordered engine ladder for a source. Identical to the pre-refactor
 * PlayerController.getPlaybackEngineCandidates() body.
 *
 * @param {PlaybackSourceTraits} traits
 * @param {PlaybackEngineFlags} flags
 * @returns {string[]}
 */
export function computePlaybackEngineCandidates(traits = {}, flags = {}) {
  const normalizedSourceType = String(traits.mimeType || "").trim();
  const avplayEngine = flags.avplayEngine;
  const isTizenRuntime = Boolean(flags.isTizenRuntime);
  const isLivePlayback = Boolean(traits.isLive);
  const canUseAvPlay = Boolean(flags.canUseAvPlay);
  const preferTvNative = Boolean(flags.preferTvNative);
  const canUseHlsJs = Boolean(flags.canUseHlsJs);
  const canUseDashJs = Boolean(flags.canUseDashJs);
  const canPlayNativeHls = Boolean(flags.canPlayNativeHls);
  const canPlayNativeDash = Boolean(flags.canPlayNativeDash);
  const canPlayNativeSmooth = Boolean(flags.canPlayNativeSmooth);
  const pushCandidate = (target, candidate) => {
    const normalized = String(candidate || "").trim();
    if (!normalized || target.includes(normalized)) {
      return;
    }
    target.push(normalized);
  };

  if (isLikelyHlsMimeType(normalizedSourceType)) {
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

  if (isLikelyDashMimeType(normalizedSourceType)) {
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

  if (isLikelySmoothStreamingMimeType(normalizedSourceType)) {
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
  const isRemoteDirectHttpSource = Boolean(traits.isRemoteDirectHttp);
  if (isTizenRuntime && canUseAvPlay) {
    pushCandidate(candidates, avplayEngine);
  }
  // Android keeps progressive network playback in a native Media3/OkHttp
  // pipeline. On Tizen, retrying a remote AVPlay failure with the browser
  // video element creates a second, misleading CORS/Same-Origin failure.
  // Keep the HTML fallback for local EngineFS URLs and non-Tizen platforms;
  // if AVPlay is unavailable, choosePreferredPlaybackEngine() keeps the remote
  // source on the AVPlay path and reports a controlled platform error.
  if (!isTizenRuntime || !isRemoteDirectHttpSource) {
    pushCandidate(candidates, "native-file");
  }
  if (!isTizenRuntime && canUseAvPlay) {
    pushCandidate(candidates, avplayEngine);
  }
  return candidates;
}

/**
 * The engine play() starts with when nothing is forced. Identical to the
 * pre-refactor PlayerController.choosePlaybackEngine() body.
 *
 * @param {PlaybackSourceTraits} traits
 * @param {PlaybackEngineFlags} flags
 * @param {string[]} [candidates] precomputed ladder (computed when omitted)
 * @returns {string}
 */
export function choosePreferredPlaybackEngine(traits = {}, flags = {}, candidates = null) {
  const isTizenRuntime = Boolean(flags.isTizenRuntime);
  const isTizenHlsSource =
    isTizenRuntime && isLikelyHlsMimeType(String(traits.mimeType || "").trim());
  if (isTizenRuntime && flags.canUseAvPlay && !isTizenHlsSource) {
    return flags.avplayEngine;
  }
  const ladder = Array.isArray(candidates)
    ? candidates
    : computePlaybackEngineCandidates(traits, flags);
  if (ladder.length) {
    return ladder[0];
  }
  if (flags.canUseAvPlay) {
    return flags.avplayEngine;
  }
  if (isTizenRuntime && traits.isRemoteDirectHttp) {
    // Keep remote progressive playback on the AVPlay path even when the
    // native API is unavailable, so the caller reports a controlled
    // unsupported-platform error instead of leaking the URL to <video>.
    return flags.avplayEngine;
  }
  return "native-file";
}
