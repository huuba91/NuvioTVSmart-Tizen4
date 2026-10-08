// Pure, metadata-only stream inspection.
//
// inspectStream() looks at what Nuvio already knows about a stream before it
// plays it (add-on metadata, debrid-parsed release info, the file name, the
// stream name/title/description, the URL, the already-resolved source type)
// plus, when available, what the playing engine reports about its tracks. It
// never touches the network and never throws for odd input: every unknown
// field is simply null with confidence "unknown".
//
// Confidence per field, strongest first:
//   "metadata" - structured data: engine-reported tracks, a declared MIME type
//                or codecs string, debrid/add-on parsed release fields
//   "filename" - a release token in the file name (behaviorHints.filename,
//                debrid file name, URL path)
//   "text"     - a release token in the free stream name/title/description
//   "unknown"  - nothing found
// `sources` lists every value that was found and where it came from, so a
// later reader can see why a field has the value it has.

import { resolutionFromText } from "../../debrid/streamResolution.js";
import { classifyPlaybackSource, streamDirectPlaybackUrl } from "../../streams/playbackSource.js";
import {
  isEngineFsUrl,
  isLikelyDashMimeType,
  isLikelyHlsMimeType,
  isLikelySmoothStreamingMimeType,
  isRemoteDirectHttpUrl,
  normalizeMimeType
} from "../backends/engineCandidates.js";

export const INSPECTION_CONFIDENCE = Object.freeze(["metadata", "filename", "text", "unknown"]);

const CONFIDENCE_RANK = { metadata: 3, filename: 2, text: 1, unknown: 0 };

const START = "(?:^|[^a-z0-9])";
const END = "(?=$|[^a-z0-9])";
// Audio tokens are commonly glued to a channel count ("DDP5.1", "AAC2.0").
const AUDIO_END = "(?=$|[^a-z])";

const VIDEO_CODEC_PATTERNS = [
  ["hevc", new RegExp(`${START}(?:x\\.?265|h[ .]?265|hevc|hvc1|hev1)${END}`, "i")],
  ["h264", new RegExp(`${START}(?:x\\.?264|h[ .]?264|avc|avc1)${END}`, "i")],
  ["av1", new RegExp(`${START}(?:av1|av01)${END}`, "i")],
  ["vp9", new RegExp(`${START}(?:vp9|vp09)${END}`, "i")],
  ["mpeg2", new RegExp(`${START}(?:mpeg-?2(?:video)?|h\\.?262)${END}`, "i")]
];

const HDR_PATTERNS = [
  ["dolby-vision", new RegExp(`${START}(?:dv|dovi|dolby[ .-]?vision|dvhe|dvh1)${END}`, "i")],
  ["hdr10plus", new RegExp(`${START}hdr10(?:\\+|[ .-]?plus)(?=$|[^a-z0-9])`, "i")],
  ["hlg", new RegExp(`${START}hlg${END}`, "i")],
  ["hdr10", new RegExp(`${START}hdr(?:10)?(?![+a-z0-9]|[ .-]?plus)`, "i")]
];

// Order matters: longer/more specific tokens are matched (and consumed) first
// so "DTS-HD" is not also counted as "DTS" and "DDP" not also as "DD".
const AUDIO_PATTERNS = [
  ["truehd", new RegExp(`${START}true[ .-]?hd${AUDIO_END}`, "gi")],
  ["atmos", new RegExp(`${START}atmos${AUDIO_END}`, "gi")],
  ["dts-hd", new RegExp(`${START}dts[ .-]?hd(?:[ .-]?(?:ma|hra))?${AUDIO_END}`, "gi")],
  ["dts", new RegExp(`${START}dts(?:[ .:-]?x)?${AUDIO_END}`, "gi")],
  [
    "eac3",
    new RegExp(`${START}(?:ddp|dd\\+|e-?ac-?3|ec-?3|dolby[ .]?digital[ .]?plus)${AUDIO_END}`, "gi")
  ],
  ["ac3", new RegExp(`${START}(?:dd|ac-?3|dolby[ .]?digital)(?=$|[^a-z+])`, "gi")],
  ["aac", new RegExp(`${START}(?:he-?)?aac(?:-?lc)?${AUDIO_END}`, "gi")],
  ["opus", new RegExp(`${START}opus${AUDIO_END}`, "gi")],
  ["flac", new RegExp(`${START}flac${AUDIO_END}`, "gi")],
  ["mp3", new RegExp(`${START}mp3${AUDIO_END}`, "gi")]
];

const CONTAINER_BY_EXTENSION = {
  mkv: "mkv",
  mk3d: "mkv",
  mp4: "mp4",
  m4v: "mp4",
  mov: "mov",
  webm: "webm",
  avi: "avi",
  wmv: "wmv",
  ts: "ts",
  m2ts: "ts",
  mts: "ts",
  mpg: "mpeg",
  mpeg: "mpeg",
  m3u8: "m3u8",
  mpd: "mpd",
  flv: "flv",
  "3gp": "3gp"
};

const CONTAINER_BY_MIME = {
  "video/x-matroska": "mkv",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-msvideo": "avi",
  "video/x-ms-wmv": "wmv",
  "video/mp2t": "ts",
  "video/mpeg": "mpeg",
  "video/3gpp": "3gp"
};

const HEIGHT_BY_RESOLUTION = {
  P2160: 2160,
  P1440: 1440,
  P1080: 1080,
  P720: 720,
  P576: 576,
  P480: 480,
  P360: 360
};

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value == null ? [] : [value];
}

function firstMatchByPosition(text, patterns) {
  let best = null;
  patterns.forEach(([value, pattern]) => {
    const match = pattern.exec(text);
    if (match && (best === null || match.index < best.index)) {
      best = { value, index: match.index };
    }
  });
  return best ? best.value : null;
}

/** Video codec from free text / release tokens, or null. */
export function parseVideoCodecToken(text = "") {
  return firstMatchByPosition(cleanText(text), VIDEO_CODEC_PATTERNS);
}

/** HDR format from release tokens, or null. DV wins over HDR10(+)/HLG when both are named. */
export function parseHdrToken(text = "") {
  const value = cleanText(text);
  for (const [format, pattern] of HDR_PATTERNS) {
    if (pattern.test(value)) {
      return format;
    }
  }
  return null;
}

/** Bit depth from release tokens (10bit, 10-bit, Hi10, Main10, 12bit, 8bit), or null. */
export function parseBitDepthToken(text = "") {
  const value = cleanText(text);
  const explicit = value.match(/(?:^|[^a-z0-9])(8|10|12)[ .-]?bits?(?=$|[^a-z0-9])/i);
  if (explicit) {
    return Number(explicit[1]);
  }
  if (/(?:^|[^a-z0-9])(?:hi10p?|main[ .-]?10)(?=$|[^a-z0-9])/i.test(value)) {
    return 10;
  }
  if (/(?:^|[^a-z0-9])hi12p?(?=$|[^a-z0-9])/i.test(value)) {
    return 12;
  }
  return null;
}

/** Picture height from "1920x1080", 2160p/4K/UHD/1080p/720p/480p..., or null. */
export function parseHeightToken(text = "") {
  const value = cleanText(text);
  const dimensions = value.match(/(?:^|[^0-9])(\d{3,4})\s?[x×]\s?(\d{3,4})(?=$|[^0-9])/i);
  if (dimensions) {
    const height = Number(dimensions[2]);
    if (height >= 120 && height <= 4320) {
      return height;
    }
  }
  // "DTS-HD" names an audio format, not a 720p picture.
  const withoutAudioHd = value.replace(/dts[ .-]?hd/gi, " ");
  return HEIGHT_BY_RESOLUTION[resolutionFromText(withoutAudioHd)] || null;
}

/** Frame rate from "23.976fps", "60 fps" or "1080p60", or null. */
export function parseFrameRateToken(text = "") {
  const value = cleanText(text);
  const explicit = value.match(/(?:^|[^0-9])(\d{2,3}(?:\.\d{1,3})?)\s?fps(?=$|[^a-z0-9])/i);
  const glued = explicit
    ? null
    : value.match(/(?:^|[^0-9])(?:2160|1440|1080|720|576|480)p(\d{2}(?:\.\d{1,3})?)(?=$|[^0-9])/i);
  const rate = Number((explicit || glued)?.[1]);
  return Number.isFinite(rate) && rate >= 10 && rate <= 240 ? rate : null;
}

/** Audio codecs named in release tokens, in order of appearance, without duplicates. */
export function parseAudioCodecTokens(text = "") {
  let working = cleanText(text);
  const found = [];
  AUDIO_PATTERNS.forEach(([codec, pattern]) => {
    pattern.lastIndex = 0;
    working = working.replace(pattern, (match, offset) => {
      found.push({ codec, index: offset });
      return " ".repeat(match.length);
    });
  });
  return found
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.codec)
    .filter((codec, index, list) => list.indexOf(codec) === index);
}

/** Video codec from a structured codec string (RFC 6381 "hvc1.2.4...", fourCC "H264", "hevc"), or null. */
export function parseStructuredVideoCodec(value = "") {
  const text = cleanText(value).toLowerCase();
  if (!text) {
    return null;
  }
  if (/(?:^|[^a-z0-9])(?:hvc1|hev1|hevc|h\.?265|x265)/.test(text)) return "hevc";
  if (/(?:^|[^a-z0-9])(?:dvh1|dvhe)/.test(text)) return "hevc";
  if (/(?:^|[^a-z0-9])(?:avc1|avc3|avc|h\.?264|x264)/.test(text)) return "h264";
  if (/(?:^|[^a-z0-9])(?:av01|av1)/.test(text)) return "av1";
  if (/(?:^|[^a-z0-9])(?:vp09|vp9)/.test(text)) return "vp9";
  if (/(?:^|[^a-z0-9])(?:mpeg-?2|mp2v|h\.?262)/.test(text)) return "mpeg2";
  return null;
}

function parseStructuredAudioCodec(value = "") {
  const text = cleanText(value).toLowerCase();
  if (!text) {
    return null;
  }
  if (/mp4a|(?:^|[^a-z])aac/.test(text)) return "aac";
  if (/ec-?3|e-?ac-?3|eac3/.test(text)) return "eac3";
  if (/ac-?3|dac3/.test(text)) return "ac3";
  if (/truehd|mlp/.test(text)) return "truehd";
  if (/dts[ .-]?hd/.test(text)) return "dts-hd";
  if (/dts/.test(text)) return "dts";
  if (/opus/.test(text)) return "opus";
  if (/flac/.test(text)) return "flac";
  if (/mp3|mpeg audio|mpga/.test(text)) return "mp3";
  return null;
}

function bitDepthFromStructuredCodec(value = "") {
  const text = cleanText(value).toLowerCase();
  // RFC 6381 HEVC profile 2 is Main 10.
  if (/(?:hvc1|hev1)\.2\./.test(text)) return 10;
  if (/(?:hvc1|hev1)\.1\./.test(text)) return 8;
  // AV1: av01.<profile>.<level><tier>.<bitdepth>
  const av1 = text.match(/av01\.\d\.\d{2}[mh]\.(\d{2})/);
  if (av1) return Number(av1[1]);
  return null;
}

function lastPathSegment(url = "") {
  const raw = String(url || "").trim();
  if (!raw) {
    return "";
  }
  let path = raw;
  try {
    path = new URL(raw).pathname;
  } catch (_) {
    path = raw.split(/[?#]/)[0];
  }
  const segment = path.split("/").filter(Boolean).pop() || "";
  try {
    return decodeURIComponent(segment);
  } catch (_) {
    return segment;
  }
}

function extensionOf(name = "") {
  const match = String(name || "").match(/\.([a-z0-9]{2,4})$/i);
  return match ? match[1].toLowerCase() : "";
}

function containerFromUrlQuery(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    const hint = String(
      parsed.searchParams.get("format") ||
        parsed.searchParams.get("type") ||
        parsed.searchParams.get("container") ||
        parsed.searchParams.get("ext") ||
        ""
    ).toLowerCase();
    return (
      CONTAINER_BY_EXTENSION[hint] || (hint === "hls" ? "m3u8" : hint === "dash" ? "mpd" : null)
    );
  } catch (_) {
    return null;
  }
}

function parsedReleaseFields(stream = {}) {
  const resolve = stream.clientResolve || stream.raw?.clientResolve || {};
  const raw = resolve.stream?.raw || stream.raw || {};
  return raw.parsed && typeof raw.parsed === "object" ? raw.parsed : {};
}

function presentationFields(stream = {}) {
  const presentation = stream.streamPresentation || stream.raw?.streamPresentation || {};
  return presentation && typeof presentation === "object" ? presentation : {};
}

function behaviorHintsOf(stream = {}) {
  return stream.behaviorHints || stream.raw?.behaviorHints || {};
}

function collectFileNames(stream = {}, url = "") {
  const resolve = stream.clientResolve || stream.raw?.clientResolve || {};
  const raw = resolve.stream?.raw || stream.raw || {};
  const names = [
    ["behaviorHints.filename", behaviorHintsOf(stream).filename],
    ["raw.filename", raw.filename],
    ["clientResolve.filename", resolve.filename],
    ["debridCacheStatus.cachedName", stream.debridCacheStatus?.cachedName],
    ["torrentName", raw.torrentName || resolve.torrentName]
  ];
  const urlName = lastPathSegment(url);
  if (urlName && /\.[a-z0-9]{2,4}$/i.test(urlName)) {
    names.push(["url", urlName]);
  }
  return names
    .map(([origin, value]) => [origin, cleanText(value)])
    .filter(([, value]) => Boolean(value));
}

function collectFreeText(stream = {}) {
  return [
    ["name", stream.name],
    ["title", stream.title],
    ["description", stream.description],
    ["quality", stream.quality]
  ]
    .map(([origin, value]) => [origin, cleanText(value)])
    .filter(([, value]) => Boolean(value));
}

function createField() {
  return { value: null, confidence: "unknown", origin: null };
}

function offer(fields, sources, name, value, confidence, origin) {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) {
    return;
  }
  sources.push({ field: name, value, confidence, origin });
  const current = fields[name];
  if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[current.confidence]) {
    fields[name] = { value, confidence, origin };
  }
}

function inspectReleaseText(fields, sources, text, confidence, origin) {
  offer(fields, sources, "videoCodec", parseVideoCodecToken(text), confidence, origin);
  offer(fields, sources, "hdr", parseHdrToken(text), confidence, origin);
  offer(fields, sources, "bitDepth", parseBitDepthToken(text), confidence, origin);
  offer(fields, sources, "height", parseHeightToken(text), confidence, origin);
  offer(fields, sources, "frameRate", parseFrameRateToken(text), confidence, origin);
  offer(fields, sources, "audioCodecs", parseAudioCodecTokens(text), confidence, origin);
}

function inspectEngineInfo(fields, sources, engineInfo = null) {
  if (!engineInfo || typeof engineInfo !== "object") {
    return;
  }
  const video = engineInfo.video || {};
  const origin = `engine${engineInfo.engine ? `:${engineInfo.engine}` : ""}`;
  offer(
    fields,
    sources,
    "videoCodec",
    parseStructuredVideoCodec(video.codec || video.fourCC || ""),
    "metadata",
    origin
  );
  const height = Number(video.height);
  offer(
    fields,
    sources,
    "height",
    Number.isFinite(height) && height > 0 ? height : null,
    "metadata",
    origin
  );
  const frameRate = Number(video.frameRate);
  offer(
    fields,
    sources,
    "frameRate",
    Number.isFinite(frameRate) && frameRate > 0 ? frameRate : null,
    "metadata",
    origin
  );
  const bitDepth = Number(video.bitDepth);
  offer(
    fields,
    sources,
    "bitDepth",
    Number.isFinite(bitDepth) && bitDepth > 0 ? bitDepth : null,
    "metadata",
    origin
  );
  const audioCodecs = toArray(engineInfo.audioCodecs)
    .map((codec) => parseStructuredAudioCodec(codec))
    .filter(Boolean)
    .filter((codec, index, list) => list.indexOf(codec) === index);
  offer(fields, sources, "audioCodecs", audioCodecs, "metadata", origin);
}

function inspectParsedRelease(fields, sources, stream) {
  const parsed = parsedReleaseFields(stream);
  const presentation = presentationFields(stream);
  const origin = "parsed-release";
  offer(
    fields,
    sources,
    "videoCodec",
    parseStructuredVideoCodec(parsed.codec || parsed.videoCodec || ""),
    "metadata",
    origin
  );
  const hdrText = [...toArray(parsed.hdr), ...toArray(presentation.visualTags)].join(" ");
  offer(fields, sources, "hdr", parseHdrToken(hdrText), "metadata", origin);
  const parsedBitDepth = Number(
    String(parsed.bitDepth || parsed.bit_depth || "").replace(/[^0-9]/g, "")
  );
  offer(
    fields,
    sources,
    "bitDepth",
    Number.isFinite(parsedBitDepth) && parsedBitDepth > 0
      ? parsedBitDepth
      : parseBitDepthToken(hdrText),
    "metadata",
    origin
  );
  offer(
    fields,
    sources,
    "height",
    parseHeightToken(cleanText(parsed.resolution || presentation.resolution)),
    "metadata",
    origin
  );
  const audioText = [...toArray(parsed.audio), ...toArray(presentation.audioTags)].join(" ");
  offer(fields, sources, "audioCodecs", parseAudioCodecTokens(audioText), "metadata", origin);
  if (presentation.encode) {
    offer(
      fields,
      sources,
      "videoCodec",
      parseVideoCodecToken(presentation.encode),
      "metadata",
      "presentation.encode"
    );
  }
}

function resolveStreamType(mimeType, stream, url, container) {
  if (isLikelyHlsMimeType(mimeType)) {
    return { value: "hls", confidence: "metadata" };
  }
  if (isLikelyDashMimeType(mimeType)) {
    return { value: "dash", confidence: "metadata" };
  }
  if (isLikelySmoothStreamingMimeType(mimeType)) {
    return { value: "unknown", confidence: "metadata" };
  }
  if (!url && (stream.infoHash || stream.clientResolve?.infoHash)) {
    return { value: "p2p", confidence: "metadata" };
  }
  if (mimeType) {
    return { value: "progressive", confidence: "metadata" };
  }
  if (container.value && container.value !== "m3u8" && container.value !== "mpd") {
    return { value: "progressive", confidence: container.confidence };
  }
  return { value: "unknown", confidence: "unknown" };
}

function isLoopbackUrl(url = "") {
  return /^https?:\/\//i.test(String(url || "").trim()) && !isRemoteDirectHttpUrl(url);
}

function resolveSourceKind(stream, url, context) {
  if (url && isEngineFsUrl(url)) {
    return "enginefs";
  }
  if (context.proxied || (url && isLoopbackUrl(url))) {
    return "proxy";
  }
  const classification = classifyPlaybackSource(url ? { ...stream, url } : stream);
  if (classification.kind === "direct-http") {
    const isDebrid = Boolean(
      stream.debridCacheStatus ||
      stream.clientResolve?.service ||
      stream.clientResolve?.debrid ||
      /(?:real-?debrid|alldebrid|premiumize|torbox|debrid-link|offcloud)/i.test(url)
    );
    return isDebrid ? "debrid" : "direct-http";
  }
  return classification.kind;
}

/**
 * @typedef {object} StreamInspection
 * @property {string|null} container      "mkv" | "mp4" | "webm" | "ts" | "avi" | "mov" | "m3u8" | "mpd" | ...
 * @property {"h264"|"hevc"|"av1"|"vp9"|"mpeg2"|null} videoCodec
 * @property {number|null} bitDepth
 * @property {"hdr10"|"hdr10plus"|"dolby-vision"|"hlg"|null} hdr
 * @property {number|null} height
 * @property {number|null} frameRate
 * @property {string[]} audioCodecs       "aac" | "ac3" | "eac3" | "dts" | "dts-hd" | "truehd" | "atmos" | "opus" | "flac" | "mp3"
 * @property {"progressive"|"hls"|"dash"|"p2p"|"unknown"} streamType
 * @property {string} sourceKind          "direct-http" | "enginefs" | "proxy" | "debrid" | "p2p" | "youtube" | "direct-other" | "unresolved"
 * @property {string} mimeType            resolved source type or URL-guessed type ("" when unknown); input of the engine ladder
 * @property {boolean} isLive
 * @property {boolean} isRemoteDirectHttp
 * @property {number|null} fileSizeBytes  behaviorHints.videoSize when it is a byte count
 * @property {Object<string, "metadata"|"filename"|"text"|"unknown">} confidence
 * @property {Array<{field: string, value: *, confidence: string, origin: string}>} sources
 */

/**
 * @param {object} [stream]   a stream candidate (mapAddonStream shape, possibly with raw/clientResolve)
 * @param {object} [context]
 * @param {string} [context.url]                playback URL (defaults to the stream's direct URL)
 * @param {string|null} [context.sourceType]    source type already resolved by the player (MIME)
 * @param {string|null} [context.urlMimeType]   MIME type guessed from the URL by the player
 * @param {boolean} [context.isLive]
 * @param {boolean} [context.proxied]           playback goes through the local TV proxy
 * @param {object|null} [context.engineInfo]    { engine, video: {codec, width, height, frameRate, bitDepth}, audioCodecs: [] }
 * @returns {StreamInspection}
 */
export function inspectStream(stream = {}, context = {}) {
  const safeStream = stream && typeof stream === "object" ? stream : {};
  const safeContext = context && typeof context === "object" ? context : {};
  const url = String(
    (safeContext.url != null ? safeContext.url : streamDirectPlaybackUrl(safeStream)) || ""
  ).trim();
  const sources = [];
  const fields = {
    container: createField(),
    videoCodec: createField(),
    bitDepth: createField(),
    hdr: createField(),
    height: createField(),
    frameRate: createField(),
    audioCodecs: createField()
  };

  const declaredType = cleanText(safeContext.sourceType);
  const mimeType = String(safeContext.sourceType || safeContext.urlMimeType || "").trim();
  if (declaredType) {
    sources.push({
      field: "mimeType",
      value: declaredType,
      confidence: "metadata",
      origin: "resolved-source-type"
    });
  } else if (mimeType) {
    sources.push({ field: "mimeType", value: mimeType, confidence: "filename", origin: "url" });
  }

  // 1. Engine-reported tracks and structured metadata.
  inspectEngineInfo(fields, sources, safeContext.engineInfo);
  const codecsParameter =
    (String(safeContext.sourceType || "").match(/codecs\s*=\s*"?([^";]+)"?/i) || [])[1] || "";
  if (codecsParameter) {
    const codecList = codecsParameter.split(",").map((entry) => entry.trim());
    const videoCodecEntry = codecList.find((entry) => parseStructuredVideoCodec(entry));
    offer(
      fields,
      sources,
      "videoCodec",
      parseStructuredVideoCodec(videoCodecEntry || ""),
      "metadata",
      "mime-codecs"
    );
    offer(
      fields,
      sources,
      "bitDepth",
      bitDepthFromStructuredCodec(videoCodecEntry || ""),
      "metadata",
      "mime-codecs"
    );
    offer(
      fields,
      sources,
      "audioCodecs",
      codecList.map((entry) => parseStructuredAudioCodec(entry)).filter(Boolean),
      "metadata",
      "mime-codecs"
    );
  }
  inspectParsedRelease(fields, sources, safeStream);
  const normalizedMime = normalizeMimeType(mimeType);
  if (CONTAINER_BY_MIME[normalizedMime]) {
    offer(
      fields,
      sources,
      "container",
      CONTAINER_BY_MIME[normalizedMime],
      declaredType ? "metadata" : "filename",
      "mime"
    );
  } else if (isLikelyHlsMimeType(normalizedMime)) {
    offer(fields, sources, "container", "m3u8", declaredType ? "metadata" : "filename", "mime");
  } else if (isLikelyDashMimeType(normalizedMime)) {
    offer(fields, sources, "container", "mpd", declaredType ? "metadata" : "filename", "mime");
  }

  // 2. File names (release names are the richest source in practice).
  collectFileNames(safeStream, url).forEach(([origin, name]) => {
    offer(
      fields,
      sources,
      "container",
      CONTAINER_BY_EXTENSION[extensionOf(name)] || null,
      "filename",
      origin
    );
    inspectReleaseText(fields, sources, name, "filename", origin);
  });
  offer(fields, sources, "container", containerFromUrlQuery(url), "filename", "url-query");

  // 3. Free text shown to the user.
  collectFreeText(safeStream).forEach(([origin, text]) => {
    inspectReleaseText(fields, sources, text, "text", origin);
  });

  // HDR10/HDR10+/DV/HLG content is at least 10-bit even when no bit depth is named.
  if (fields.bitDepth.value == null && fields.hdr.value) {
    offer(fields, sources, "bitDepth", 10, fields.hdr.confidence, `implied-by-${fields.hdr.value}`);
  }

  const videoSize = behaviorHintsOf(safeStream).videoSize;
  const videoSizeNumber = Number(videoSize);
  const fileSizeBytes =
    Number.isFinite(videoSizeNumber) && videoSizeNumber > 0 ? videoSizeNumber : null;
  if (fileSizeBytes != null) {
    sources.push({
      field: "fileSizeBytes",
      value: fileSizeBytes,
      confidence: "metadata",
      origin: "behaviorHints.videoSize"
    });
  } else if (typeof videoSize === "string") {
    offer(
      fields,
      sources,
      "height",
      parseHeightToken(videoSize),
      "metadata",
      "behaviorHints.videoSize"
    );
  }

  const streamType = resolveStreamType(mimeType, safeStream, url, fields.container);
  const sourceKind = resolveSourceKind(safeStream, url, safeContext);
  sources.push({
    field: "streamType",
    value: streamType.value,
    confidence: streamType.confidence,
    origin: "source-type"
  });
  sources.push({ field: "sourceKind", value: sourceKind, confidence: "metadata", origin: "url" });

  return {
    container: fields.container.value,
    videoCodec: fields.videoCodec.value,
    bitDepth: fields.bitDepth.value,
    hdr: fields.hdr.value,
    height: fields.height.value,
    frameRate: fields.frameRate.value,
    audioCodecs: Array.isArray(fields.audioCodecs.value) ? fields.audioCodecs.value.slice() : [],
    streamType: streamType.value,
    sourceKind,
    mimeType,
    isLive: Boolean(safeContext.isLive),
    isRemoteDirectHttp: isRemoteDirectHttpUrl(url),
    fileSizeBytes,
    confidence: {
      container: fields.container.confidence,
      videoCodec: fields.videoCodec.confidence,
      bitDepth: fields.bitDepth.confidence,
      hdr: fields.hdr.confidence,
      height: fields.height.confidence,
      frameRate: fields.frameRate.confidence,
      audioCodecs: fields.audioCodecs.confidence,
      streamType: streamType.confidence,
      sourceKind: "metadata"
    },
    sources
  };
}
