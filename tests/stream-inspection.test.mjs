import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectStream,
  parseAudioCodecTokens,
  parseBitDepthToken,
  parseFrameRateToken,
  parseHdrToken,
  parseHeightToken,
  parseVideoCodecToken
} from "../js/core/player/inspection/streamInspection.js";

const VIDEO_CODEC_TOKENS = [
  ["Movie.2020.1080p.BluRay.x265-GRP", "hevc"],
  ["Movie 2020 HEVC 10bit", "hevc"],
  ["Movie.2020.H.265.WEB-DL", "hevc"],
  ["Movie.2020.H265.WEB-DL", "hevc"],
  ["Movie.2020.1080p.x264-GRP", "h264"],
  ["Movie 2020 AVC REMUX", "h264"],
  ["Movie.2020.H.264.WEB", "h264"],
  ["Movie.2020.H264.WEB", "h264"],
  ["Movie.2020.2160p.AV1.Opus", "av1"],
  ["Movie.2020.VP9.webm", "vp9"],
  ["Movie.2020.MPEG-2.DVD", "mpeg2"],
  ["Movie.2020.1080p.WEB-DL", null],
  ["Avocado documentary", null]
];

test("video codec release tokens", () => {
  for (const [text, expected] of VIDEO_CODEC_TOKENS) {
    assert.equal(parseVideoCodecToken(text), expected, text);
  }
});

const BIT_DEPTH_TOKENS = [
  ["Movie.10bit.x265", 10],
  ["Movie.10-bit.HEVC", 10],
  ["Movie 10 bit", 10],
  ["[Group] Show - 01 (BD 1080p Hi10P FLAC)", 10],
  ["Movie.Hi10.mkv", 10],
  ["Movie.HEVC.Main10", 10],
  ["Movie.12bit", 12],
  ["Movie.8bit.x264", 8],
  ["Movie.1080p.x264", null]
];

test("bit depth release tokens", () => {
  for (const [text, expected] of BIT_DEPTH_TOKENS) {
    assert.equal(parseBitDepthToken(text), expected, text);
  }
});

const HDR_TOKENS = [
  ["Movie.2160p.HDR.x265", "hdr10"],
  ["Movie.2160p.HDR10.x265", "hdr10"],
  ["Movie.2160p.HDR10+.x265", "hdr10plus"],
  ["Movie.2160p.HDR10Plus.x265", "hdr10plus"],
  ["Movie.2160p.DV.x265", "dolby-vision"],
  ["Movie.2160p.DoVi.HEVC", "dolby-vision"],
  ["Movie 2160p Dolby Vision", "dolby-vision"],
  ["Movie.2160p.DV.HDR10.HEVC", "dolby-vision"],
  ["Movie.2160p.HLG.HEVC", "hlg"],
  ["Movie.1080p.SDR.x264", null],
  ["Movie.DVDRip.x264", null]
];

test("HDR release tokens", () => {
  for (const [text, expected] of HDR_TOKENS) {
    assert.equal(parseHdrToken(text), expected, text);
  }
});

const HEIGHT_TOKENS = [
  ["Movie.2160p.WEB", 2160],
  ["Movie 4K HDR", 2160],
  ["Movie.UHD.BluRay", 2160],
  ["Movie.1080p.WEB", 1080],
  ["Movie.720p.HDTV", 720],
  ["Movie.480p.DVDRip", 480],
  ["Movie 1920x1080 AVC", 1080],
  ["Movie.DTS-HD.MA.5.1", null],
  ["Movie.WEB-DL", null]
];

test("resolution release tokens", () => {
  for (const [text, expected] of HEIGHT_TOKENS) {
    assert.equal(parseHeightToken(text), expected, text);
  }
});

const FRAME_RATE_TOKENS = [
  ["Movie.23.976fps", 23.976],
  ["Movie 24fps", 24],
  ["Movie 25 fps", 25],
  ["Movie.30fps", 30],
  ["Movie.50fps", 50],
  ["Movie.60fps", 60],
  ["Movie.2160p60.HEVC", 60],
  ["Movie.1080p50.x264", 50],
  ["Movie.1080p.x264", null]
];

test("frame rate release tokens", () => {
  for (const [text, expected] of FRAME_RATE_TOKENS) {
    assert.equal(parseFrameRateToken(text), expected, text);
  }
});

const AUDIO_TOKENS = [
  ["Movie.AAC2.0.x264", ["aac"]],
  ["Movie.AC3.5.1", ["ac3"]],
  ["Movie.DD5.1.x264", ["ac3"]],
  ["Movie.EAC3.5.1", ["eac3"]],
  ["Movie.DDP5.1.Atmos", ["eac3", "atmos"]],
  ["Movie DD+ 5.1", ["eac3"]],
  ["Movie.DTS.x264", ["dts"]],
  ["Movie.DTS-HD.MA.7.1", ["dts-hd"]],
  ["Movie.TrueHD.7.1.Atmos", ["truehd", "atmos"]],
  ["Movie.Opus.AV1", ["opus"]],
  ["Movie.FLAC.2.0", ["flac"]],
  ["Movie.DTS-HD.MA.5.1.AC3", ["dts-hd", "ac3"]],
  ["Movie.1080p.x264", []],
  ["ADDED content", []]
];

test("audio codec release tokens", () => {
  for (const [text, expected] of AUDIO_TOKENS) {
    assert.deepEqual(parseAudioCodecTokens(text), expected, text);
  }
});

test("inspectStream reads a debrid release filename with filename confidence", () => {
  const inspection = inspectStream(
    {
      name: "Torrentio\n4k DV",
      title: "Movie.2023.2160p.UHD.BluRay.x265.10bit.HDR.DDP5.1.Atmos-GRP",
      behaviorHints: {
        filename: "Movie.2023.2160p.UHD.BluRay.x265.10bit.HDR10.TrueHD.7.1.Atmos-GRP.mkv",
        videoSize: 32212254720
      }
    },
    { url: "https://cdn.example.test/dl/abc", isLive: false }
  );
  assert.equal(inspection.container, "mkv");
  assert.equal(inspection.videoCodec, "hevc");
  assert.equal(inspection.bitDepth, 10);
  assert.equal(inspection.hdr, "hdr10");
  assert.equal(inspection.height, 2160);
  assert.deepEqual(inspection.audioCodecs, ["truehd", "atmos"]);
  assert.equal(inspection.streamType, "progressive");
  assert.equal(inspection.sourceKind, "direct-http");
  assert.equal(inspection.fileSizeBytes, 32212254720);
  assert.equal(inspection.confidence.videoCodec, "filename");
  assert.equal(inspection.confidence.frameRate, "unknown");
  assert.ok(
    inspection.sources.some(
      (entry) => entry.field === "videoCodec" && entry.origin === "behaviorHints.filename"
    ),
    "sources explain where the codec came from"
  );
  // The text-only DV hint is recorded but does not override the filename.
  assert.ok(
    inspection.sources.some(
      (entry) =>
        entry.field === "hdr" && entry.value === "dolby-vision" && entry.confidence === "text"
    )
  );
});

test("inspectStream falls back to free text with text confidence", () => {
  const inspection = inspectStream(
    {
      name: "Addon 1080p",
      title: "Some Movie\nx264 AAC 23.976fps",
      url: "https://cdn.example.test/stream/1"
    },
    {}
  );
  assert.equal(inspection.videoCodec, "h264");
  assert.equal(inspection.confidence.videoCodec, "text");
  assert.equal(inspection.height, 1080);
  assert.equal(inspection.frameRate, 23.976);
  assert.deepEqual(inspection.audioCodecs, ["aac"]);
  assert.equal(inspection.streamType, "unknown");
  assert.equal(inspection.isRemoteDirectHttp, true);
});

test("inspectStream prefers engine-reported tracks and structured metadata", () => {
  const inspection = inspectStream(
    { behaviorHints: { filename: "Movie.1080p.x265.mkv" } },
    {
      url: "http://127.0.0.1:11470/0123456789abcdef0123456789abcdef01234567/0",
      engineInfo: {
        engine: "tizen-avplay",
        video: { codec: "H264", height: 720 },
        audioCodecs: ["AAC"]
      }
    }
  );
  assert.equal(inspection.videoCodec, "h264");
  assert.equal(inspection.confidence.videoCodec, "metadata");
  assert.equal(inspection.height, 720);
  assert.deepEqual(inspection.audioCodecs, ["aac"]);
  assert.equal(inspection.sourceKind, "enginefs");
  assert.equal(inspection.isRemoteDirectHttp, false);
});

test("inspectStream reads codecs from a declared MIME type and parsed release fields", () => {
  const fromMime = inspectStream(
    {},
    {
      url: "https://cdn.example.test/v.mp4",
      sourceType: 'video/mp4; codecs="hvc1.2.4.L153.B0,mp4a.40.2"'
    }
  );
  assert.equal(fromMime.videoCodec, "hevc");
  assert.equal(fromMime.bitDepth, 10);
  assert.deepEqual(fromMime.audioCodecs, ["aac"]);
  assert.equal(fromMime.container, "mp4");
  assert.equal(fromMime.confidence.container, "metadata");

  const fromParsed = inspectStream(
    {
      clientResolve: {
        stream: { raw: { parsed: { codec: "avc", resolution: "720p", audio: ["DDP"], hdr: [] } } }
      }
    },
    { url: "https://example.real-debrid.com/d/XYZ/file" }
  );
  assert.equal(fromParsed.videoCodec, "h264");
  assert.equal(fromParsed.confidence.videoCodec, "metadata");
  assert.equal(fromParsed.height, 720);
  assert.deepEqual(fromParsed.audioCodecs, ["eac3"]);
  assert.equal(fromParsed.sourceKind, "debrid");
});

test("inspectStream resolves stream type and source kind", () => {
  assert.equal(
    inspectStream(
      {},
      {
        url: "https://cdn.example.test/live/index.m3u8",
        urlMimeType: "application/vnd.apple.mpegurl"
      }
    ).streamType,
    "hls"
  );
  assert.equal(
    inspectStream({}, { url: "https://cdn.example.test/m.mpd", sourceType: "application/dash+xml" })
      .streamType,
    "dash"
  );
  assert.equal(inspectStream({ infoHash: "a".repeat(40) }, {}).streamType, "p2p");
  assert.equal(inspectStream({ infoHash: "a".repeat(40) }, {}).sourceKind, "p2p");
  assert.equal(
    inspectStream({}, { url: "http://127.0.0.1:2710/media?url=x", proxied: true }).sourceKind,
    "proxy"
  );
  assert.equal(
    inspectStream({}, { url: "https://cdn.example.test/v.mkv", urlMimeType: "video/x-matroska" })
      .streamType,
    "progressive"
  );
  const hlsLive = inspectStream(
    {},
    {
      url: "https://cdn.example.test/x.m3u8",
      urlMimeType: "application/vnd.apple.mpegurl",
      isLive: true
    }
  );
  assert.equal(hlsLive.mimeType, "application/vnd.apple.mpegurl");
  assert.equal(hlsLive.isLive, true);
});

test("inspectStream never throws on odd input", () => {
  for (const input of [null, undefined, 42, "x", [], { behaviorHints: null }, { title: {} }]) {
    const inspection = inspectStream(input, null);
    assert.equal(typeof inspection, "object");
    assert.deepEqual(inspection.audioCodecs, []);
  }
});
