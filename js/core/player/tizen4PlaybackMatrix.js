import { mapAddonStream } from "../streams/playbackSource.js";
import { TizenPlaybackProxy } from "../../platform/tizen/tizenPlaybackProxy.js";

export const TIZEN4_PLAYBACK_MATRIX_STORAGE_KEY = "nuvio_tizen4_playback_matrix_v1";
export const TIZEN4_PLAYBACK_MATRIX_RESULT_FILE = "tizen4-playback-matrix.json";
export const TIZEN4_MATRIX_REMOTE_MP4 =
  "https://media.w3.org/2010/05/bunny/trailer.mp4";
export const TIZEN4_MATRIX_REMOTE_HLS =
  "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8";

export function createTizen4PlaybackMatrixCases(
  baseUrl = globalThis.location?.href || "",
  lanMediaUrl = globalThis.__NUVIO_TIZEN4_MATRIX_LAN_MEDIA_URL__ || ""
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
  return [
    { id: "controlled-http-html", engine: "html", source: source("Controlled HTTP MP4", controlledUrl, "video/mp4") },
    { id: "controlled-http-avplay", engine: "avplay", source: source("Controlled HTTP MP4", controlledUrl, "video/mp4") },
    { id: "direct-https-mp4-avplay", engine: "avplay", source: source("Direct HTTPS MP4", TIZEN4_MATRIX_REMOTE_MP4, "video/mp4") },
    { id: "proxied-https-mp4-html", engine: "html", viaProxy: true, crossOrigin: true, source: source("Proxied HTTPS MP4", TIZEN4_MATRIX_REMOTE_MP4, "video/mp4") },
    { id: "proxied-https-mp4-lan-html", engine: "html", viaProxy: true, preferDeviceAddress: true, crossOrigin: true, source: source("LAN-addressed proxied HTTPS MP4", TIZEN4_MATRIX_REMOTE_MP4, "video/mp4") },
    { id: "proxied-https-mp4-blob-html", engine: "blob-html", viaProxy: true, viaBlob: true, source: source("Proxied HTTPS MP4 blob", TIZEN4_MATRIX_REMOTE_MP4, "video/mp4") },
    { id: "proxied-https-mp4-avplay", engine: "avplay", viaProxy: true, source: source("Proxied HTTPS MP4", TIZEN4_MATRIX_REMOTE_MP4, "video/mp4") },
    { id: "proxied-https-hls-avplay", engine: "avplay", viaProxy: true, skipCleanupOnPrepareTimeout: true, source: source("Proxied HTTPS HLS", TIZEN4_MATRIX_REMOTE_HLS, "application/vnd.apple.mpegurl") }
  ];
}

async function resolveMatrixCase(testCase) {
  if (!testCase.viaProxy) return testCase;
  const proxyResult = await TizenPlaybackProxy.resolve(
    testCase.source.url,
    { "X-Nuvio-Playback-Probe": "matrix9" },
    {
      playbackEngine: testCase.engine.includes("html") ? "native-file" : "tizen-avplay",
      preferDeviceAddress: testCase.preferDeviceAddress === true
    }
  );
  if (proxyResult?.status !== "success" || !proxyResult.url) {
    return {
      ...testCase,
      setupError: `proxy-${String(proxyResult?.status || "unknown")}: ${String(proxyResult?.detail || "no proxy URL")}`
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
  if (progressMs < 1500) return { verdict: "FAIL", score: 0 };
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
    if (!result.error && result.progressMs < 1500) result.error = "no-time-progress";
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
          ? await runAvPlayCase(testCase, timeoutMs)
          : await runHtmlCase(testCase, video, timeoutMs);
      results.push(result);
      globalThis.__NUVIO_TIZEN4_REPORT_STAGE__?.(`matrix-result-${testCase.id}`, { results: [...results] });
      onUpdate({ phase: "result", index, total: cases.length, testCase, result, results: [...results] });
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
    summary.privateResultFileWritten = await persistTizen4PlaybackMatrixResult(summary);
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
