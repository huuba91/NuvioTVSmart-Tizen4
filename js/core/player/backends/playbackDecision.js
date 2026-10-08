// Pure playback decision: which engine ladder to try, and which (optional)
// ambilight analysis source to use, for one inspected stream.
//
// Hybrid rule: the engine ladder is decided exactly as before (it is the same
// function PlayerController.getPlaybackEngineCandidates() uses). The ambilight
// source never influences the engine choice; AVPlay or the HTML5 video
// element always own picture, audio and subtitles. Analysis is optional and
// must never block or delay playback.

import {
  choosePreferredPlaybackEngine,
  computePlaybackEngineCandidates
} from "./engineCandidates.js";

export const AMBILIGHT_SOURCES = Object.freeze([
  "pepper-h264",
  "libde265-hevc",
  "screen-capture",
  "off"
]);

// Codec facts from a file name or structured metadata are trusted enough to
// pick a decoder-specific analysis path; free stream text is not (a pack
// description often names other files).
const SUFFICIENT_CODEC_CONFIDENCE = new Set(["metadata", "filename"]);

/**
 * @typedef {object} PlaybackCapabilities
 * @property {import("./engineCandidates.js").PlaybackEngineFlags} engines
 * @property {{screenCapture: boolean}} [ambilight]                 the TV-service screen capture used today
 * @property {{h264: boolean, hevc: boolean, hevcMaxHeight: number}} [pepperAnalysis]  future Pepper/NaCl analysis module
 */

/**
 * @typedef {object} PlaybackSettings
 * @property {boolean} [ambilightEnabled]
 * @property {string|null} [forceEngine]   explicit engine (diagnostics/fallback replays); disables the automatic choice
 */

/**
 * @typedef {object} PlaybackDecision
 * @property {string[]} engineCandidates   ordered engine ladder (same as getPlaybackEngineCandidates)
 * @property {string} preferredEngine      the engine play() starts with (same as choosePlaybackEngine, or forceEngine)
 * @property {"pepper-h264"|"libde265-hevc"|"screen-capture"|"off"} ambilightSource
 * @property {string[]} reasons            human-readable explanation of each choice
 */

/**
 * @param {object} inspection  StreamInspection (only mimeType/isLive/isRemoteDirectHttp feed the engine ladder)
 * @param {PlaybackCapabilities} capabilities
 * @param {PlaybackSettings} [settings]
 * @returns {{ambilightSource: string, reason: string}}
 */
export function decideAmbilightSource(inspection = {}, capabilities = {}, settings = {}) {
  if (!settings?.ambilightEnabled) {
    return { ambilightSource: "off", reason: "ambilight: off (disabled in settings)" };
  }
  const pepper = capabilities?.pepperAnalysis || {};
  const screenCapture = Boolean(capabilities?.ambilight?.screenCapture);
  if (!screenCapture && !pepper.h264 && !pepper.hevc) {
    return {
      ambilightSource: "off",
      reason: "ambilight: off (no analysis source on this platform)"
    };
  }

  const codec = inspection?.videoCodec || null;
  const codecConfidence = inspection?.confidence?.videoCodec || "unknown";
  const codecTrusted = SUFFICIENT_CODEC_CONFIDENCE.has(codecConfidence);
  const bitDepth = inspection?.bitDepth == null ? null : Number(inspection.bitDepth);
  const height = inspection?.height == null ? null : Number(inspection.height);
  const hevcMaxHeight = Number(pepper.hevcMaxHeight || 0);

  if (pepper.h264 && codec === "h264" && codecTrusted) {
    return {
      ambilightSource: "pepper-h264",
      reason: `ambilight: pepper-h264 (h264 from ${codecConfidence})`
    };
  }
  if (
    pepper.hevc &&
    codec === "hevc" &&
    codecTrusted &&
    (bitDepth == null || bitDepth <= 8) &&
    height != null &&
    Number.isFinite(height) &&
    hevcMaxHeight > 0 &&
    height <= hevcMaxHeight
  ) {
    return {
      ambilightSource: "libde265-hevc",
      reason: `ambilight: libde265-hevc (hevc ${bitDepth == null ? "unknown-depth" : `${bitDepth}-bit`} ${height}p <= ${hevcMaxHeight}p)`
    };
  }
  if (screenCapture) {
    const why =
      !pepper.h264 && !pepper.hevc
        ? "pepper analysis unavailable"
        : `no pepper path for ${codec || "unknown codec"}`;
    return { ambilightSource: "screen-capture", reason: `ambilight: screen-capture (${why})` };
  }
  return {
    ambilightSource: "off",
    reason: `ambilight: off (no pepper path for ${codec || "unknown codec"}, no screen capture)`
  };
}

/**
 * @param {object} inspection
 * @param {PlaybackCapabilities} capabilities
 * @param {PlaybackSettings} [settings]
 * @returns {PlaybackDecision}
 */
export function decidePlayback(inspection = {}, capabilities = {}, settings = {}) {
  const traits = {
    mimeType: String(inspection?.mimeType || "").trim(),
    isLive: Boolean(inspection?.isLive),
    isRemoteDirectHttp: Boolean(inspection?.isRemoteDirectHttp)
  };
  const flags = capabilities?.engines || {};
  const engineCandidates = computePlaybackEngineCandidates(traits, flags);
  const automaticEngine = choosePreferredPlaybackEngine(traits, flags, engineCandidates);
  const forceEngine = String(settings?.forceEngine || "").trim();
  const preferredEngine = forceEngine || automaticEngine;
  const reasons = [
    `source: ${inspection?.streamType || "unknown"} ${traits.mimeType || "(no type)"}${traits.isLive ? " live" : ""}${
      traits.isRemoteDirectHttp ? " remote" : ""
    }`,
    `engines: ${engineCandidates.join(" > ") || "(none)"}`,
    forceEngine
      ? `engine: ${forceEngine} (forced; automatic choice was ${automaticEngine})`
      : `engine: ${automaticEngine}`
  ];
  const ambilight = decideAmbilightSource(inspection, capabilities, settings);
  reasons.push(ambilight.reason);
  return {
    engineCandidates,
    preferredEngine,
    ambilightSource: ambilight.ambilightSource,
    reasons
  };
}
