import { classifyPlaybackSource, mapAddonStream } from "./playbackSource.js";

// Blender-hosted Sintel trailer from the open movie's official download host.
// The controlled probe is exposed only by the Tizen 4 fork's About screen.
export const TIZEN4_DIRECT_PLAYBACK_PROBE_URL = "https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4";

export function createTizen4DirectPlaybackProbe() {
  const normalized = mapAddonStream({
    name: "Blender Sintel MP4",
    title: "Controlled legal direct-play probe",
    description: "HTTPS · MP4 · byte-range enabled",
    url: TIZEN4_DIRECT_PLAYBACK_PROBE_URL,
    behaviorHints: { filename: "blender-sintel-trailer-480p.mp4" }
  });
  const stream = {
    ...normalized,
    id: "tizen4-direct-play-blender-sintel",
    addonId: "tizen4-diagnostics",
    addonName: "Tizen 4 diagnostics",
    mimeType: "video/mp4",
    sourceType: "video/mp4",
    isSynthetic: true,
    streamOrigin: {
      kind: "controlled-test",
      addonId: "tizen4-diagnostics",
      addonName: "Tizen 4 diagnostics",
      sourceIds: ["blender-sintel-mp4"]
    }
  };
  const classification = classifyPlaybackSource(stream);
  if (classification.kind !== "direct-http" || !classification.url) {
    throw new Error("Tizen 4 direct-play probe did not normalize to a direct HTTP source");
  }
  return stream;
}
