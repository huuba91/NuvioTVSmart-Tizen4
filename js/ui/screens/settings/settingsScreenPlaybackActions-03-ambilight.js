import * as internals from "./settingsScreenContext.js";
import {
  AMBILIGHT_LEVEL_OPTIONS,
  AMBILIGHT_POSITIONS,
  AMBILIGHT_STRIP_STARTS,
  AmbilightSettingsStore,
  getBulbMaxBrightness,
  getBulbPosition
} from "../../../data/local/ambilightSettingsStore.js";
import { AmbilightController } from "../../../core/ambilight/ambilightController.js";
import { ambilightPositionLabel, ambilightStripStartLabel } from "./settingsScreenPlaybackMarkup-07-ambilight.js";

export function registerPlaybackAmbilightActions() {
  const { t } = internals;
  if (!AmbilightController.isAvailable()) {
    return;
  }

  const findBulbs = async () => {
    try {
      const bulbs = await AmbilightController.refreshBulbs();
      this.ambilightStatus = bulbs.length
        ? t("settings.playback.ambilight.find.found", { count: bulbs.length }, `${bulbs.length} bulb(s) found.`)
        : t("settings.playback.ambilight.find.none", {}, "No bulbs in this build. Run scripts/make-ambilight-bulbs.py and reinstall.");
    } catch (error) {
      this.ambilightStatus = t("settings.playback.ambilight.find.failed", {}, `Could not reach the TV service: ${error?.message || error}`);
    }
  };

  this.actionMap.set("playback:toggle:ambilight", () => {
    this.toggleExpandedSection("playback", "ambilight");
  });
  this.actionMap.set("playback:ambilightEnabled", async () => {
    const next = AmbilightSettingsStore.setEnabled(!AmbilightSettingsStore.get().enabled);
    if (!next.enabled) {
      AmbilightController.stop();
    } else if (!next.bulbs.length) {
      await findBulbs();
    }
  });
  this.actionMap.set("playback:ambilightLevel", () => {
    this.openOptionDialog({
      title: t("settings.playback.ambilight.level.title", {}, "Overall max brightness"),
      options: AMBILIGHT_LEVEL_OPTIONS.map((level) => ({ id: level, label: `${level}%` })),
      selectedId: AmbilightSettingsStore.get().level,
      returnFocusKey: "playback:ambilightLevel",
      onSelect: (option) => {
        AmbilightController.setLevel(Number(option.id));
      }
    });
  });
  this.actionMap.set("playback:ambilightRefresh", findBulbs);

  this.actionMap.set("playback:ambilightStripEnabled", () => {
    AmbilightSettingsStore.setStrip({ enabled: !AmbilightSettingsStore.get().strip.enabled });
    AmbilightController.applySettings();
  });
  this.actionMap.set("playback:ambilightStripStatus", async () => {
    try {
      this.ambilightStripStatus = await AmbilightController.describeStrip();
    } catch (error) {
      this.ambilightStripStatus = `Could not reach the TV service: ${error?.message || error}`;
    }
  });
  this.actionMap.set("playback:ambilightStripStart", () => {
    this.openOptionDialog({
      title: t("settings.playback.ambilight.strip.start.title", {}, "Strip controller end"),
      options: AMBILIGHT_STRIP_STARTS.map((start) => ({ id: start, label: ambilightStripStartLabel(start) })),
      selectedId: AmbilightSettingsStore.get().strip.start,
      returnFocusKey: "playback:ambilightStripStart",
      onSelect: (option) => {
        AmbilightSettingsStore.setStrip({ start: String(option.id) });
        AmbilightController.applySettings();
      }
    });
  });
  this.actionMap.set("playback:ambilightStripDirection", () => {
    this.openOptionDialog({
      title: t("settings.playback.ambilight.strip.direction.title", {}, "Strip direction"),
      options: [
        { id: "cw", label: t("settings.playback.ambilight.strip.direction.cw", {}, "Clockwise") },
        { id: "ccw", label: t("settings.playback.ambilight.strip.direction.ccw", {}, "Counter-clockwise") }
      ],
      selectedId: AmbilightSettingsStore.get().strip.clockwise ? "cw" : "ccw",
      returnFocusKey: "playback:ambilightStripDirection",
      onSelect: (option) => {
        AmbilightSettingsStore.setStrip({ clockwise: option.id === "cw" });
        AmbilightController.applySettings();
      }
    });
  });
  this.actionMap.set("playback:ambilightStripLevel", () => {
    this.openOptionDialog({
      title: t("settings.playback.ambilight.strip.level.title", {}, "Strip max brightness"),
      options: AMBILIGHT_LEVEL_OPTIONS.map((level) => ({ id: level, label: `${level}%` })),
      selectedId: AmbilightSettingsStore.get().strip.level,
      returnFocusKey: "playback:ambilightStripLevel",
      onSelect: (option) => {
        AmbilightSettingsStore.setStrip({ level: Number(option.id) });
        AmbilightController.applySettings();
      }
    });
  });

  AmbilightSettingsStore.get().bulbs.forEach((bulb) => {
    const focusKey = `playback:ambilightBulb:${bulb.id}`;
    this.actionMap.set(focusKey, () => {
      this.openOptionDialog({
        title: bulb.name,
        options: AMBILIGHT_POSITIONS.map((position) => ({ id: position, label: ambilightPositionLabel(position) })),
        selectedId: getBulbPosition(AmbilightSettingsStore.get(), bulb),
        returnFocusKey: focusKey,
        onSelect: (option) => {
          AmbilightSettingsStore.setBulbPosition(bulb.id, String(option.id));
          AmbilightController.applySettings();
        }
      });
    });
    const maxKey = `playback:ambilightBulbMax:${bulb.id}`;
    this.actionMap.set(maxKey, () => {
      this.openOptionDialog({
        title: t("settings.playback.ambilight.bulbMax.title", { name: bulb.name }, `${bulb.name} max brightness`),
        options: AMBILIGHT_LEVEL_OPTIONS.map((level) => ({ id: level, label: `${level}%` })),
        selectedId: getBulbMaxBrightness(AmbilightSettingsStore.get(), bulb),
        returnFocusKey: maxKey,
        onSelect: (option) => {
          AmbilightSettingsStore.setBulbMaxBrightness(bulb.id, Number(option.id));
          AmbilightController.applySettings();
        }
      });
    });
  });
}
