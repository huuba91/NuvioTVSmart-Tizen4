import { LocalStore } from "../../core/storage/localStore.js";

// Ambilight preferences belong to this TV and its bulbs, not to a profile.
const KEY = "ambilightSettings";

export const AMBILIGHT_POSITIONS = ["left", "center", "right", "off"];
// Brightness caps in percent: the overall one (player slider and settings) and one per bulb.
export const AMBILIGHT_LEVEL_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
export const AMBILIGHT_LEVEL_STEP = 10;

export const AMBILIGHT_SETTINGS_DEFAULTS = {
  enabled: false,
  level: 100,
  // bulb id -> left | center | right | off; missing ids use the bulb's packaged default
  positions: {},
  // bulb id -> its own brightness cap; missing ids use 100
  maxBrightness: {},
  // last bulb list reported by the TV service: [{ id, name, pos }] (never keys)
  bulbs: []
};

function normalizePosition(value) {
  const text = String(value || "").toLowerCase();
  return AMBILIGHT_POSITIONS.includes(text) ? text : "";
}

function normalizeLevel(value) {
  const level = Math.round(Number(value) / AMBILIGHT_LEVEL_STEP) * AMBILIGHT_LEVEL_STEP;
  return AMBILIGHT_LEVEL_OPTIONS.includes(level) ? level : 0;
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

export function normalizeAmbilightSettings(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const positions = {};
  const maxBrightness = {};
  Object.entries(
    source.positions && typeof source.positions === "object" ? source.positions : {}
  ).forEach(([id, pos]) => {
    const normalized = normalizePosition(pos);
    if (id && normalized) {
      positions[id] = normalized;
    }
  });
  Object.entries(
    source.maxBrightness && typeof source.maxBrightness === "object" ? source.maxBrightness : {}
  ).forEach(([id, max]) => {
    const normalized = normalizeLevel(max);
    if (id && normalized && normalized < 100) {
      maxBrightness[id] = normalized;
    }
  });
  return {
    enabled: Boolean(source.enabled),
    level: normalizeLevel(source.level) || AMBILIGHT_SETTINGS_DEFAULTS.level,
    positions,
    maxBrightness,
    bulbs: normalizeBulbs(source.bulbs)
  };
}

export function getBulbPosition(settings, bulb) {
  return settings.positions[bulb.id] || bulb.pos || "center";
}

export function getBulbMaxBrightness(settings, bulb) {
  return settings.maxBrightness[bulb.id] || 100;
}

export const AmbilightSettingsStore = {
  get() {
    return normalizeAmbilightSettings(LocalStore.get(KEY, AMBILIGHT_SETTINGS_DEFAULTS));
  },

  set(partial) {
    const next = normalizeAmbilightSettings({ ...this.get(), ...(partial || {}) });
    LocalStore.set(KEY, next);
    return next;
  },

  setEnabled(enabled) {
    return this.set({ enabled: Boolean(enabled) });
  },

  setLevel(level) {
    return this.set({ level: Number(level) });
  },

  setBulbPosition(bulbId, position) {
    const current = this.get();
    return this.set({ positions: { ...current.positions, [String(bulbId)]: position } });
  },

  setBulbMaxBrightness(bulbId, max) {
    const current = this.get();
    return this.set({ maxBrightness: { ...current.maxBrightness, [String(bulbId)]: max } });
  },

  setBulbs(bulbs) {
    return this.set({ bulbs });
  }
};
