// Edited by `node build.mjs --pc http://<pc-ip>:8099`, or by hand.
window.PROBE_CONFIG = {
  // Where the finished JSON report is POSTed (tools/html-color-probe/report-server.mjs). "" = off.
  REPORT_URL: "",
  // A CORS-enabled MP4 for the "remote" test. With report-server.mjs running this is the pattern
  // clip served from the PC (exact colour check); any other URL gets a generic "not blank, changes" check.
  REMOTE_URL: "",
  // True when REMOTE_URL serves media/pattern.mp4 (so colours can be verified exactly).
  REMOTE_IS_PATTERN: false,
  // Fallback public sample if REMOTE_URL is empty (needs Access-Control-Allow-Origin).
  PUBLIC_SAMPLE_URL: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
};
