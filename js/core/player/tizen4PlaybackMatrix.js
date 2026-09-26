import { mapAddonStream } from "../streams/playbackSource.js";
import {
  buildTizenAvPlayProxyBaseUrl,
  buildTizenPlaybackProxyUrl,
  TizenPlaybackProxy
} from "../../platform/tizen/tizenPlaybackProxy.js";
import { loadStreamingLibs } from "../../runtime/loadStreamingLibs.js";
import { TizenEngineFsService } from "../../platform/tizen/tizenEngineFsService.js";

export const TIZEN4_PLAYBACK_MATRIX_STORAGE_KEY = "nuvio_tizen4_playback_matrix_v1";
export const TIZEN4_PLAYBACK_MATRIX_RESULT_FILE = "tizen4-playback-matrix.json";
export const TIZEN4_MATRIX_REMOTE_MP4 =
  "https://media.w3.org/2010/05/bunny/trailer.mp4";
export const TIZEN4_MATRIX_REMOTE_HLS =
  "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8";
export const TIZEN4_MATRIX_GOOGLE_MP4_HTTPS =
  "https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
export const TIZEN4_MATRIX_GOOGLE_MP4_HTTP =
  "http://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
export const TIZEN4_MATRIX_GOOGLE_HLS =
  "https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8";
export const TIZEN4_MATRIX_GOOGLE_DASH =
  "https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd";
export const TIZEN4_MATRIX_SINTEL_INFO_HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";

export function createTizen4PlaybackMatrixCases(
  baseUrl = globalThis.location?.href || "",
  lanMediaUrl = globalThis.__NUVIO_TIZEN4_MATRIX_LAN_MEDIA_URL__ || "",
  p2pEnabled = globalThis.__NUVIO_TIZEN4_MATRIX_P2P__ === true
) {
  const packagedUrl = new URL("assets/tizen4-probe.mp4", baseUrl).href;
  const controlledUrl = String(lanMediaUrl || packagedUrl).trim();
  const source = (name, url, mimeType) => ({
    ...mapAddonStream({ name, title: name, url }),
    mimeType,
    sourceType: mimeType,
    addonId: "tizen4-playback-matrix",
    addonName: "Tizen 4 playback matrix"
  });
  const cases = [
    { id: "controlled-http-html", engine: "html", source: source("Controlled HTTP MP4", controlledUrl, "video/mp4") },
    { id: "google-hls-hlsjs", engine: "hls.js", source: source("Google HLS via MSE", TIZEN4_MATRIX_GOOGLE_HLS, "application/vnd.apple.mpegurl") },
    { id: "google-dash-dashjs", engine: "dash.js", source: source("Google DASH via MSE", TIZEN4_MATRIX_GOOGLE_DASH, "application/dash+xml") }
  ];
  if (p2pEnabled) {
    cases.push(
      { id: "sintel-p2p-html", engine: "html", viaP2p: true, exerciseLifecycle: true, preferDeviceAddress: false, timeoutMs: 45000, source: source("Sintel torrent via HTML", "", "video/mp4") },
      { id: "sintel-p2p-avplay", engine: "avplay", viaP2p: true, exerciseLifecycle: true, preferDeviceAddress: true, timeoutMs: 45000, source: source("Sintel torrent via AVPlay", "", "video/mp4") }
    );
  }
  return cases;
}

async function resolveMatrixCase(testCase) {
  if (testCase.viaP2p) {
    try {
      // Bypass only the unverified production policy gate. The diagnostic
      // still requires the real packaged service to start and answer health.
      const service = await TizenEngineFsService.ensureStarted({ purpose: "p2p-probe" });
      if (service?.status !== "success" || !service.baseUrl) {
        throw new Error(service?.detail || "EngineFS unavailable");
      }
      const hash = TIZEN4_MATRIX_SINTEL_INFO_HASH;
      const response = await withWatchdog(
        fetch(`${service.baseUrl}/${hash}/create`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            torrent: { infoHash: hash },
            peerSearch: {
              sources: [
                `dht:${hash}`,
                "tracker:udp://tracker.opentrackr.org:1337/announce"
              ],
              min: 1,
              max: 80
            },
            guessFileIdx: {}
          })
        }),
        60000,
        "p2p-create"
      );
      if (!response.ok) throw new Error(`p2p-create-http-${response.status}`);
      const metadata = await response.json();
      const fileIdx = Number(metadata?.guessedFileIdx ?? metadata?.fileIdx);
      if (!Number.isFinite(fileIdx) || fileIdx < 0) throw new Error("p2p-file-index-missing");
      let playbackBaseUrl = service.baseUrl;
      if (testCase.preferDeviceAddress) {
        playbackBaseUrl = buildTizenAvPlayProxyBaseUrl(service.baseUrl);
      }
      return {
        ...testCase,
        source: {
          ...testCase.source,
          url: `${String(playbackBaseUrl).replace(/\/+$/, "")}/${hash}/${fileIdx}`
        },
        p2pMetadata: {
          fileIdx,
          filename: String(metadata?.files?.[fileIdx]?.name || metadata?.streamName || ""),
          peers: Number(metadata?.peers || 0)
        }
      };
    } catch (error) {
      return {
        ...testCase,
        setupError: `p2p-setup: ${String(error?.message || error || "unknown error")}`
      };
    }
  }
  if (!testCase.viaProxy) return testCase;
  const proxyResult = await TizenPlaybackProxy.resolve(
    testCase.source.url,
    { "X-Nuvio-Playback-Probe": "matrix18" },
    {
      playbackEngine: testCase.engine === "hls.js" ? "hls.js" : testCase.engine.includes("html") ? "native-file" : "tizen-avplay",
      preferDeviceAddress: testCase.preferDeviceAddress === true
    }
  );
  if (proxyResult?.status !== "success" || !proxyResult.url) {
    return {
      ...testCase,
      setupError: `proxy-${String(proxyResult?.status || "unknown")}: ${String(proxyResult?.detail || "no proxy URL")}`
    };
  }
  if (testCase.proxyEachRequest) {
    return {
      ...testCase,
      proxyBaseUrl: proxyResult.baseUrl,
      proxyHeaders: { "X-Nuvio-Playback-Probe": "matrix18" },
      proxyStatus: proxyResult.status
    };
  }
  if (testCase.viaBlob) {
    try {
      const response = await withWatchdog(fetch(proxyResult.url, { cache: "no-cache" }), 20000, "blob-fetch");
      if (!response.ok) throw new Error(`blob-fetch-http-${response.status}`);
      const blob = await withWatchdog(response.blob(), 20000, "blob-body");
      const objectUrl = URL.createObjectURL(blob);
      return {
        ...testCase,
        source: { ...testCase.source, url: objectUrl },
        objectUrl,
        proxyStatus: proxyResult.status
      };
    } catch (error) {
      return {
        ...testCase,
        setupError: `blob-proxy: ${String(error?.message || error || "unknown error")}`
      };
    }
  }
  return {
    ...testCase,
    source: { ...testCase.source, url: proxyResult.url },
    proxyStatus: proxyResult.status
  };
}

export function scoreTizen4PlaybackResult(result) {
  const progressMs = Math.max(0, Number(result?.progressMs) || 0);
  const startupMs = Math.max(0, Number(result?.startupMs) || 0);
  const stalls = Math.max(0, Number(result?.stalls) || 0);
  if (result?.error || progressMs < 1500) return { verdict: "FAIL", score: 0 };
  const startupScore = Math.max(0, 45 - Math.round(startupMs / 250));
  const continuityScore = Math.max(0, 55 - stalls * 8);
  return { verdict: stalls > 2 ? "PARTIAL" : "PASS", score: startupScore + continuityScore };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withWatchdog(promise, timeoutMs, label) {
  return Promise.race([
    Promise.resolve(promise),
    wait(timeoutMs).then(() => {
      throw new Error(`${label}-timeout`);
    })
  ]);
}

export async function persistTizen4PlaybackMatrixResult(summary) {
  const payload = JSON.stringify(summary);
  try {
    console.log(`NUVIO_TIZEN4_MATRIX_RESULT ${payload}`);
  } catch (_) {}

  const filesystem = globalThis.tizen?.filesystem;
  if (!filesystem?.resolve) return false;
  return new Promise((resolve) => {
    filesystem.resolve(
      "wgt-private",
      (directory) => {
        try {
          let file;
          try {
            file = directory.resolve(TIZEN4_PLAYBACK_MATRIX_RESULT_FILE);
          } catch (_) {
            file = directory.createFile(TIZEN4_PLAYBACK_MATRIX_RESULT_FILE);
          }
          file.openStream(
            "w",
            (stream) => {
              try {
                stream.write(payload);
                stream.close();
                resolve(true);
              } catch (_) {
                try {
                  stream.close();
                } catch (_) {}
                resolve(false);
              }
            },
            () => resolve(false),
            "UTF-8"
          );
        } catch (_) {
          resolve(false);
        }
      },
      () => resolve(false),
      "rw"
    );
  });
}

function describePlaybackError(error, fallback = "unknown-error") {
  if (error == null) return fallback;
  if (typeof error === "string") return error || fallback;
  const details = [];
  if (error.name) details.push(String(error.name));
  if (error.message && String(error.message) !== String(error.name || "")) details.push(String(error.message));
  if (error.code != null) details.push(`code=${String(error.code)}`);
  return details.join(": ") || String(error) || fallback;
}

async function runHtmlCase(testCase, video, timeoutMs) {
  const startedAt = Date.now();
  const result = { id: testCase.id, engine: "html", startupMs: 0, progressMs: 0, durationMs: 0, stalls: 0, error: "" };
  let firstProgressAt = 0;
  let lastTimeMs = 0;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    result.readyState = Number(video.readyState || 0);
    result.networkState = Number(video.networkState || 0);
    result.durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    result.progressMs = Math.max(result.progressMs, Math.round(Number(video.currentTime || 0) * 1000));
    const quality = video.getVideoPlaybackQuality?.();
    if (quality) {
      result.totalFrames = Number(quality.totalVideoFrames || 0);
      result.droppedFrames = Number(quality.droppedVideoFrames || 0);
    }
  };
  const onPlaying = () => {
    if (!result.startupMs) result.startupMs = Date.now() - startedAt;
  };
  const onTimeUpdate = () => {
    const current = Math.round(Number(video.currentTime || 0) * 1000);
    if (current > lastTimeMs) {
      if (!firstProgressAt) firstProgressAt = Date.now();
      lastTimeMs = current;
      result.progressMs = current;
    }
  };
  const onWaiting = () => {
    if (firstProgressAt) result.stalls += 1;
  };
  const onError = () => {
    result.error = `media-${Number(video.error?.code || 0)}`;
    finish();
  };
  video.addEventListener("playing", onPlaying);
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("waiting", onWaiting);
  video.addEventListener("stalled", onWaiting);
  video.addEventListener("error", onError);
  try {
    video.pause();
    video.removeAttribute("src");
    if (testCase.crossOrigin) video.crossOrigin = "anonymous";
    else video.removeAttribute("crossorigin");
    video.load();
    video.src = testCase.source.url;
    video.load();
    const playPromise = video.play();
    if (playPromise && typeof playPromise.then === "function") {
      // Chromium 56 can leave play() pending forever for an unsupported or
      // unreachable source. Start measuring immediately and observe only a
      // short rejection window; the outer deadline remains authoritative.
      await Promise.race([playPromise, wait(750)]).catch((error) => {
        result.error = String(error?.name || error?.message || error || "play-rejected");
      });
    }
    const deadline = Date.now() + timeoutMs;
    while (!settled && Date.now() < deadline && result.progressMs < 5000) {
      await wait(250);
      onTimeUpdate();
    }
    if (!result.error && testCase.exerciseLifecycle && result.progressMs >= 1500) {
      const pausedAtMs = Math.round(Number(video.currentTime || 0) * 1000);
      video.pause();
      await wait(900);
      const pausedAfterMs = Math.round(Number(video.currentTime || 0) * 1000);
      const pauseDriftMs = Math.abs(pausedAfterMs - pausedAtMs);
      if (pauseDriftMs > 500) throw new Error(`pause-drift-${pauseDriftMs}ms`);
      const seekTargetMs = 120000;
      video.currentTime = seekTargetMs / 1000;
      await video.play();
      const seekDeadline = Math.min(deadline, Date.now() + 20000);
      while (!settled && Date.now() < seekDeadline && Number(video.currentTime || 0) < 122) {
        await wait(250);
        onTimeUpdate();
      }
      const seekReachedMs = Math.round(Number(video.currentTime || 0) * 1000);
      result.lifecycle = {
        pauseResume: true,
        pauseDriftMs,
        seekTargetMs,
        seekReachedMs,
        seekContinued: seekReachedMs >= 122000
      };
      if (!result.lifecycle.seekContinued) throw new Error(`seek-no-progress-${seekReachedMs}ms`);
    }
    if (!result.error && result.progressMs < 1500) result.error = "no-time-progress";
    finish();
  } catch (error) {
    result.error = `lifecycle: ${describePlaybackError(error)}`;
    finish();
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.removeAttribute("crossorigin");
    video.load();
    video.removeEventListener("playing", onPlaying);
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("waiting", onWaiting);
    video.removeEventListener("stalled", onWaiting);
    video.removeEventListener("error", onError);
  }
  return { ...result, ...scoreTizen4PlaybackResult(result) };
}

async function runAvPlayCase(testCase, timeoutMs) {
  const avplay = globalThis.webapis?.avplay;
  const startedAt = Date.now();
  const result = { id: testCase.id, engine: "avplay", startupMs: 0, progressMs: 0, durationMs: 0, stalls: 0, error: "" };
  if (!avplay) return { ...result, error: "avplay-unavailable", ...scoreTizen4PlaybackResult(result) };
  let completed = false;
  let phase = "reset";
  const listener = {
    onbufferingstart() {
      if (result.progressMs) result.stalls += 1;
    },
    onbufferingprogress() {},
    onbufferingcomplete() {},
    oncurrentplaytime(time) {
      if (!result.startupMs) result.startupMs = Date.now() - startedAt;
      result.progressMs = Math.max(result.progressMs, Number(time) || 0);
    },
    onstreamcompleted() {
      completed = true;
    },
    onerror(error) {
      result.error = `${phase}: ${describePlaybackError(error, "avplay-error")}`;
      completed = true;
    },
    onerrormsg(error, message) {
      result.error = `${phase}: ${describePlaybackError(error, "avplay-error")}: ${String(message || "")}`;
      completed = true;
    },
    onevent() {},
    onsubtitlechange() {},
    ondrmevent() {}
  };
  try {
    try {
      if (avplay.getState?.() !== "NONE") avplay.close();
    } catch (_) {}
    // Samsung's documented state sequence is open (NONE -> IDLE), then
    // listener/display configuration, prepareAsync, and finally play.
    phase = "open";
    avplay.open(testCase.source.url);
    phase = "listener";
    avplay.setListener(listener);
    phase = "display";
    avplay.setDisplayRect(0, 0, 1920, 1080);
    phase = "prepare";
    await withWatchdog(
      new Promise((resolve, reject) => avplay.prepareAsync(resolve, reject)),
      timeoutMs,
      "prepare"
    );
    result.durationMs = Number(avplay.getDuration?.() || 0);
    phase = "play";
    avplay.play();
    const deadline = Date.now() + timeoutMs;
    while (!completed && Date.now() < deadline && result.progressMs < 5000) await wait(250);
    if (!result.error && testCase.exerciseLifecycle && result.progressMs >= 1500) {
      phase = "pause";
      avplay.pause();
      const pausedAtMs = Number(avplay.getCurrentTime?.() || 0);
      await wait(900);
      const pausedAfterMs = Number(avplay.getCurrentTime?.() || 0);
      const pauseDriftMs = Math.abs(pausedAfterMs - pausedAtMs);
      if (pauseDriftMs > 500) throw new Error(`pause-drift-${pauseDriftMs}ms`);
      phase = "resume";
      avplay.play();
      const seekTargetMs = 120000;
      phase = "seek";
      await withWatchdog(
        new Promise((resolve, reject) => avplay.seekTo(seekTargetMs, resolve, reject)),
        15000,
        "seek"
      );
      const seekDeadline = Math.min(deadline, Date.now() + 20000);
      let seekReachedMs = Number(avplay.getCurrentTime?.() || 0);
      while (!completed && Date.now() < seekDeadline && seekReachedMs < 122000) {
        await wait(250);
        seekReachedMs = Number(avplay.getCurrentTime?.() || 0);
        result.progressMs = Math.max(result.progressMs, seekReachedMs);
      }
      result.lifecycle = {
        pauseResume: true,
        pauseDriftMs,
        seekTargetMs,
        seekReachedMs,
        seekContinued: seekReachedMs >= 122000
      };
      if (!result.lifecycle.seekContinued) throw new Error(`seek-no-progress-${seekReachedMs}ms`);
      phase = "play";
    }
    if (!result.error && result.progressMs < 1500) result.error = "no-time-progress";
  } catch (error) {
    result.error = `${phase}: ${describePlaybackError(error, "avplay-exception")}`;
  } finally {
    const skipBlockedPrepareCleanup =
      testCase.skipCleanupOnPrepareTimeout && phase === "prepare" && result.error.includes("prepare-timeout");
    if (skipBlockedPrepareCleanup) {
      result.cleanupSkipped = true;
    } else {
      try {
        const cleanupState = String(avplay.getState?.() || "").toUpperCase();
        if (cleanupState === "PLAYING" || cleanupState === "PAUSED") avplay.stop();
      } catch (_) {}
      try {
        avplay.close();
      } catch (_) {}
    }
  }
  return { ...result, phase, state: String(avplay.getState?.() || "NONE"), ...scoreTizen4PlaybackResult(result) };
}

async function runHlsJsCase(testCase, video, timeoutMs) {
  const startedAt = Date.now();
  const result = { id: testCase.id, engine: "hls.js", startupMs: 0, progressMs: 0, durationMs: 0, stalls: 0, error: "" };
  let hls = null;
  const onPlaying = () => { if (!result.startupMs) result.startupMs = Date.now() - startedAt; };
  const onTimeUpdate = () => { result.progressMs = Math.max(result.progressMs, Math.round((Number(video.currentTime) || 0) * 1000)); };
  const onWaiting = () => { if (result.progressMs) result.stalls += 1; };
  try {
    await withWatchdog(loadStreamingLibs({ hls: true, dash: false }), timeoutMs, "hls-library");
    const Hls = globalThis.Hls;
    if (!Hls?.isSupported?.()) throw new Error("hls-mse-unsupported");
    const hlsConfig = { enableWorker: false, maxBufferLength: 20, backBufferLength: 1 };
    if (testCase.proxyBaseUrl) {
      // Keep hls.js's original URLs for playlist and segment resolution, then
      // redirect only each outgoing request. This avoids subclassing its XHR
      // loader, which can remain pending indefinitely on Chromium 56.
      hlsConfig.xhrSetup = (xhr, url) => {
        const proxyUrl = buildTizenPlaybackProxyUrl(
          testCase.proxyBaseUrl,
          url,
          testCase.proxyHeaders || {},
          { browserTransport: true }
        );
        if (!proxyUrl) throw new Error("hls-proxy-url-unavailable");
        xhr.open("GET", proxyUrl, true);
      };
    }
    hls = new Hls(hlsConfig);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    hls.on(Hls.Events.ERROR, (_, data = {}) => {
      if (data.fatal && !result.error) result.error = `${String(data.type || "hls-error")}: ${String(data.details || "fatal")}`;
    });
    hls.loadSource(testCase.source.url);
    hls.attachMedia(video);
    await withWatchdog(
      new Promise((resolve, reject) => {
        hls.on(Hls.Events.MANIFEST_PARSED, resolve);
        hls.on(Hls.Events.ERROR, (_, data = {}) => { if (data.fatal) reject(new Error(String(data.details || data.type || "hls-error"))); });
      }),
      timeoutMs,
      "hls-manifest"
    );
    await video.play();
    const deadline = Date.now() + timeoutMs;
    while (!result.error && Date.now() < deadline && result.progressMs < 5000) await wait(250);
    result.durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    if (!result.error && result.progressMs < 1500) result.error = "no-time-progress";
  } catch (error) {
    result.error = error?.message || String(error || "hls-exception");
  } finally {
    try { hls?.destroy?.(); } catch (_) {}
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.removeEventListener("playing", onPlaying);
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("waiting", onWaiting);
    video.removeEventListener("stalled", onWaiting);
  }
  return { ...result, ...scoreTizen4PlaybackResult(result) };
}

async function runDashJsCase(testCase, video, timeoutMs) {
  const startedAt = Date.now();
  const result = { id: testCase.id, engine: "dash.js", startupMs: 0, progressMs: 0, durationMs: 0, stalls: 0, error: "" };
  let player = null;
  const onPlaying = () => { if (!result.startupMs) result.startupMs = Date.now() - startedAt; };
  const onTimeUpdate = () => { result.progressMs = Math.max(result.progressMs, Math.round((Number(video.currentTime) || 0) * 1000)); };
  const onWaiting = () => { if (result.progressMs) result.stalls += 1; };
  try {
    await withWatchdog(loadStreamingLibs({ hls: false, dash: true }), timeoutMs, "dash-library");
    const dashjs = globalThis.dashjs;
    if (!dashjs?.MediaPlayer) throw new Error("dash-mse-unsupported");
    player = dashjs.MediaPlayer().create();
    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    player.updateSettings?.({ streaming: { buffer: { bufferToKeep: 10, bufferTimeDefault: 10 } } });
    player.initialize(video, testCase.source.url, true);
    const deadline = Date.now() + timeoutMs;
    while (!result.error && Date.now() < deadline && result.progressMs < 5000) await wait(250);
    result.durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    if (!result.error && result.progressMs < 1500) result.error = "no-time-progress";
  } catch (error) {
    result.error = error?.message || String(error || "dash-exception");
  } finally {
    // dash.js reset can block the Tizen 4 renderer after successful MSE
    // playback. The diagnostic element is removed immediately after the final
    // case, so release the reference and let the app teardown reclaim it.
    player = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.removeEventListener("playing", onPlaying);
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("waiting", onWaiting);
    video.removeEventListener("stalled", onWaiting);
  }
  return { ...result, ...scoreTizen4PlaybackResult(result) };
}

export async function runTizen4PlaybackMatrix({ onUpdate = () => {}, timeoutMs = 10000 } = {}) {
  globalThis.__NUVIO_TIZEN4_REPORT_STAGE__?.("matrix-run-start");
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:2147483000";
  document.body.appendChild(video);
  const results = [];
  try {
    const cases = createTizen4PlaybackMatrixCases();
    for (let index = 0; index < cases.length; index += 1) {
      const testCase = await resolveMatrixCase(cases[index]);
      globalThis.__NUVIO_TIZEN4_REPORT_STAGE__?.(`matrix-case-${testCase.id}`, { results: [...results] });
      onUpdate({ phase: "running", index, total: cases.length, testCase, results: [...results] });
      const result = testCase.setupError
        ? { id: testCase.id, engine: testCase.engine, startupMs: 0, progressMs: 0, durationMs: 0, stalls: 0, error: testCase.setupError, verdict: "FAIL", score: 0 }
        : testCase.engine === "avplay"
          ? await runAvPlayCase(testCase, testCase.timeoutMs || timeoutMs)
          : testCase.engine === "hls.js"
            ? await runHlsJsCase(testCase, video, testCase.timeoutMs || timeoutMs)
            : testCase.engine === "dash.js"
              ? await runDashJsCase(testCase, video, testCase.timeoutMs || timeoutMs)
              : await runHtmlCase(testCase, video, testCase.timeoutMs || timeoutMs);
      results.push(result);
      globalThis.__NUVIO_TIZEN4_REPORT_STAGE__?.(`matrix-result-${testCase.id}`, { results: [...results] });
      onUpdate({ phase: "result", index, total: cases.length, testCase, result, results: [...results] });
      if (index === cases.length - 1) {
        // Publish the authoritative result before optional media/filesystem
        // cleanup. Old Tizen renderers can keep adaptive-player teardown
        // pending even though playback evidence is already complete.
        const completedAt = new Date().toISOString();
        const earlySummary = { completedAt, userAgent: navigator.userAgent, results: [...results] };
        globalThis.__NUVIO_TIZEN4_REPORT_STAGE__?.("complete", { results: [...results], summary: earlySummary });
        onUpdate({ phase: "complete", results: [...results], summary: earlySummary });
      }
      if (testCase.objectUrl) URL.revokeObjectURL(testCase.objectUrl);
      await wait(500);
    }
  } finally {
    video.remove();
  }
  const summary = { completedAt: new Date().toISOString(), userAgent: navigator.userAgent, results };
  try {
    try {
      localStorage.setItem(TIZEN4_PLAYBACK_MATRIX_STORAGE_KEY, JSON.stringify(summary));
    } catch (_) {
      // Private-mode/storage policy failures must not turn completed media
      // evidence into a matrix-level error on older Samsung firmware.
    }
  } catch (_) {}
  try {
    summary.privateResultFileWritten = await withWatchdog(
      persistTizen4PlaybackMatrixResult(summary),
      3000,
      "matrix-result-file"
    );
  } catch (_) {
    summary.privateResultFileWritten = false;
  }
  onUpdate({ phase: "complete", results: [...results], summary });
  return summary;
}

function formatMatrixResult(result) {
  const details = [
    result.verdict,
    `score ${result.score}`,
    `start ${result.startupMs || 0}ms`,
    `play ${result.progressMs || 0}ms`,
    `stalls ${result.stalls || 0}`
  ];
  if (result.error) details.push(`error ${result.error}`);
  return `${result.id}: ${details.join(" · ")}`;
}

export function openTizen4PlaybackMatrixOverlay() {
  document.querySelector("#tizen4PlaybackMatrixOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "tizen4PlaybackMatrixOverlay";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483200;background:rgba(5,8,14,.88);color:#fff;padding:64px 80px;font:28px/1.35 sans-serif;overflow:auto";
  const title = document.createElement("h1");
  title.textContent = "Tizen 4 playback matrix · MATRIX1";
  title.style.cssText = "font-size:48px;margin:0 0 22px";
  const status = document.createElement("p");
  status.textContent = "Starting eight controlled playback paths…";
  const output = document.createElement("pre");
  output.style.cssText = "white-space:pre-wrap;font:24px/1.5 monospace;margin-top:24px";
  const hint = document.createElement("p");
  hint.textContent = "Please wait for COMPLETE. Press Back to close the finished report.";
  hint.style.cssText = "font-size:22px;opacity:.8;margin-top:30px";
  overlay.append(title, status, output, hint);
  document.body.appendChild(overlay);
  let complete = false;
  let results = [];
  const close = () => {
    if (!complete) return;
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape" || event.keyCode === 10009 || event.keyCode === 27) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);
  void runTizen4PlaybackMatrix({
    onUpdate(update) {
      results = update.results || results;
      if (update.phase === "running") {
        status.textContent = `RUNNING ${update.index + 1}/${update.total}: ${update.testCase.id}`;
      } else if (update.phase === "complete") {
        complete = true;
        status.textContent = "COMPLETE · results saved locally";
      }
      output.textContent = results.length ? results.map(formatMatrixResult).join("\n") : "No result yet.";
    }
  })
    .then(async (summary) => {
      const reportUrl = String(globalThis.__NUVIO_TIZEN4_MATRIX_REPORT_URL__ || "").trim();
      if (!reportUrl) return;
      try {
        await fetch(reportUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify(summary)
        });
        status.textContent = "COMPLETE · results sent to development PC";
      } catch (error) {
        output.textContent += `\nreport-error: ${String(error?.message || error)}`;
      }
    })
    .catch((error) => {
      complete = true;
      status.textContent = "MATRIX ERROR";
      output.textContent = `${output.textContent}\n${String(error?.stack || error?.message || error)}`;
    });
  return overlay;
}
