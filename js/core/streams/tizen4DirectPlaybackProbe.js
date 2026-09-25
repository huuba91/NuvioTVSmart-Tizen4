import { classifyPlaybackSource, mapAddonStream } from "./playbackSource.js";

// Temporary LAN isolation endpoint for the open Sintel trailer. This proves
// whether old-TV HTTPS is the blocker; it is not a production media backend.
export const TIZEN4_DIRECT_PLAYBACK_PROBE_URL = "http://192.168.129.8:8091/sintel.mp4";

export function createTizen4DirectPlaybackProbe() {
  const normalized = mapAddonStream({
    name: "LAN Sintel MP4",
    title: "Controlled legal direct-play probe",
    description: "Temporary LAN HTTP · MP4 isolation probe",
    url: TIZEN4_DIRECT_PLAYBACK_PROBE_URL,
    behaviorHints: { filename: "blender-sintel-trailer-480p.mp4" }
  });
  const stream = {
    ...normalized,
    id: "tizen4-direct-play-lan-sintel",
    addonId: "tizen4-diagnostics",
    addonName: "Tizen 4 diagnostics",
    mimeType: "video/mp4",
    sourceType: "video/mp4",
    isSynthetic: true,
    streamOrigin: {
      kind: "controlled-test",
      addonId: "tizen4-diagnostics",
      addonName: "Tizen 4 diagnostics",
      sourceIds: ["lan-sintel-mp4"]
    }
  };
  const classification = classifyPlaybackSource(stream);
  if (classification.kind !== "direct-http" || !classification.url) {
    throw new Error("Tizen 4 direct-play probe did not normalize to a direct HTTP source");
  }
  return stream;
}
