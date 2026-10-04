import * as internals from "./settingsScreenContext.js";
import {
  AMBILIGHT_LEVEL_OPTIONS,
  AMBILIGHT_POSITIONS,
  AmbilightSettingsStore,
  getBulbMaxBrightness,
  getBulbPosition
} from "../../../data/local/ambilightSettingsStore.js";
import { AmbilightController } from "../../../core/ambilight/ambilightController.js";
import { ambilightPositionLabel } from "./settingsScreenPlaybackMarkup-07-ambilight.js";

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
