// HTML5 backend adapter: the <video id="videoPlayer"> element, fed directly
// ("native-file", "native-hls", "native-dash") or through MSE ("hls.js",
// "dash.js"). Thin adapter over PlayerController's existing native/hls.js/
// dash.js methods; track handling is routed to the engine that owns it.

import { timeRangesToArray } from "./playerBackend.js";

export const HTML5_ENGINES = Object.freeze([
  "native-file",
  "native-hls",
  "native-dash",
  "hls.js",
  "dash.js"
]);

function textTrackListToArray(video) {
  const list = video?.textTracks || video?.webkitTextTracks || video?.mozTextTracks || null;
  if (!list) {
    return [];
  }
  try {
    return Array.from(list).filter(Boolean);
  } catch (_) {
    const tracks = [];
    const count = Number(list.length || 0);
    for (let index = 0; index < count; index += 1) {
      const track = list[index] || list.item?.(index) || null;
      if (track) {
        tracks.push(track);
      }
    }
    return tracks;
  }
}

/**
 * @param {object} controller PlayerController (or a compatible object)
 * @param {string} [engine]   one of HTML5_ENGINES; defaults to the controller's active engine
 * @returns {import("./playerBackend.js").PlayerBackend}
 */
export function createHtml5Backend(controller, engine = null) {
  const engineName = () => {
    const requested = String(engine || "").trim();
    if (requested) {
      return requested;
    }
    const active = String(controller.playbackEngine || "").trim();
    return HTML5_ENGINES.includes(active) ? active : "native-file";
  };
  const video = () => controller.video || null;
  return {
    name: "html5",
    get engine() {
      return engineName();
    },
    load(url, options = {}) {
      return Promise.resolve(controller.play(url, { ...options, forceEngine: engineName() }));
    },
    play() {
      controller.resume();
    },
    pause() {
      controller.pause();
    },
    stop(options = {}) {
      return controller.stop(options);
    },
    seek(seconds) {
      return Boolean(controller.seekToSeconds(seconds));
    },
    setVolume(level) {
      const element = video();
      const value = Number(level);
      if (!element || !Number.isFinite(value)) {
        return false;
      }
      try {
        element.volume = Math.min(1, Math.max(0, value));
        return true;
      } catch (_) {
        return false;
      }
    },
    getVolume() {
      const value = Number(video()?.volume);
      return Number.isFinite(value) ? value : null;
    },
    getDuration() {
      return Number(controller.getDurationSeconds() || 0);
    },
    getCurrentTime() {
      return Number(controller.getCurrentTimeSeconds() || 0);
    },
    getBufferedRanges() {
      return timeRangesToArray(video()?.buffered);
    },
    isPaused() {
      return Boolean(video()?.paused);
    },
    isSeeking() {
      return Boolean(video()?.seeking);
    },
    isEnded() {
      return Boolean(controller.isPlaybackEnded());
    },
    getReadyState() {
      return Number(controller.getPlaybackReadyState() || 0);
    },
    getAudioTracks() {
      const name = engineName();
      if (name === "hls.js") {
        return controller.getHlsAudioTracks();
      }
      if (name === "dash.js") {
        return controller.getDashAudioTracks();
      }
      return controller.nativeAudioTrackListToArray();
    },
    selectAudioTrack(index) {
      const name = engineName();
      if (name === "hls.js") {
        return Boolean(controller.setHlsAudioTrack(index));
      }
      if (name === "dash.js") {
        return Boolean(controller.setDashAudioTrack(index));
      }
      return Boolean(controller.setNativeAudioTrack(index));
    },
    getSubtitleTracks() {
      const name = engineName();
      if (name === "hls.js") {
        return controller.getHlsSubtitleTracks();
      }
      if (name === "dash.js") {
        return controller.getDashTextTracks();
      }
      return textTrackListToArray(video());
    },
    selectSubtitleTrack(index) {
      const name = engineName();
      if (name === "hls.js") {
        return Boolean(controller.setHlsSubtitleTrack(index));
      }
      if (name === "dash.js") {
        return Boolean(controller.setDashTextTrack(index));
      }
      return Boolean(controller.setNativeTextTrack(index));
    },
    on(eventName, handler) {
      controller.on(eventName, handler);
    },
    off(eventName, handler) {
      controller.off(eventName, handler);
    }
  };
}
