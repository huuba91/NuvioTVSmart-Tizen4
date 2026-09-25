import { classifyPlaybackSource, mapAddonStream } from "./playbackSource.js";

// Optional packaged isolation asset. It is copied into diagnostic WGTs only
// when NUVIO_TIZEN4_PROBE_MEDIA_FILE is set during the build.
export const TIZEN4_DIRECT_PLAYBACK_PROBE_URL = "assets/tizen4-probe-sintel.mp4";

export function createTizen4DirectPlaybackProbe() {
  const normalized = mapAddonStream({
    name: "Packaged Sintel MP4",
    title: "Controlled legal direct-play probe",
    description: "Packaged MP4 · network-free isolation probe",
    url: TIZEN4_DIRECT_PLAYBACK_PROBE_URL,
    behaviorHints: { filename: "blender-sintel-trailer-480p.mp4" }
  });
  const stream = {
    ...normalized,
    id: "tizen4-direct-play-packaged-sintel",
    addonId: "tizen4-diagnostics",
    addonName: "Tizen 4 diagnostics",
    mimeType: "video/mp4",
    sourceType: "video/mp4",
    isSynthetic: true,
    streamOrigin: {
      kind: "controlled-test",
      addonId: "tizen4-diagnostics",
      addonName: "Tizen 4 diagnostics",
      sourceIds: ["packaged-sintel-mp4"]
    }
  };
  const classification = classifyPlaybackSource(stream);
  if (classification.kind !== "direct-other" || !classification.url) {
    throw new Error("Tizen 4 packaged probe did not normalize to a playable source");
  }
  return stream;
}
