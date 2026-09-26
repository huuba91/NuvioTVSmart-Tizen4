import { runTizen4PlaybackMatrix } from "../../../core/player/tizen4PlaybackMatrix.js";
import { Platform } from "../../../platform/index.js";
import { Router } from "../../navigation/routerState.js";
import { ScreenUtils } from "../../navigation/screen.js";

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatResult(result) {
  const details = [
    result.verdict,
    `score ${result.score}`,
    `start ${result.startupMs || 0}ms`,
    `play ${result.progressMs || 0}ms`,
    `stalls ${result.stalls || 0}`
  ];
  if (result.error) details.push(`error ${result.error}`);
  return `${result.id}: ${details.join(" · ")}`;
}

export const Tizen4PlaybackMatrixScreen = {
  container: null,
  complete: false,
  running: false,
  results: [],
  status: "Starting…",

  async mount() {
    globalThis.__NUVIO_TIZEN4_REPORT_STAGE__?.("matrix-screen-mount");
    this.container = document.getElementById("tizen4PlaybackMatrix");
    ScreenUtils.show(this.container);
    this.complete = false;
    this.running = true;
    this.results = [];
    this.status = "Starting eight controlled playback paths…";
    this.onKeyDownBound = this.onKeyDown.bind(this);
    document.addEventListener("keydown", this.onKeyDownBound, true);
    this.render();
    try {
      await runTizen4PlaybackMatrix({
        onUpdate: (update) => {
          this.results = update.results || this.results;
          if (update.phase === "running") {
            this.status = `RUNNING ${update.index + 1}/${update.total}: ${update.testCase.id}`;
          } else if (update.phase === "complete") {
            this.status = "COMPLETE";
            this.complete = true;
          }
          this.render();
        }
      });
    } catch (error) {
      this.status = `MATRIX ERROR: ${String(error?.message || error)}`;
      this.complete = true;
      this.render();
    } finally {
      this.running = false;
    }
  },

  render() {
    if (!this.container) return;
    this.container.innerHTML = `
      <main style="min-height:100%;box-sizing:border-box;background:#080b12;color:#fff;padding:64px 80px;font:28px/1.4 sans-serif">
        <h1 style="font-size:48px;margin:0 0 20px">Tizen 4 playback matrix · MATRIX20</h1>
        <p>${escapeHtml(this.status)}</p>
        <pre style="white-space:pre-wrap;font:24px/1.5 monospace;margin-top:28px">${escapeHtml(
          this.results.length ? this.results.map(formatResult).join("\n") : "No result yet."
        )}</pre>
        <p style="font-size:22px;opacity:.75;margin-top:32px">${
          this.complete ? "Press Back to return to Settings." : "Please wait; tests run automatically."
        }</p>
      </main>`;
  },

  async onKeyDown(event) {
    if (!Platform.isBackEvent(event) || !this.complete) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    await Router.back();
  },

  cleanup() {
    document.removeEventListener("keydown", this.onKeyDownBound, true);
    this.onKeyDownBound = null;
    ScreenUtils.hide(this.container);
  }
};
