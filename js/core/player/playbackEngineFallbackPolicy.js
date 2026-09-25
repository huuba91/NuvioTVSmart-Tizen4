export function canFallbackFromPlaybackEngine(forceEngine) {
  return !String(forceEngine || "").trim();
}
