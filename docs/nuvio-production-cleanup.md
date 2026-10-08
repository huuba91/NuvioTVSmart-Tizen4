# Nuvio production cleanup

The Tizen 4 port grew a set of research tools while playback, P2P and the ambilight were being
proven on the UE49NU7100. This cleanup keeps what the shipped app needs, keeps useful developer
tooling behind an explicit build flavour, moves the research diaries to `docs/research/`, and
deletes the harnesses whose findings are already recorded there.

## Build flavours

| Flavour                               | How to build                                                                                                                                                                | What it contains                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production (default)                  | `npm run package:tizen`, `scripts/deploy-tizen4.ps1`                                                                                                                        | `__NUVIO_DEV_DIAGNOSTICS__` is `false`, so esbuild drops the Console debug screen, its About row and the console capture buffer. The WGT has no `netcheck.cjs` and no `webOSTV.js`.              |
| Developer diagnostics                 | `npm run package:tizen:dev`, `deploy-tizen4.ps1 -DevDiagnostics`, or `NUVIO_DEV_DIAGNOSTICS=1 npm run build` followed by `node scripts/package-tizen.mjs --dev-diagnostics` | Settings > About > Console debug (latest warnings and errors), the console capture installed at startup, and the EngineFS `/netcheck` network self-test (`services/tizen/runtime/netcheck.cjs`). |
| Store (`npm run package:tizen:store`) | unchanged                                                                                                                                                                   | Production flavour, signed with an official profile. `--dev-diagnostics` and a bulb list are refused.                                                                                            |

`scripts/build.mjs` writes `.cache/build-flavour.json`; `scripts/package-tizen.mjs` refuses to
package a `dist/` whose flavour does not match its own flag, so a production package cannot pick
up a diagnostics bundle by accident (and the other way round). Without the marker, `dist/` counts
as production.

When `netcheck.cjs` is not packaged, the EngineFS service does not register `/netcheck`: the
request falls through to EngineFS like any unknown path. The service checks for the file once at
start (`fs.existsSync`), so a missing file cannot stop it.

## Privileges

`config.xml` used to add `filesystem.read`, `filesystem.write` and `system` only when an
`ambilight-bulbs.json` was packaged. The screen capture (`services/tizen/runtime/ambilight.cjs`:
`gdbus` call to `samsung.tizen.dcapture`, PNG in `/dev/shm`) needs them for the LED-strip-only
setup as well, so they now follow "ambilight runtime included": every non-Store package with the
EngineFS service. Store packages keep their previous manifest (no capture privileges, no bulb
list). Note: the ambilight runtime files are still inside Store packages because
`enginefs-service.js` loads `ambilight.cjs` unconditionally; without the privileges the capture
simply fails there, and playback is unaffected.

`http://developer.samsung.com/privilege/network.public` stays. Whether the app still needs it
could not be verified without the TV.

## WGT size, before and after

Measured from `git archive` copies of the start commit (`6e21459`) and of this branch, built in
`/tmp` with `npm run build` and `node scripts/package-tizen.mjs --outdir <tmp>` (no bulb list,
example `local.properties`).

| Package                      | ZIP entries (files) | Uncompressed     | File size       |
| ---------------------------- | ------------------- | ---------------- | --------------- |
| Before (1.2.65, `6e21459`)   | 137 (124)           | 23,118,490 bytes | 6,554,301 bytes |
| After, production            | 135 (122)           | 23,067,198 bytes | 6,538,370 bytes |
| After, developer diagnostics | 136 (123)           | 23,084,013 bytes | 6,543,346 bytes |

The production package is 51,292 bytes smaller unpacked and 15,931 bytes smaller as a file:
`webOSTV.js` (13,818 bytes) and `netcheck.cjs` (5,880 bytes) are gone, the app bundle shrank from
3,164,215 to 3,132,730 bytes (research harnesses removed, Console debug compiled out), and the
generated `main.js` from 2,474 to 1,678 bytes (matrix flags and report hook removed). Checked in
the production package: no `netcheck.cjs`, no `webOSTV.js`, no `tizen4-probe.mp4`, no Console
debug code in the bundle. The developer-diagnostics package does contain `netcheck.cjs` and the
Console debug screen.

## KEEP / MOVE / DELETE

| Path                                                                                               | Decision                                            | Reason                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `js/ui/screens/debug/consoleDebugScreen.js`                                                        | KEEP, dev-diagnostics only                          | Useful on a TV without a usable log; route, container and About row are compiled in only with `__NUVIO_DEV_DIAGNOSTICS__`.                               |
| `js/core/diagnostics/consoleDebugBuffer.js`                                                        | KEEP, dev-diagnostics only                          | No longer installs itself on import; `js/core/diagnostics/installDevDiagnostics.js` (first import of `js/app.js`) installs it in dev-diagnostics builds. |
| Settings > About "Console debug" row, `debugConsole` route and container                           | KEEP, dev-diagnostics only                          | Gated in `settingsScreenMethods-12-render-trakt-stats-strip.js`, `router.js` and `renderAppShell.js`.                                                    |
| `res/values*/strings.xml`: `about_debug_console_title`, `about_debug_console_subtitle`             | KEEP                                                | Still used by the dev-diagnostics row. The MATRIX5/PKG3 rows used hard-coded English text, so no strings were orphaned.                                  |
| `js/core/diagnostics/pluginDiagnostics.js`                                                         | KEEP                                                | Used by production plugin error paths.                                                                                                                   |
| AVPlay diagnostic snapshots (`getAvPlayDiagnosticSnapshot`, `getAvPlaySubtitleDiagnosticSnapshot`) | KEEP                                                | Used by production playback and subtitle error handling.                                                                                                 |
| `services/tizen/runtime/netcheck.cjs` and the `/netcheck` route                                    | KEEP, dev-diagnostics only                          | Left out of production WGTs; the route exists only when the file is packaged.                                                                            |
| `services/tizen/runtime/fast-dns.cjs`                                                              | KEEP                                                | Production fix for 5 s name lookups (found with `/netcheck`).                                                                                            |
| `assets/libs/webOSTV.js`                                                                           | KEEP in repo, not in Tizen WGT                      | The webOS packager and sync script need it; Tizen never loads it.                                                                                        |
| `window.__NUVIO_FORK_BUILD__` (generated `main.js`)                                                | KEEP                                                | Still shown as the fork label on Settings > About. It no longer enables any research action.                                                             |
| `scripts/make-ambilight-bulbs.py`                                                                  | KEEP                                                | Ambilight setup tool (writes the git-ignored bulb list).                                                                                                 |
| `scripts/watch-tizen4-sdb.ps1`                                                                     | KEEP                                                | Development helper for the SDB connection during deploys.                                                                                                |
| `tools/html-color-probe/`                                                                          | KEEP                                                | Standalone research widget; `tools/` never ships in the WGT (see `tools/README.md`).                                                                     |
| `docs/tizen4-streaming-architecture.md`                                                            | KEEP (trimmed)                                      | Describes the shipped playback paths. Its probe/matrix/P2P-lifecycle findings moved out.                                                                 |
| `docs/tizen4-validation-matrix.md`                                                                 | KEEP                                                | Release checklist for the shipped app, not an experiment diary.                                                                                          |
| `docs/tizen4-ambilight.md`                                                                         | KEEP                                                | Describes how the shipped ambilight works; privilege paragraph updated.                                                                                  |
| `docs/tizen4-engineering-log.md`                                                                   | MOVE to `docs/research/`                            | Diary of hardware experiments.                                                                                                                           |
| "Controlled direct-play probe", "Transport matrix result", "Controlled P2P lifecycle result"       | MOVE to `docs/research/tizen4-playback-findings.md` | Research findings behind the backend choices; the architecture doc links to them.                                                                        |
| `docs/youtube-proxy.html`                                                                          | KEEP in `docs/`                                     | Not documentation: `scripts/build.mjs` copies it into the package.                                                                                       |
| `js/core/player/tizen4PlaybackMatrix.js`, `js/ui/screens/debug/tizen4PlaybackMatrixScreen.js`      | DELETE                                              | MATRIX5 harness; results recorded in the engineering log.                                                                                                |
| `js/core/streams/tizen4DirectPlaybackProbe.js`                                                     | DELETE                                              | PKG3 direct-play probe; results recorded.                                                                                                                |
| MATRIX5/PKG3 About rows, `tizen4PlaybackMatrix` route and container, auto-run in `js/app.js`       | DELETE                                              | Only reachable from the harnesses.                                                                                                                       |
| `tizen4DiagnosticProbe` overlay in `playerScreenMethods-32-update-ui-tick.js`                      | DELETE                                              | Only set by the PKG3 probe.                                                                                                                              |
| `NUVIO_TIZEN4_MATRIX_*` (`package-tizen.mjs`), `NUVIO_TIZEN4_PROBE_MEDIA_FILE` (`build.mjs`)       | DELETE                                              | Build plumbing for the harnesses and the packaged `assets/tizen4-probe.mp4`.                                                                             |
| `__NUVIO_TIZEN4_REPORT_STAGE__` in the generated `main.js`                                         | DELETE                                              | Only the harness and its auto-run used it.                                                                                                               |
| `scripts/tizen4-media-probe-server.py`, `scripts/tizen4-matrix-collector.py`                       | DELETE                                              | PC-side LAN media server and result collector for the matrix.                                                                                            |
| `tests/tizen4-playback-matrix.test.mjs`, `tests/tizen4-direct-playback-probe.test.mjs`             | DELETE                                              | Tested the deleted harnesses. Replaced by `tests/tizen-package-flavours.test.mjs` for the packaging rules.                                               |
| `scripts/__pycache__/`                                                                             | DELETE                                              | Python bytecode; `.gitignore` now has `__pycache__/` and `*.pyc`.                                                                                        |

## Native sources

The Pepper plugin and the libde265 decoder sources from the research are not in this repository
yet. They live on the developer PC and will be added under `native/`.
