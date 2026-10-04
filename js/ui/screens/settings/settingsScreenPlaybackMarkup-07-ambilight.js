import * as internals from "./settingsScreenContext.js";
import { AmbilightSettingsStore, getBulbPosition } from "../../../data/local/ambilightSettingsStore.js";

export function ambilightPositionLabel(position) {
  const { t } = internals;
  if (position === "left") return t("settings.playback.ambilight.position.left", {}, "Left");
  if (position === "right") return t("settings.playback.ambilight.position.right", {}, "Right");
  if (position === "off") return t("settings.playback.ambilight.position.off", {}, "Off");
  return t("settings.playback.ambilight.position.center", {}, "Center");
}

export function renderPlaybackAmbilightBody() {
  const { t } = internals;
  const settings = AmbilightSettingsStore.get();
  const bulbRows = settings.bulbs
    .map((bulb) =>
      this.renderActionRow({
        focusKey: `playback:ambilightBulb:${bulb.id}`,
        title: bulb.name,
        subtitle: t("settings.playback.ambilight.bulb.subtitle", {}, "Which part of the picture this bulb follows."),
        value: ambilightPositionLabel(getBulbPosition(settings, bulb))
      })
    )
    .join("");
  const findSubtitle =
    this.ambilightStatus ||
    (settings.bulbs.length
      ? t("settings.playback.ambilight.find.subtitle", {}, "Reload the bulbs packaged with this app.")
      : t("settings.playback.ambilight.find.empty", {}, "No bulbs known yet. Select to look them up."));
  return `
          <div class="settings-stack">
            ${this.renderToggleRow({
              focusKey: "playback:ambilightEnabled",
              title: t("settings.playback.ambilight.enabled.title", {}, "Ambilight"),
              subtitle: t("settings.playback.ambilight.enabled.subtitle", {}, "Bulbs follow the colours on screen while a video plays."),
              checked: settings.enabled
            })}
            ${this.renderActionRow({
              focusKey: "playback:ambilightLevel",
              title: t("settings.playback.ambilight.level.title", {}, "Brightness"),
              subtitle: t("settings.playback.ambilight.level.subtitle", {}, "How bright the bulbs follow the picture."),
              value: `${settings.level}%`
            })}
            ${bulbRows}
            ${this.renderActionRow({
              focusKey: "playback:ambilightRefresh",
              title: t("settings.playback.ambilight.find.title", {}, "Find bulbs"),
              subtitle: findSubtitle
            })}
          </div>
        `;
}
