import { Platform } from "../../platform/index.js";
import { TizenEngineFsService } from "../../platform/tizen/tizenEngineFsService.js";
import {
  AmbilightSettingsStore,
  getBulbMaxBrightness,
  getBulbPosition,
  AMBILIGHT_STRIP_STARTS
} from "../../data/local/ambilightSettingsStore.js";

// Drives the ambilight that lives in the Tizen EngineFS service
// (services/tizen/runtime/ambilight.cjs): the service captures the screen and
// sends colours to the bulbs; the app only says when, which bulb follows which
// part of the picture, and keeps the session alive while the player is open.
const PING_INTERVAL_MS = 3000; // the service stops on its own after 10 s without a ping
const REQUEST_TIMEOUT_MS = 4000;

let pingTimer = null;
let sessionToken = 0;
let activeBaseUrl = "";
let starting = false;

async function request(baseUrl, pathAndQuery) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${pathAndQuery}`, {
      cache: "no-cache",
      signal: controller?.signal
    });
    if (!response.ok) {
      throw new Error(`Ambilight request failed with HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function ensureService() {
  if (!Platform.isTizen()) {
    throw new Error("Ambilight needs the Samsung TV build");
  }
  const result = await TizenEngineFsService.ensureStarted({ purpose: "ambilight" });
  if (result?.status !== "success" || !result.baseUrl) {
    throw new Error(result?.detail || "The TV service did not start");
  }
  return result.baseUrl;
}

export function buildAssignQuery(settings) {
  return settings.bulbs
    .map(
      (bulb) =>
        `${encodeURIComponent(bulb.id)}:${getBulbPosition(settings, bulb)}:${getBulbMaxBrightness(settings, bulb)}`
    )
    .join(",");
}

// Extra start parameters when the surround strip is on ("" otherwise).
export function buildStripQuery(settings) {
  const strip = settings.strip;
  if (!strip?.enabled) {
    return "";
  }
  const start = Math.max(0, AMBILIGHT_STRIP_STARTS.indexOf(strip.start));
  return `&strip=on&stripStart=${start}&stripDir=${strip.clockwise ? "cw" : "ccw"}&stripBright=${strip.level}`;
}

function startUrl(settings) {
  return `/ambilight/start?level=${settings.level}&assign=${encodeURIComponent(buildAssignQuery(settings))}${buildStripQuery(settings)}`;
}

function clearPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

export const AmbilightController = {
  isAvailable() {
    return Platform.isTizen();
  },

  // Asks the TV service which bulbs were packaged and remembers them for the settings screen.
  async refreshBulbs() {
    const baseUrl = await ensureService();
    const body = await request(baseUrl, "/ambilight/bulbs");
    return AmbilightSettingsStore.setBulbs(Array.isArray(body?.bulbs) ? body.bulbs : []).bulbs;
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
    const problem = strip.errors?.length ? ` Last problem: ${strip.errors[strip.errors.length - 1]}` : "";
    return `Sending ${strip.method} to ${strip.ip}: ${strip.sent} frames, ${counted}.${problem}`;
  },

  // Called whenever the player reports real playback; repeated calls are cheap.
  async start() {
    const settings = AmbilightSettingsStore.get();
    if (!settings.enabled || !Platform.isTizen() || pingTimer || starting) {
      return;
    }
    const token = ++sessionToken;
    starting = true;
    try {
      const baseUrl = await ensureService();
      let current = AmbilightSettingsStore.get();
      if (!current.bulbs.length) {
        await this.refreshBulbs();
        current = AmbilightSettingsStore.get();
      }
      if (token !== sessionToken || !current.enabled) {
        return;
      }
      await request(baseUrl, startUrl(current));
      if (token !== sessionToken) {
        request(baseUrl, "/ambilight/stop").catch(() => {});
        return;
      }
      activeBaseUrl = baseUrl;
      clearPing();
      pingTimer = setInterval(() => {
        request(baseUrl, "/ambilight/ping").catch(() => {});
      }, PING_INTERVAL_MS);
    } catch (error) {
      console.warn("Ambilight could not start", error?.message || error);
    } finally {
      starting = false;
    }
  },

  isActive() {
    return Boolean(activeBaseUrl);
  },

  // Saves the overall brightness cap and applies it to the running lights at once.
  setLevel(level) {
    const settings = AmbilightSettingsStore.setLevel(level);
    if (activeBaseUrl) {
      request(activeBaseUrl, `/ambilight/level?value=${settings.level}`).catch(() => {});
    }
    return settings.level;
  },

  // Re-sends positions and per-bulb caps to a running session (settings changed mid-playback).
  applySettings() {
    const settings = AmbilightSettingsStore.get();
    if (activeBaseUrl && settings.enabled) {
      request(activeBaseUrl, startUrl(settings)).catch(() => {});
    }
  },

  stop() {
    sessionToken += 1;
    clearPing();
    const baseUrl = activeBaseUrl;
    activeBaseUrl = "";
    if (baseUrl) {
      request(baseUrl, "/ambilight/stop").catch(() => {});
    }
  }
};
