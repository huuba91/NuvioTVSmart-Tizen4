# HTML colour probe (Tizen 4 test widget)

A small standalone widget (separate app id `HtmlProbe1.ColorProbe`, it never touches Nuvio) that
answers one question on the UE49NU7100: **can the page read the colours of an HTML `<video>`?**
If yes, Nuvio could play through HTML video and drive the ambilight from the page itself, without the
signed filesystem/system build that the `dcapture` service capture needs.

`docs/tizen4-ambilight.md` already notes that canvas/WebGL readback was blank on this firmware. This
probe re-tests that properly across every variation that could change the outcome.

## What it tests

All tests play `media/pattern.mp4` (1280x720 H.264 Main@4.0). Its left 20% / centre 60% / right 20%
rotate red, green, blue every 2 s, so a pass means the read-back colours match the *expected* colour
at the *expected* time, not just "something non-black".

| test | why |
| --- | --- |
| canvas 2D, packaged file | simplest case; `file://` origin may taint the canvas |
| canvas 2D, blob URL | same-origin, never tainted |
| canvas 2D, MSE | the path hls.js / dash.js use in Nuvio |
| canvas 2D, remote CORS URL | `crossOrigin=anonymous` over the network |
| WebGL `texImage2D` + `readPixels` | different path from 2D canvas |
| `createImageBitmap` | third path |
| canvas 2D, packaged + MSE, 1080p fullscreen | real playback geometry (small windows can use a different pipeline) |
| canvas 2D, packaged, compositing hints | `transform`/`filter`/`will-change` can force a GPU-composited texture instead of the hardware plane |

Statuses: **PASS** (colours follow the video), **BLANK** (all pixels 0: the video is on a hardware
plane the page cannot read), **TAINTED** (origin rules), **FROZEN** (readback never changes),
**WRONG** (changes but wrong colours), **ERROR**, **SKIP**. `ms/grab` is the cost of one 64x36
read-back against live video; it decides the achievable update rate.

The header also lists Tizen/Chromium version, WebGL renderer and codec support
(`canPlayType` / MSE), which is useful for deciding what HTML playback could replace.

## Build, sign, install

```bash
npm install                                   # once, for jszip
node tools/html-color-probe/build.mjs         # -> .cache/html-color-probe/HtmlColorProbe.wgt
```

Then sign and install exactly like the Nuvio WGT (profile/device names from `deploy-tizen4.ps1`):

```powershell
$tz = "C:\tizen-studio\tools\ide\bin\tizen.bat"
& $tz package -t wgt -s NU7100-Nuvio -o .cache\html-color-probe\signed -- .cache\html-color-probe\HtmlColorProbe.wgt
& $tz install -n HtmlColorProbe.wgt -s 192.168.129.0:26101 -- .cache\html-color-probe\signed
& $tz run -p HtmlProbe1.ColorProbe -s 192.168.129.0:26101
```

It runs all tests on launch (about 2 minutes) and shows a green/amber/red verdict.

### Optional: get the results on the PC

```bash
node tools/html-color-probe/report-server.mjs          # prints build commands with your LAN IP
node tools/html-color-probe/build.mjs --pc http://<pc-ip>:8099
```

The widget then POSTs its JSON report to the PC (`tools/html-color-probe/reports/`, git-ignored) and
the "remote CORS URL" test streams the pattern clip from the PC so its colours are verified exactly.
Without it, the remote test uses a public sample (generic "not blank and changing" check), and the
report is also kept in `localStorage` and logged as `PROBE_RESULT {...}` for the web inspector.

## Remote keys

RED / OK: run all · GREEN: live ambilight preview · YELLOW: expand env info · BLUE: send report · RETURN: exit.

**Live preview** plays the clip fullscreen using the fastest passing method and paints 8 edge
segments plus a centre swatch from page-side readback, with a Hz and ms/grab HUD. OK swaps between
the pattern and the remote clip; RETURN goes back. It shows timing and latency, not the dominant-colour
logic (that stays in `services/tizen/runtime/ambilight-colour.cjs`).

## Reading the result

- **READBACK WORKS** and fullscreen also passes: switching to HTML playback is viable. Next step is to
  run the same probe against `Nuvio`'s real sources (hls.js/dash.js, EngineFS loopback, HDR/HEVC) and
  feed the colours to `ambilight-colour.cjs` over the existing `/ambilight` routes.
- **BLANK everywhere**: HTML video on this firmware is a hardware overlay; keep `dcapture`.
- Pass in some variants only (for example blob but not file, or fullscreen only): that variant is the
  one HTML playback has to use.

## Regenerating the clips

`./make-media.sh` (needs ffmpeg + libx264).

## Verification status

Logic was exercised in desktop Chromium (with a VP9 stand-in for the clip, since that build has no
H.264), where every non-MSE test passed. Nothing has been run on the TV yet, and the MSE test could
not be exercised off-device.
