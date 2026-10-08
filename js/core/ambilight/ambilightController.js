import { Platform } from "../../platform/index.js";
import { TizenEngineFsService } from "../../platform/tizen/tizenEngineFsService.js";
import {
  AmbilightSettingsStore,
  getBulbMaxBrightness,
  getBulbPosition,
  getStripLayout,
  AMBILIGHT_STRIP_STARTS
} from "../../data/local/ambilightSettingsStore.js";

// Drives the ambilight that lives in the Tizen EngineFS service (services/tizen/runtime/ambilight.cjs).
// The service turns frames into zone colours and sends them to the Tuya bulbs and the DDP strip; the
// app says when (start, pause, resume, blackout, stop), with which configuration (all of it from
// ambilightSettingsStore.js, sent with every start/config request), and keeps the session alive
// while the player is open. The service also stops by itself 10 s after the last ping.
//
// Frames come from a zone source. Without one attached, the service captures the screen itself
// (today's path). A native source (e.g. a Pepper/NaCl module that decodes the video and reduces each
// fresh frame to 8 zone colours) plugs in with attachZoneSource(); its zones are forwarded to the
// service, which then stops capturing.
//
// Playback always wins: every public method swallows its own failures and never throws or rejects.

/**
 * One fresh decoded frame reduced to the strip's zones.
 * @typedef {Object} AmbilightZoneFrame
 * @property {Array<Array<number>>} zones 8 entries of [r, g, b], sRGB 0..255, in the service's
 *   STRIP_ZONES order: top-left, top, top-right, right, bottom-right, bottom, bottom-left, left
 *   (each the edge stripe of the picture next to that part of the strip, black bars excluded).
 * @property {number} frameId increases with every decoded frame; a frame with an id that is not
 *   higher than the last one seen is stale and dropped.
 * @property {number} ptsMs presentation timestamp of the frame, in milliseconds.
 */

/**
 * A source of zone frames. It emits one frame per fresh decoded frame (not per display refresh) and
 * may emit identical zones; the controller and the service suppress repeats.
 * @typedef {Object} AmbilightZoneSource
 * @property {string} [id] name for diagnostics.
 * @property {(listener: (frame: AmbilightZoneFrame) => void) => (() => void)} subscribe registers a
 *   listener and returns the function that removes it.
 */

const PING_INTERVAL_MS = 3000; // the service stops on its own after 10 s without a ping
const PAUSE_DELAY_MS = 700; // longer than a seek or a short buffering pause
const REQUEST_TIMEOUT_MS = 4000;
export const AMBILIGHT_ZONE_COUNT = 8;

export function buildAssignQuery(settings) {
  return settings.bulbs
    .map(
      (bulb) =>
        `${encodeURIComponent(bulb.id)}:${getBulbPosition(settings, bulb)}:${getBulbMaxBrightness(settings, bulb)}`
    )
    .join(",");
}

// Strip part of a start/config request: everything the service needs to drive the strip.
export function buildStripQuery(settings) {
  const strip = settings.strip;
  if (!strip?.enabled) {
    return "&strip=off";
  }
  const start = Math.max(0, AMBILIGHT_STRIP_STARTS.indexOf(strip.start));
  return (
    `&strip=on&stripIp=${encodeURIComponent(strip.ip)}&ddpPort=${strip.port}` +
    `&stripStart=${start}&stripDir=${strip.clockwise ? "cw" : "ccw"}&stripBright=${strip.level}` +
    `&stripSat=${strip.saturation}&stripSmooth=${strip.smoothing}&zones=${getStripLayout(settings).zones}`
  );
}

// The whole configuration as one query string (start and config requests carry the same).
export function buildConfigQuery(settings, { external = false } = {}) {
  return (
    `level=${settings.level}&assign=${encodeURIComponent(buildAssignQuery(settings))}` +
    `&pause=${settings.blackoutOnPause ? "black" : "hold"}&source=${external ? "external" : "capture"}` +
    buildStripQuery(settings)
  );
}

function channel(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(255, Math.max(0, number)) : 0;
}

// A source frame -> { hex, frameId, ptsMs }, or null when it is not a usable frame.
export function normalizeZoneFrame(frame) {
  const zones = frame?.zones;
  if (!Array.isArray(zones) || zones.length !== AMBILIGHT_ZONE_COUNT) {
    return null;
  }
  let hex = "";
  for (const zone of zones) {
    if (!Array.isArray(zone) || zone.length < 3) {
      return null;
    }
    for (let k = 0; k < 3; k += 1) {
      hex += `0${channel(zone[k]).toString(16)}`.slice(-2); // no padStart on Chromium 56
    }
  }
  const frameId = Number(frame.frameId);
  const ptsMs = Number(frame.ptsMs);
  return {
    hex,
    frameId: Number.isFinite(frameId) ? frameId : null,
    ptsMs: Number.isFinite(ptsMs) ? Math.round(ptsMs) : 0
  };
}

async function defaultEnsureService() {
  if (!Platform.isTizen()) {
    throw new Error("Ambilight needs the Samsung TV build");
  }
  const result = await TizenEngineFsService.ensureStarted({ purpose: "ambilight" });
  if (result?.status !== "success" || !result.baseUrl) {
    throw new Error(result?.detail || "The TV service did not start");
  }
  return result.baseUrl;
}

function warn(log, message, error) {
  try {
    log?.warn?.(message, error?.message || error);
  } catch (_) {
    // logging must not fail either
  }
}

/**
 * Builds a controller. The app uses the default instance (AmbilightController); tests pass fakes.
 * @param {Object} [deps]
 * @param {Function} [deps.fetchImpl] fetch(url, init) -> Response-like { ok, status, json() }
 * @param {Function} [deps.isTizen] () => boolean
 * @param {Function} [deps.ensureService] () => Promise<string> base URL of the TV service
 * @param {Object} [deps.store] AmbilightSettingsStore-like
 * @param {Object} [deps.win] window-like (addEventListener) for pagehide/beforeunload
 * @param {Object} [deps.doc] document-like (addEventListener, visibilityState) for visibility
 * @param {Object} [deps.nav] navigator-like (sendBeacon) for requests while the page goes away
 * @param {number} [deps.pingIntervalMs]
 * @param {number} [deps.pauseDelayMs] how long a pause must last before the lights react
 */
export function createAmbilightController(deps = {}) {
  const fetchImpl = deps.fetchImpl || ((url, init) => fetch(url, init));
  const isTizen = deps.isTizen || (() => Platform.isTizen());
  const ensureService = deps.ensureService || defaultEnsureService;
  const store = deps.store || AmbilightSettingsStore;
  const win = deps.win !== undefined ? deps.win : typeof window !== "undefined" ? window : null;
  const doc = deps.doc !== undefined ? deps.doc : typeof document !== "undefined" ? document : null;
  const nav =
    deps.nav !== undefined ? deps.nav : typeof navigator !== "undefined" ? navigator : null;
  const log = deps.log !== undefined ? deps.log : console;
  const pingIntervalMs = deps.pingIntervalMs || PING_INTERVAL_MS;
  // A seek or a short buffering hiccup fires a pause that is undone a moment later; only a pause
  // that lasts this long darkens or holds the lights.
  const pauseDelayMs = deps.pauseDelayMs !== undefined ? deps.pauseDelayMs : PAUSE_DELAY_MS;
  let pauseTimer = null;
  const cancelPendingPause = () => {
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
  };

  const state = {
    phase: "idle", // idle | starting | active
    token: 0,
    baseUrl: "",
    pingTimer: null,
    startPromise: null,
    playerPaused: false,
    dark: false, // blackout() (playback error) until resume()/start()
    hidden: false, // app hidden or in the background
    sent: "", // what the service was last told: run | pause | dark
    chain: Promise.resolve(),
    lifecycleBound: false,
    source: null,
    unsubscribe: null,
    zoneSeq: 0,
    lastFrameId: null,
    lastZoneHex: "",
    zoneInFlight: false,
    zonePending: null
  };

  async function request(baseUrl, pathAndQuery) {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => abort?.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${baseUrl}${pathAndQuery}`, {
        cache: "no-cache",
        signal: abort?.signal
      });
      if (!response?.ok) {
        throw new Error(`Ambilight request failed with HTTP ${response?.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Control requests go out one after another, so a pause never overtakes the resume before it.
  function enqueue(pathAndQuery, onResult) {
    const baseUrl = state.baseUrl;
    if (!baseUrl) {
      return state.chain;
    }
    state.chain = state.chain
      .then(() => request(baseUrl, pathAndQuery))
      .then((body) => {
        if (onResult) onResult(body);
      })
      .catch((error) => warn(log, `Ambilight ${pathAndQuery.split("?")[0]} failed`, error));
    return state.chain;
  }

  function desired() {
    if (state.hidden || state.dark) return "dark";
    return state.playerPaused ? "pause" : "run";
  }

  // The service lost the session (watchdog after a long background, service restart): start again
  // when the lights are wanted, otherwise just forget it.
  function onSessionGone() {
    if (state.phase !== "active") return;
    clearPing();
    state.phase = "idle";
    state.baseUrl = "";
    state.sent = "";
    if (desired() === "run") {
      void controller.start();
    }
  }

  function checkActive(body) {
    if (body && body.active === false) {
      onSessionGone();
    }
  }

  // Tells the service what it should be doing now, if that changed.
  function sync() {
    if (state.phase !== "active") return;
    const want = desired();
    if (want === state.sent) return;
    state.sent = want;
    if (want === "run") {
      enqueue("/ambilight/resume", checkActive);
    } else if (want === "dark") {
      enqueue("/ambilight/blackout");
    } else {
      enqueue(`/ambilight/pause?mode=${store.get().blackoutOnPause ? "black" : "hold"}`);
    }
  }

  function clearPing() {
    if (state.pingTimer) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
  }

  // Requests while the page goes away: sendBeacon survives unload where fetch may not.
  function sendNow(pathAndQuery) {
    const url = `${state.baseUrl}${pathAndQuery}`;
    try {
      if (typeof nav?.sendBeacon === "function" && nav.sendBeacon(url)) {
        return;
      }
    } catch (_) {
      // fall back to fetch
    }
    try {
      Promise.resolve(fetchImpl(url, { cache: "no-cache", keepalive: true })).catch(() => {});
    } catch (_) {
      // best effort; the service watchdog stops the lights anyway
    }
  }

  function isDocumentHidden() {
    return doc?.visibilityState === "hidden" || doc?.webkitHidden === true;
  }

  function bindLifecycle() {
    if (state.lifecycleBound) return;
    state.lifecycleBound = true;
    const onVisibility = () => {
      try {
        state.hidden = isDocumentHidden();
        sync();
      } catch (error) {
        warn(log, "Ambilight visibility handling failed", error);
      }
    };
    const onExit = () => {
      try {
        if (state.phase !== "idle" && state.baseUrl) {
          sendNow("/ambilight/stop");
        }
        resetSession();
      } catch (error) {
        warn(log, "Ambilight exit handling failed", error);
      }
    };
    try {
      doc?.addEventListener?.("visibilitychange", onVisibility);
      doc?.addEventListener?.("webkitvisibilitychange", onVisibility);
      doc?.addEventListener?.("nuvio:beforeExitApp", onExit);
      win?.addEventListener?.("pagehide", onExit);
      win?.addEventListener?.("beforeunload", onExit);
      win?.addEventListener?.("unload", onExit);
    } catch (error) {
      warn(log, "Ambilight could not watch the app lifecycle", error);
    }
  }

  function resetSession() {
    state.token += 1;
    clearPing();
    state.phase = "idle";
    state.baseUrl = "";
    state.sent = "";
    state.playerPaused = false;
    state.dark = false;
    state.lastFrameId = null;
    state.lastZoneHex = "";
    state.zonePending = null;
  }

  // ---- zone source ---------------------------------------------------------------------------------
  function sendZones(frame) {
    state.zoneInFlight = true;
    state.zoneSeq += 1;
    const baseUrl = state.baseUrl;
    request(baseUrl, `/ambilight/zones?z=${frame.hex}&frame=${state.zoneSeq}&pts=${frame.ptsMs}`)
      .catch(() => {})
      .then(() => {
        state.zoneInFlight = false;
        const next = state.zonePending;
        state.zonePending = null;
        if (next && state.phase === "active" && desired() === "run") {
          sendZones(next);
        }
      });
  }

  // Only the newest frame matters: while one request is out, a newer frame replaces the waiting one.
  function onZoneFrame(raw) {
    try {
      if (state.phase !== "active" || desired() !== "run" || !state.baseUrl) return;
      const frame = normalizeZoneFrame(raw);
      if (!frame) return;
      if (frame.frameId !== null) {
        if (state.lastFrameId !== null && frame.frameId <= state.lastFrameId) return; // stale
        state.lastFrameId = frame.frameId;
      }
      if (frame.hex === state.lastZoneHex) return; // unchanged: the service keeps the strip alive
      state.lastZoneHex = frame.hex;
      if (state.zoneInFlight) {
        state.zonePending = frame;
        return;
      }
      sendZones(frame);
    } catch (error) {
      warn(log, "Ambilight zone frame dropped", error);
    }
  }

  const controller = {
    isAvailable() {
      try {
        return Boolean(isTizen());
      } catch (_) {
        return false;
      }
    },

    // Asks the TV service which bulbs were packaged and remembers them for the settings screen.
    async refreshBulbs() {
      const baseUrl = await ensureService();
      const body = await request(baseUrl, "/ambilight/bulbs");
      return store.setBulbs(Array.isArray(body?.bulbs) ? body.bulbs : []).bulbs;
    },

    // One line about the strip for the settings screen, from the TV service's own state.
    async describeStrip() {
      const baseUrl = await ensureService();
      const body = await request(baseUrl, "/ambilight/state");
      const strip = body?.state?.strip;
      if (!body?.active || !strip) {
        return "Not running. Play a video with the strip switched on, then check again.";
      }
      const counted = strip.health?.available
        ? `strip counted ${strip.health.moved ?? "?"} packets in the last check`
        : strip.health?.error || "no packet count from the strip yet";
      const problem = strip.errors?.length
        ? ` Last problem: ${strip.errors[strip.errors.length - 1]}`
        : "";
      return `Sending ${strip.method} to ${strip.ip}:${strip.port}: ${strip.sent} frames, ${counted}.${problem}`;
    },

    /**
     * Called whenever the player reports real playback; repeated calls are cheap. A paused or
     * blacked-out session resumes. Resolves true when the lights run, never rejects.
     * @param {{ zoneSource?: AmbilightZoneSource }} [options]
     */
    async start(options = {}) {
      cancelPendingPause();
      try {
        if (options?.zoneSource) {
          controller.attachZoneSource(options.zoneSource);
        }
        const settings = store.get();
        if (!settings.enabled || !isTizen()) {
          return false;
        }
        bindLifecycle();
        state.hidden = isDocumentHidden();
        state.playerPaused = false;
        state.dark = false;
        if (state.phase === "active") {
          sync();
          return true;
        }
        if (state.phase === "starting") {
          return await state.startPromise;
        }
        state.phase = "starting";
        const token = ++state.token;
        state.startPromise = (async () => {
          try {
            const baseUrl = await ensureService();
            let current = store.get();
            if (!current.bulbs.length) {
              const body = await request(baseUrl, "/ambilight/bulbs");
              current = store.setBulbs(Array.isArray(body?.bulbs) ? body.bulbs : []);
            }
            if (token !== state.token || !current.enabled) {
              return false;
            }
            await request(
              baseUrl,
              `/ambilight/start?${buildConfigQuery(current, { external: Boolean(state.source) })}`
            );
            if (token !== state.token) {
              request(baseUrl, "/ambilight/stop").catch(() => {});
              return false;
            }
            state.baseUrl = baseUrl;
            state.phase = "active";
            state.sent = "run";
            clearPing();
            state.pingTimer = setInterval(() => {
              request(baseUrl, "/ambilight/ping")
                .then(checkActive)
                .catch(() => {});
            }, pingIntervalMs);
            sync(); // paused, hidden or blacked out while starting
            return true;
          } catch (error) {
            if (token === state.token) {
              state.phase = "idle";
            }
            warn(log, "Ambilight could not start", error);
            return false;
          }
        })();
        return await state.startPromise;
      } catch (error) {
        warn(log, "Ambilight could not start", error);
        return false;
      }
    },

    // Player paused: dark or hold the last colour, as the blackoutOnPause setting says.
    pause() {
      const apply = () => {
        try {
          pauseTimer = null;
          state.playerPaused = true;
          sync();
        } catch (error) {
          warn(log, "Ambilight pause failed", error);
        }
      };
      cancelPendingPause();
      if (pauseDelayMs > 0) {
        pauseTimer = setTimeout(apply, pauseDelayMs);
      } else {
        apply();
      }
    },

    // Player playing again (also lifts a blackout).
    resume() {
      cancelPendingPause();
      try {
        state.playerPaused = false;
        state.dark = false;
        sync();
      } catch (error) {
        warn(log, "Ambilight resume failed", error);
      }
    },

    // Dark now (playback error): strip black, bulbs restored, until resume() or start().
    blackout() {
      try {
        state.dark = true;
        sync();
      } catch (error) {
        warn(log, "Ambilight blackout failed", error);
      }
    },

    stop() {
      cancelPendingPause();
      try {
        const baseUrl = state.baseUrl;
        resetSession();
        if (baseUrl) {
          request(baseUrl, "/ambilight/stop").catch(() => {});
        }
      } catch (error) {
        warn(log, "Ambilight stop failed", error);
      }
    },

    isActive() {
      return state.phase === "active";
    },

    isPaused() {
      return state.phase === "active" && desired() !== "run";
    },

    // Saves the overall brightness cap and applies it to the running lights at once.
    setLevel(level) {
      try {
        const settings = store.setLevel(level);
        if (state.phase === "active") {
          enqueue(`/ambilight/level?value=${settings.level}`);
        }
        return settings.level;
      } catch (error) {
        warn(log, "Ambilight level change failed", error);
        return level;
      }
    },

    /**
     * Saves a partial configuration (top level, `strip` merged) and applies the whole configuration
     * to a running session live, without restarting it. Returns the saved settings.
     */
    updateConfig(partial) {
      try {
        if (partial && typeof partial === "object") {
          const current = store.get();
          store.set({ ...partial, strip: { ...current.strip, ...(partial.strip || {}) } });
        }
        const settings = store.get();
        if (!settings.enabled) {
          if (state.phase !== "idle") controller.stop();
          return settings;
        }
        if (state.phase === "active") {
          enqueue(
            `/ambilight/config?${buildConfigQuery(settings, { external: Boolean(state.source) })}`,
            checkActive
          );
          if (state.sent === "pause") {
            state.sent = ""; // blackoutOnPause may have changed: say pause again with the new mode
            sync();
          }
        }
        return settings;
      } catch (error) {
        warn(log, "Ambilight config change failed", error);
        return store.get();
      }
    },

    // Settings changed somewhere else (settings screen): send them to a running session.
    applySettings() {
      return controller.updateConfig();
    },

    /**
     * Feeds zones from a frame source (see AmbilightZoneSource) instead of the service's screen
     * capture. Replaces an attached source. Returns true when attached.
     * @param {AmbilightZoneSource} source
     */
    attachZoneSource(source) {
      try {
        if (!source || typeof source.subscribe !== "function") return false;
        controller.detachZoneSource({ silent: true });
        state.source = source;
        state.lastFrameId = null;
        state.lastZoneHex = "";
        const unsubscribe = source.subscribe(onZoneFrame);
        state.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;
        if (state.phase === "active") enqueue("/ambilight/config?source=external");
        return true;
      } catch (error) {
        warn(log, "Ambilight zone source not attached", error);
        state.source = null;
        return false;
      }
    },

    // Back to the service's own screen capture.
    detachZoneSource({ silent = false } = {}) {
      try {
        const hadSource = Boolean(state.source);
        const unsubscribe = state.unsubscribe;
        state.source = null;
        state.unsubscribe = null;
        state.zonePending = null;
        if (unsubscribe) unsubscribe();
        if (hadSource && !silent && state.phase === "active")
          enqueue("/ambilight/config?source=capture");
      } catch (error) {
        warn(log, "Ambilight zone source not detached cleanly", error);
      }
    },

    // Resolves when the queued control requests are done (tests and diagnostics).
    whenSettled() {
      return state.chain;
    }
  };
  return controller;
}

export const AmbilightController = createAmbilightController();
