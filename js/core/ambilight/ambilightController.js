import { Platform } from "../../platform/index.js";
import { TizenEngineFsService } from "../../platform/tizen/tizenEngineFsService.js";
import {
  AmbilightSettingsStore,
  getBulbPosition
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
    .map((bulb) => `${encodeURIComponent(bulb.id)}:${getBulbPosition(settings, bulb)}`)
    .join(",");
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
      await request(
        baseUrl,
        `/ambilight/start?level=${current.level}&assign=${encodeURIComponent(buildAssignQuery(current))}`
      );
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
