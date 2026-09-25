import { classifyPlaybackSource, mapAddonStream } from "./playbackSource.js";

// W3C-hosted Sintel trailer used by the W3C HTML media-event test page.
// The controlled probe is exposed only by the Tizen 4 fork's About screen.
export const TIZEN4_DIRECT_PLAYBACK_PROBE_URL = "https://media.w3.org/2010/05/sintel/trailer.mp4";

export function createTizen4DirectPlaybackProbe() {
  const normalized = mapAddonStream({
    name: "W3C Sintel MP4",
    title: "Controlled legal direct-play probe",
    description: "HTTPS · MP4 · byte-range enabled",
    url: TIZEN4_DIRECT_PLAYBACK_PROBE_URL,
    behaviorHints: { filename: "w3c-sintel-trailer.mp4" }
  });
  const stream = {
    ...normalized,
    id: "tizen4-direct-play-w3c-sintel",
    addonId: "tizen4-diagnostics",
    addonName: "Tizen 4 diagnostics",
    mimeType: "video/mp4",
    sourceType: "video/mp4",
    isSynthetic: true,
    streamOrigin: {
      kind: "controlled-test",
      addonId: "tizen4-diagnostics",
      addonName: "Tizen 4 diagnostics",
      sourceIds: ["w3c-sintel-mp4"]
    }
  };
  const classification = classifyPlaybackSource(stream);
  if (classification.kind !== "direct-http" || !classification.url) {
    throw new Error("Tizen 4 direct-play probe did not normalize to a direct HTTP source");
  }
  return stream;
}
