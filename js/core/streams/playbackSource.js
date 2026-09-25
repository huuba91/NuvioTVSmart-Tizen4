export function isMagnetUrl(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .startsWith("magnet:");
}

export function directPlaybackUrl(value = "") {
  const url = String(value || "").trim();
  return url && !isMagnetUrl(url) ? url : "";
}

export function streamDirectPlaybackUrl(stream = {}) {
  return directPlaybackUrl(stream?.url) || directPlaybackUrl(stream?.externalUrl);
}

export function normalizeStreamSubtitles(subtitles = []) {
  return (Array.isArray(subtitles) ? subtitles : [])
    .filter((entry) => entry && entry.url)
    .map((entry) => {
      const headers = entry.headers || entry.behaviorHints?.proxyHeaders?.request;
      return {
        id: entry.id || null,
        url: entry.url,
        lang: entry.lang || "unknown",
        ...(headers ? { headers } : {})
      };
    });
}

export function mapAddonStream(stream = {}) {
  return {
    name: stream.name || null,
    title: stream.title || null,
    description: stream.description || null,
    url: stream.url || null,
    ytId: stream.ytId || null,
    infoHash: stream.infoHash || null,
    fileIdx: stream.fileIdx ?? null,
    externalUrl: stream.externalUrl || null,
    behaviorHints: stream.behaviorHints || null,
    sources: Array.isArray(stream.sources) ? stream.sources : [],
    quality: stream.quality || null,
    qualityValue: Number.isFinite(Number(stream.qualityValue)) ? Number(stream.qualityValue) : -1,
    clientResolve: stream.clientResolve || null,
    debridCacheStatus: stream.debridCacheStatus || null,
    subtitles: normalizeStreamSubtitles(stream.subtitles)
  };
}

export function classifyPlaybackSource(stream = {}) {
  const directUrl = streamDirectPlaybackUrl(stream);
  if (directUrl) {
    return {
      kind: /^https?:\/\//i.test(directUrl) ? "direct-http" : "direct-other",
      url: directUrl
    };
  }
  if (stream.infoHash || stream.clientResolve?.infoHash || isMagnetUrl(stream.url)) {
    return { kind: "p2p", url: "" };
  }
  if (stream.ytId) {
    return { kind: "youtube", url: "" };
  }
  return { kind: "unresolved", url: "" };
}
