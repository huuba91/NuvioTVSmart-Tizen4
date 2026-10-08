// AVPlay backend adapter (Samsung webapis.avplay, engine "tizen-avplay").
//
// Thin adapter over PlayerController's existing AVPlay methods: it adds no
// AVPlay logic of its own. AVPlay renders on the native video plane (the
// <object id="avPlayerObject">), owns audio and subtitles, and reports state
// through PlayerController (avplayReady, avplayEnded, avplaySeekInFlight, the
// tick timer) and synthetic events on the <video> element.

/**
 * @param {object} controller PlayerController (or a compatible object)
 * @returns {import("./playerBackend.js").PlayerBackend}
 */
export function createAvplayBackend(controller) {
  const engineName = () => String(controller.getPlatformAvplayEngineName?.() || "tizen-avplay");
  return {
    name: "avplay",
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
    // AVPlay output level is the TV's system volume; the app has no per-player
    // volume. Startup muting is handled by PlayerController's audio gate.
    setVolume() {
      return false;
    },
    getVolume() {
      return null;
    },
    getDuration() {
      return Number(controller.getDurationSeconds() || 0);
    },
    getCurrentTime() {
      return Number(controller.getCurrentTimeSeconds() || 0);
    },
    // AVPlay only reports buffering-operation progress, not buffered media
    // time; returning no ranges keeps the UI from presenting it as playable time.
    getBufferedRanges() {
      return [];
    },
    isPaused() {
      return controller.getAvPlayState?.() === "PAUSED";
    },
    isSeeking() {
      return Boolean(controller.avplaySeekInFlight);
    },
    isEnded() {
      return Boolean(controller.isPlaybackEnded());
    },
    getReadyState() {
      return Number(controller.getPlaybackReadyState() || 0);
    },
    getAudioTracks() {
      return controller.getAvPlayAudioTracks();
    },
    selectAudioTrack(index) {
      return Boolean(controller.setAvPlayAudioTrack(index));
    },
    getSubtitleTracks() {
      return controller.getAvPlaySubtitleTracks();
    },
    selectSubtitleTrack(index) {
      return Boolean(controller.setAvPlaySubtitleTrack(index));
    },
    on(eventName, handler) {
      controller.on(eventName, handler);
    },
    off(eventName, handler) {
      controller.off(eventName, handler);
    }
  };
}
