import { LocalStore } from "../../core/storage/localStore.js";

// The one place that holds the ambilight configuration. Defaults live here; the TV service
// (services/tizen/runtime/ambilight.cjs) receives everything with each start or config request and
// keeps no settings of its own. Ambilight preferences belong to this TV and its lights, not to a profile.
const KEY = "ambilightSettings";
// Version 1 had no version field and no strip address, port, saturation, smoothing, layout or
// pause behaviour; normalizing fills those in with the defaults below.
export const AMBILIGHT_SETTINGS_VERSION = 2;

export const AMBILIGHT_POSITIONS = ["left", "center", "right", "off"];
// Brightness caps in percent: the overall one (player slider and settings) and one per bulb.
export const AMBILIGHT_LEVEL_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
export const AMBILIGHT_LEVEL_STEP = 10;

// Surround strip behind the TV (8 segments, DDP): where its controller end sits, as the part of the
// picture that segment follows, and which way it runs from there.
export const AMBILIGHT_STRIP_STARTS = ["tl", "t", "tr", "r", "br", "b", "bl", "l"];
// Strip colour saturation in percent (130 = the PC strip_sync.py default).
export const AMBILIGHT_SATURATION_OPTIONS = [100, 115, 130, 150, 170];
// Strip smoothing: how slowly it follows the picture (the service maps these to its glide times).
export const AMBILIGHT_SMOOTHING_OPTIONS = ["low", "medium", "high"];
// Layout presets: zone count plus how the zones sit on the picture. Start segment and direction are
// separate settings. Only the 8-zone edge layout exists today.
export const AMBILIGHT_STRIP_LAYOUTS = [{ id: "edges-8", zones: 8 }];
export const AMBILIGHT_DEFAULT_STRIP_IP = "192.168.129.20";
export const AMBILIGHT_DEFAULT_DDP_PORT = 4048;

export const AMBILIGHT_STRIP_DEFAULTS = Object.freeze({
  enabled: false,
  start: "bl",
  clockwise: true,
  level: 60,
  ip: AMBILIGHT_DEFAULT_STRIP_IP,
  port: AMBILIGHT_DEFAULT_DDP_PORT,
  saturation: 130,
  smoothing: "medium",
  layout: "edges-8"
});

export const AMBILIGHT_SETTINGS_DEFAULTS = Object.freeze({
  version: AMBILIGHT_SETTINGS_VERSION,
  enabled: false,
  level: 100,
  // true: strip and bulbs go dark while the player is paused; false: they hold the last colour
  blackoutOnPause: true,
  // bulb id -> left | center | right | off; missing ids use the bulb's packaged default
  positions: {},
  // bulb id -> its own brightness cap; missing ids use 100
  maxBrightness: {},
  strip: AMBILIGHT_STRIP_DEFAULTS,
  // last bulb list reported by the TV service: [{ id, name, pos }] (never keys)
  bulbs: []
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePosition(value) {
  const text = String(value || "").toLowerCase();
  return AMBILIGHT_POSITIONS.includes(text) ? text : "";
}

function normalizeLevel(value) {
  const level = Math.round(Number(value) / AMBILIGHT_LEVEL_STEP) * AMBILIGHT_LEVEL_STEP;
  return AMBILIGHT_LEVEL_OPTIONS.includes(level) ? level : 0;
}

// Dotted IPv4 address, or "" when it is not one.
export function normalizeAmbilightIp(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return "";
  }
  const parts = text.split(".").map(Number);
  return parts.every((part) => part <= 255) ? parts.join(".") : "";
}

function normalizePort(value) {
  const port = Math.round(Number(value));
  return Number.isFinite(port) && port >= 1 && port <= 65535 ? port : AMBILIGHT_DEFAULT_DDP_PORT;
}

// Nearest of the offered steps, so an old or hand-edited value still lands on one of them.
function normalizeSaturation(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return AMBILIGHT_STRIP_DEFAULTS.saturation;
  }
  return AMBILIGHT_SATURATION_OPTIONS.reduce((best, option) =>
    Math.abs(option - number) < Math.abs(best - number) ? option : best
  );
}

function normalizeSmoothing(value) {
  const text = String(value || "").toLowerCase();
  return AMBILIGHT_SMOOTHING_OPTIONS.includes(text) ? text : AMBILIGHT_STRIP_DEFAULTS.smoothing;
}

function normalizeLayout(value) {
  const id = String(value || "");
  return AMBILIGHT_STRIP_LAYOUTS.some((layout) => layout.id === id)
    ? id
    : AMBILIGHT_STRIP_DEFAULTS.layout;
}

function normalizeBulbs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  return value
    .map((bulb) => ({
      id: String(bulb?.id || ""),
      name: String(bulb?.name || bulb?.id || ""),
      pos: normalizePosition(bulb?.pos) || "center"
    }))
    .filter((bulb) => bulb.id && !seen.has(bulb.id) && seen.add(bulb.id));
}

function normalizeStrip(value) {
  const source = isPlainObject(value) ? value : {};
  const start = String(source.start || "").toLowerCase();
  return {
    enabled: Boolean(source.enabled),
    start: AMBILIGHT_STRIP_STARTS.includes(start) ? start : AMBILIGHT_STRIP_DEFAULTS.start,
    clockwise:
      source.clockwise === undefined
        ? AMBILIGHT_STRIP_DEFAULTS.clockwise
        : Boolean(source.clockwise),
    level: normalizeLevel(source.level) || AMBILIGHT_STRIP_DEFAULTS.level,
    ip: normalizeAmbilightIp(source.ip) || AMBILIGHT_STRIP_DEFAULTS.ip,
    port: normalizePort(source.port),
    saturation: normalizeSaturation(source.saturation),
    smoothing: normalizeSmoothing(source.smoothing),
    layout: normalizeLayout(source.layout)
  };
}

// Any stored shape (version 1 included) -> the current one, with defaults for what is missing.
export function normalizeAmbilightSettings(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const positions = {};
  const maxBrightness = {};
  Object.entries(isPlainObject(source.positions) ? source.positions : {}).forEach(([id, pos]) => {
    const normalized = normalizePosition(pos);
    if (id && normalized) {
      positions[id] = normalized;
    }
  });
  Object.entries(isPlainObject(source.maxBrightness) ? source.maxBrightness : {}).forEach(
    ([id, max]) => {
      const normalized = normalizeLevel(max);
      if (id && normalized && normalized < 100) {
        maxBrightness[id] = normalized;
      }
    }
  );
  return {
    version: AMBILIGHT_SETTINGS_VERSION,
    enabled: Boolean(source.enabled),
    level: normalizeLevel(source.level) || AMBILIGHT_SETTINGS_DEFAULTS.level,
    blackoutOnPause:
      source.blackoutOnPause === undefined
        ? AMBILIGHT_SETTINGS_DEFAULTS.blackoutOnPause
        : Boolean(source.blackoutOnPause),
    positions,
    maxBrightness,
    strip: normalizeStrip(source.strip),
    bulbs: normalizeBulbs(source.bulbs)
  };
}

export function getBulbPosition(settings, bulb) {
  return settings.positions[bulb.id] || bulb.pos || "center";
}

export function getBulbMaxBrightness(settings, bulb) {
  return settings.maxBrightness[bulb.id] || 100;
}

export function getStripLayout(settings) {
  return (
    AMBILIGHT_STRIP_LAYOUTS.find((layout) => layout.id === settings?.strip?.layout) ||
    AMBILIGHT_STRIP_LAYOUTS[0]
  );
}

// Store over any key/value backend with LocalStore's get/set (tests pass an in-memory one).
export function createAmbilightSettingsStore(backend = LocalStore) {
  return {
    // Reads and, when the stored shape is older than this version, writes it back migrated.
    get() {
      const stored = backend.get(KEY, null);
      const settings = normalizeAmbilightSettings(stored || AMBILIGHT_SETTINGS_DEFAULTS);
      if (stored && stored.version !== AMBILIGHT_SETTINGS_VERSION) {
        backend.set(KEY, settings);
      }
      return settings;
    },

    set(partial) {
      const next = normalizeAmbilightSettings({ ...this.get(), ...(partial || {}) });
      backend.set(KEY, next);
      return next;
    },

    setEnabled(enabled) {
      return this.set({ enabled: Boolean(enabled) });
    },

    setLevel(level) {
      return this.set({ level: Number(level) });
    },

    setBlackoutOnPause(value) {
      return this.set({ blackoutOnPause: Boolean(value) });
    },

    setBulbPosition(bulbId, position) {
      const current = this.get();
      return this.set({ positions: { ...current.positions, [String(bulbId)]: position } });
    },

    setBulbMaxBrightness(bulbId, max) {
      const current = this.get();
      return this.set({ maxBrightness: { ...current.maxBrightness, [String(bulbId)]: max } });
    },

    setStrip(partial) {
      return this.set({ strip: { ...this.get().strip, ...(partial || {}) } });
    },

    setBulbs(bulbs) {
      return this.set({ bulbs });
    }
  };
}

export const AmbilightSettingsStore = createAmbilightSettingsStore();
