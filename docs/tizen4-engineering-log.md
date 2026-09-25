# Tizen 4 Engineering Log

Target hardware: Samsung UE49NU7100 (2018), Tizen 4.0 / Chromium 56.

## Baseline (2026-09-25)

- Source revision: `6069a3048fdde38ef55ec85547d4b281a9264463` (`main`, one commit after tag `1.2.0`).
- Original remote preserved as `upstream = https://github.com/NuvioMedia/NuvioTVSmart.git`.
- Development branch: `tizen4/nu7100`.
- Stock `npm run build`: passes.
- Stock `npm run package:tizen`: passes and produces `NuvioTV001_1.2.0.wgt` with EngineFS and PluginService files.
- Stock `npm test`: fails after a successful build because `tests/test-plugin-system.mjs` and `tests/test-plugin-localization.mjs` are absent from the checkout. The test entry point is repaired on this branch and new tracked regression tests are used.
- The machine's PowerShell `npm` launcher resolves a nonexistent per-user npm CLI. Validation can use the npm CLI installed beside Node until the machine-level launcher is repaired.
- SDB sees `192.168.129.0:26101` as device `UE49NU7100`.
- Existing signing profile `NU7100-Nuvio` is present and active. No certificate or profile data was changed.

## Compatibility findings

- Samsung documents the 2018/Tizen 4 TV web engine as Chromium M56.
- The production build already targets Chrome 56, generates a matching core-js bundle, and applies several CSS fallbacks.
- The current Tizen capability policy permits direct playback on Tizen 4 but deliberately gates EngineFS P2P below Tizen 5 and executable plugins below Tizen 6. These are policy gates, not proof that the packaged services work on those versions.
- Both packaged Tizen services assume a CommonJS/Node-compatible Web Service runtime. EngineFS requires `fs`, `http`, `net`, `dgram`, `stream`, `events`, `path`, `url`, `crypto`, and `buffer`; PluginService requires at least `http` and loads other networking modules lazily.
- Tizen's Web Runtime specification describes Web Service support as optional and partner-certificate-level. A WGT containing the files and manifest entries therefore does not prove the service can start on this TV.
- The installed Tizen Studio contains platform profiles through Tizen 10 but no Samsung NaCl SDK/toolchain was found. Samsung documentation confirms NaCl support on TV products through 2021 and supports TCP/UDP sockets, file I/O, and JavaScript messaging, so it remains a credible Tizen 4 P2P investigation path once a compatible SDK/toolchain is available.
- Samsung WebAssembly application tooling requires Tizen 5.5 or newer; it is not a primary backend path for this Tizen 4 target.

## QR regression hypothesis and fix

The QR generator painted a canvas and then performed a full `getImageData()` / `putImageData()` round trip only to round the outer corners. The QR screen remained visible on the physical TV but its code was blank, which isolates the failure to rendering rather than routing. Pixel-buffer readback is unnecessary for QR output and is a fragile path on the older TV canvas implementation.

The Tizen 4 auth QR now uses the QR library's locally generated GIF data URL in an `<img>`. No hosted QR service is used and the login payload remains local. The generic canvas path was also changed to integer-aligned square modules and no longer reads or rewrites the canvas pixel buffer. Automated tests cover both paths. Physical TV validation is still required before calling the regression fixed.

## Hardware-required checkpoints

- Auth QR is visibly rendered and scannable.
- QR approval completes login.
- Guest continuation remains functional.
- Remote focus, Back, close/relaunch, and persisted state remain functional.
- Packaged Web Service startup and module availability.
- AVPlay format, track, subtitle, seek, suspend/resume, and error behavior.
- Any local P2P proof of concept.
