/* eslint-disable no-unused-vars */
import * as internals from "./playerScreenContext.js";
import { AmbilightController } from "../../../core/ambilight/ambilightController.js";
import { AMBILIGHT_LEVEL_OPTIONS, AMBILIGHT_LEVEL_STEP, AmbilightSettingsStore } from "../../../data/local/ambilightSettingsStore.js";

// "Lights" in the player's More actions: a vertical slider for the ambilight's overall
// brightness cap. Up/Down move it in 10% steps and the bulbs follow at once.
export function createPlayerScreenMethods74() {
  const { isSelectKeyCode, t, clamp, escapeHtml } = internals;
  const minLevel = AMBILIGHT_LEVEL_OPTIONS[0];
  const maxLevel = AMBILIGHT_LEVEL_OPTIONS[AMBILIGHT_LEVEL_OPTIONS.length - 1];

  return {
    isLightsControlAvailable() {
      return AmbilightController.isAvailable() && AmbilightSettingsStore.get().enabled;
    },
    openLightsDialog() {
      this.lightsDialogVisible = true;
      this.speedDialogVisible = false;
      this.subtitleDialogVisible = false;
      this.audioDialogVisible = false;
      this.sourcesPanelVisible = false;
      this.renderSubtitleDialog();
      this.renderAudioDialog();
      this.renderSourcesPanel();
      this.renderSpeedDialog();
      this.renderLightsDialog();
      this.updateModalBackdrop();
    },
    closeLightsDialog() {
      this.lightsDialogVisible = false;
      this.renderLightsDialog();
      this.renderControlButtons();
      this.updateModalBackdrop();
      this.resetControlsAutoHide();
    },
    renderLightsDialog() {
      const dialog = this.uiRefs?.lightsDialog;
      if (!dialog) {
        return;
      }
      dialog.classList.toggle("hidden", !this.lightsDialogVisible);
      if (!this.lightsDialogVisible) {
        dialog.innerHTML = "";
        return;
      }
      const level = AmbilightSettingsStore.get().level;
      dialog.innerHTML = `
          <div class="player-dialog-title">${escapeHtml(t("player_lights_title", {}, "Lights"))}</div>
          <div class="player-lights-value">${escapeHtml(`${level}%`)}</div>
          <div class="player-lights-slider focused" data-lights-slider="1">
            <div class="player-lights-fill" style="height: ${level}%"></div>
            <div class="player-lights-knob" style="bottom: ${level}%"></div>
          </div>
          <div class="player-dialog-item-sub player-lights-hint">${escapeHtml(
            t("player_lights_hint", {}, "Max brightness of all bulbs. Up and Down to change.")
          )}</div>
        `;
    },
    stepLightsLevel(direction) {
      const current = AmbilightSettingsStore.get().level;
      const next = clamp(current + direction * AMBILIGHT_LEVEL_STEP, minLevel, maxLevel);
      if (next !== current) {
        AmbilightController.setLevel(next);
      }
      this.renderLightsDialog();
      this.resetControlsAutoHide();
    },
    handleLightsDialogKey(event) {
      const keyCode = Number(event?.keyCode || 0);
      if (keyCode === 38 || keyCode === 39) {
        this.stepLightsLevel(1);
        return true;
      }
      if (keyCode === 40 || keyCode === 37) {
        this.stepLightsLevel(-1);
        return true;
      }
      if (isSelectKeyCode(keyCode)) {
        this.closeLightsDialog();
        return true;
      }
      return false;
    }
  };
}
