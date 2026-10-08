// Backend-neutral player interface.
//
// A backend is the thing that actually owns picture, audio and subtitles for
// one playback: Samsung AVPlay ("tizen-avplay") or the HTML5 <video> element
// fed directly ("native-file", "native-hls", "native-dash") or through MSE
// ("hls.js", "dash.js"). PlayerController stays the single orchestrator
// (engine ladder, proxies, fallbacks, progress); backends are thin adapters
// over its existing per-engine methods so the UI can talk to "the player"
// without knowing which engine is active.
//
// Future analysis-only modules (Pepper/NaCl ambilight decoders) are NOT
// backends: they never own picture/audio/subtitles. See
// docs/player-architecture.md.

/**
 * Events every backend (and PlayerController.on/off) emits, whatever engine
 * is active. Payload: { type, engine, backend, detail }.
 *
 * loading   a new source load started (PlayerController.play())
 * ready     enough data to start (canplay)
 * playing   frames are advancing
 * paused    playback paused
 * seeking   a seek started
 * seeked    a seek finished
 * timeupdate  position advanced (AVPlay: once per second from the tick timer)
 * buffering playback waits for data (waiting)
 * ended     natural end of media
 * error     playback error (detail carries mediaErrorCode / engine diagnostics)
 * tracks    audio/subtitle track list changed or became known
 */
export const PLAYER_BACKEND_EVENTS = Object.freeze([
  "loading",
  "ready",
  "playing",
  "paused",
  "seeking",
  "seeked",
  "timeupdate",
  "buffering",
  "ended",
  "error",
  "tracks"
]);

/**
 * Media-element / synthetic event names (as dispatched on <video id="videoPlayer">
 * by the browser or by PlayerController.emitVideoEvent) mapped to the neutral
 * event names above. AVPlay and hls.js/dash.js already report through
 * emitVideoEvent on the same element, so one bridge covers every engine.
 */
export const MEDIA_EVENT_TO_BACKEND_EVENT = Object.freeze({
  canplay: "ready",
  playing: "playing",
  pause: "paused",
  seeking: "seeking",
  seeked: "seeked",
  timeupdate: "timeupdate",
  waiting: "buffering",
  ended: "ended",
  error: "error",
  loadedmetadata: "tracks",
  avplaytrackschanged: "tracks",
  hlstrackschanged: "tracks",
  dashtrackschanged: "tracks"
});

/**
 * @typedef {object} BufferedRange
 * @property {number} start  seconds
 * @property {number} end    seconds
 */

/**
 * @typedef {object} PlayerBackend
 * @property {string} name                 "avplay" | "html5"
 * @property {string} engine               engine name as used by the engine ladder
 * @property {(url: string, options?: object) => Promise<void>} load
 *           Load and start `url` on this backend's engine (PlayerController.play with forceEngine).
 * @property {() => void} play             resume playback
 * @property {() => void} pause
 * @property {(options?: object) => Promise<boolean>|void} stop
 * @property {(seconds: number) => boolean} seek
 * @property {(level: number) => boolean} setVolume   0..1; false when the engine has no app-level volume
 * @property {() => number|null} getVolume
 * @property {() => number} getDuration    seconds (0 when unknown)
 * @property {() => number} getCurrentTime seconds
 * @property {() => BufferedRange[]} getBufferedRanges
 * @property {() => boolean} isPaused
 * @property {() => boolean} isSeeking
 * @property {() => boolean} isEnded
 * @property {() => number} getReadyState  HTMLMediaElement-style 0..4
 * @property {() => object[]} getAudioTracks
 * @property {(index: number) => boolean} selectAudioTrack
 * @property {() => object[]} getSubtitleTracks
 * @property {(index: number) => boolean} selectSubtitleTrack
 * @property {(event: string, handler: Function) => void} on
 * @property {(event: string, handler: Function) => void} off
 */

export const PLAYER_BACKEND_METHODS = Object.freeze([
  "load",
  "play",
  "pause",
  "stop",
  "seek",
  "setVolume",
  "getVolume",
  "getDuration",
  "getCurrentTime",
  "getBufferedRanges",
  "isPaused",
  "isSeeking",
  "isEnded",
  "getReadyState",
  "getAudioTracks",
  "selectAudioTrack",
  "getSubtitleTracks",
  "selectSubtitleTrack",
  "on",
  "off"
]);

/** True when `backend` implements every PlayerBackend method. */
export function isPlayerBackend(backend) {
  return (
    Boolean(backend) &&
    PLAYER_BACKEND_METHODS.every((method) => typeof backend[method] === "function")
  );
}

/** Reads a TimeRanges-like object into plain {start, end} pairs; never throws. */
export function timeRangesToArray(ranges) {
  const result = [];
  try {
    const count = Number(ranges?.length || 0);
    for (let index = 0; index < count; index += 1) {
      const start = Number(ranges.start(index));
      const end = Number(ranges.end(index));
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        result.push({ start, end });
      }
    }
  } catch (_) {
    // TimeRanges can change while it is being read on older TV engines.
  }
  return result;
}

/**
 * Small synchronous event emitter used by PlayerController.on/off. A failing
 * handler is reported once on the console and never stops other handlers or
 * the playback code that emitted the event.
 */
export function createPlayerEventEmitter() {
  const handlers = new Map();
  return {
    on(eventName, handler) {
      const name = String(eventName || "");
      if (!name || typeof handler !== "function") {
        return;
      }
      if (!handlers.has(name)) {
        handlers.set(name, []);
      }
      const list = handlers.get(name);
      if (!list.includes(handler)) {
        list.push(handler);
      }
    },
    off(eventName, handler) {
      const list = handlers.get(String(eventName || ""));
      if (!list) {
        return;
      }
      const index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
    },
    emit(eventName, payload) {
      const list = handlers.get(String(eventName || ""));
      if (!list || !list.length) {
        return;
      }
      list.slice().forEach((handler) => {
        try {
          handler(payload);
        } catch (error) {
          console.warn(`Player event handler failed (${eventName}):`, error?.message || error);
        }
      });
    },
    count(eventName) {
      return (handlers.get(String(eventName || "")) || []).length;
    }
  };
}
