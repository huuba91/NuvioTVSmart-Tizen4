import { LocalStore } from "../../core/storage/localStore.js";

// Ambilight preferences belong to this TV and its bulbs, not to a profile.
const KEY = "ambilightSettings";

export const AMBILIGHT_POSITIONS = ["left", "center", "right", "off"];
export const AMBILIGHT_LEVEL_OPTIONS = [25, 50, 75, 100];

export const AMBILIGHT_SETTINGS_DEFAULTS = {
  enabled: false,
  level: 100,
  // bulb id -> left | center | right | off; missing ids use the bulb's packaged default
  positions: {},
  // last bulb list reported by the TV service: [{ id, name, pos }] (never keys)
  bulbs: []
};

function normalizePosition(value) {
  const text = String(value || "").toLowerCase();
  return AMBILIGHT_POSITIONS.includes(text) ? text : "";
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
  const level = Number(source.level);
  const positions = {};
  Object.entries(
    source.positions && typeof source.positions === "object" ? source.positions : {}
  ).forEach(([id, pos]) => {
    const normalized = normalizePosition(pos);
    if (id && normalized) {
      positions[id] = normalized;
    }
  });
  return {
    enabled: Boolean(source.enabled),
    level: AMBILIGHT_LEVEL_OPTIONS.includes(level) ? level : AMBILIGHT_SETTINGS_DEFAULTS.level,
    positions,
    bulbs: normalizeBulbs(source.bulbs)
  };
}

export function getBulbPosition(settings, bulb) {
  return settings.positions[bulb.id] || bulb.pos || "center";
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

  setBulbs(bulbs) {
    return this.set({ bulbs });
  }
};
