import * as internals from "./settingsScreenContext.js";
import { AmbilightSettingsStore, getBulbMaxBrightness, getBulbPosition } from "../../../data/local/ambilightSettingsStore.js";

export function ambilightPositionLabel(position) {
  const { t } = internals;
  if (position === "left") return t("settings.playback.ambilight.position.left", {}, "Left");
  if (position === "right") return t("settings.playback.ambilight.position.right", {}, "Right");
  if (position === "off") return t("settings.playback.ambilight.position.off", {}, "Off");
  return t("settings.playback.ambilight.position.center", {}, "Center");
}

export function ambilightStripStartLabel(start) {
  const { t } = internals;
  const labels = {
    tl: t("settings.playback.ambilight.strip.start.tl", {}, "Top left"),
    t: t("settings.playback.ambilight.strip.start.t", {}, "Top"),
    tr: t("settings.playback.ambilight.strip.start.tr", {}, "Top right"),
    r: t("settings.playback.ambilight.strip.start.r", {}, "Right"),
    br: t("settings.playback.ambilight.strip.start.br", {}, "Bottom right"),
    b: t("settings.playback.ambilight.strip.start.b", {}, "Bottom"),
    bl: t("settings.playback.ambilight.strip.start.bl", {}, "Bottom left"),
    l: t("settings.playback.ambilight.strip.start.l", {}, "Left")
  };
  return labels[start] || labels.bl;
}

export function renderPlaybackAmbilightBody() {
  const { t } = internals;
  const settings = AmbilightSettingsStore.get();
  const bulbRows = settings.bulbs
    .map(
      (bulb) =>
        this.renderActionRow({
          focusKey: `playback:ambilightBulb:${bulb.id}`,
          title: bulb.name,
          subtitle: t("settings.playback.ambilight.bulb.subtitle", {}, "Which part of the picture this bulb follows."),
          value: ambilightPositionLabel(getBulbPosition(settings, bulb))
        }) +
        this.renderActionRow({
          focusKey: `playback:ambilightBulbMax:${bulb.id}`,
          title: t("settings.playback.ambilight.bulbMax.title", { name: bulb.name }, `${bulb.name} max brightness`),
          subtitle: t(
            "settings.playback.ambilight.bulbMax.subtitle",
            {},
            "Cap for this bulb on its own, on top of the overall brightness."
          ),
          value: `${getBulbMaxBrightness(settings, bulb)}%`
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
              title: t("settings.playback.ambilight.level.title", {}, "Overall max brightness"),
              subtitle: t(
                "settings.playback.ambilight.level.subtitle",
                {},
                "Caps every bulb. Also on the Lights slider in the player menu."
              ),
              value: `${settings.level}%`
            })}
            ${this.renderToggleRow({
              focusKey: "playback:ambilightStripEnabled",
              title: t("settings.playback.ambilight.strip.enabled.title", {}, "Surround strip"),
              subtitle: t(
                "settings.playback.ambilight.strip.enabled.subtitle",
                {},
                "The 8-segment LED strip round the back of the TV follows the edges of the picture."
              ),
              checked: settings.strip.enabled
            })}
            ${this.renderActionRow({
              focusKey: "playback:ambilightStripStart",
              title: t("settings.playback.ambilight.strip.start.title", {}, "Strip controller end"),
              subtitle: t(
                "settings.playback.ambilight.strip.start.subtitle",
                {},
                "Where the first segment sits, seen from the front of the TV."
              ),
              value: ambilightStripStartLabel(settings.strip.start)
            })}
            ${this.renderActionRow({
              focusKey: "playback:ambilightStripDirection",
              title: t("settings.playback.ambilight.strip.direction.title", {}, "Strip direction"),
              subtitle: t("settings.playback.ambilight.strip.direction.subtitle", {}, "Which way the strip runs from the controller end."),
              value: settings.strip.clockwise
                ? t("settings.playback.ambilight.strip.direction.cw", {}, "Clockwise")
                : t("settings.playback.ambilight.strip.direction.ccw", {}, "Counter-clockwise")
            })}
            ${this.renderActionRow({
              focusKey: "playback:ambilightStripLevel",
              title: t("settings.playback.ambilight.strip.level.title", {}, "Strip max brightness"),
              subtitle: t("settings.playback.ambilight.strip.level.subtitle", {}, "Cap for the strip, on top of the overall brightness."),
              value: `${settings.strip.level}%`
            })}
            ${this.renderActionRow({
              focusKey: "playback:ambilightStripStatus",
              title: t("settings.playback.ambilight.strip.status.title", {}, "Strip status"),
              subtitle:
                this.ambilightStripStatus ||
                t("settings.playback.ambilight.strip.status.subtitle", {}, "Select to see what the strip is receiving.")
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
