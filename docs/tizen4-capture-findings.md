# Tizen 4 screen/video colour capture: what was tried

Target: UE49NU7100 (Tizen 4.0, Chromium 56, PowerVR Rogue GE8200). Goal: get the picture colours of
whatever Nuvio plays, to drive the bulbs and the DDP strip.

## Result in one line

Only the service-side `samsung.tizen.dcapture` capture works. Page-side readback of HTML video is blank
or unavailable, and AVPlay exposes no pixels.

## Methods

| # | Method | Where it runs | Result | Evidence |
| --- | --- | --- | --- | --- |
| 1 | `samsung.tizen.dcapture` `RequestCaptureToFileSync` via `gdbus`, PNG in `/dev/shm` | EngineFS service (needs the filesystem/system privileges of the dev build) | **Works.** Includes the video plane, so it covers AVPlay and HTML video, any codec. ~9 pictures/s with 3 overlapped captures, ~43% CPU in research. Mode 2 returns at least 320x180. | `docs/tizen4-ambilight.md`; in production use |
| 2 | Canvas 2D `drawImage(video)` + `getImageData`, video from packaged file | page | **Blank** (all pixels 0) while the video plays at 1280x720 | probe on TV, 2026-10-06 |
| 3 | Canvas 2D, video fed through MSE (the hls.js / dash.js path) | page | **Blank**; MSE itself works (started in ~805 ms) | probe on TV |
| 4 | Canvas 2D, 1080p fullscreen, packaged file and MSE | page | Video plays, **no colours recorded** | probe on TV (reported by the user) |
| 5 | Canvas 2D with compositing hints (`transform`, `filter`, `will-change`) to force a GPU texture | page | Run in the same probe pass; no colours were reported | probe on TV; detail not captured |
| 6 | WebGL `texImage2D(video)` + `readPixels` | page | **Fails**: `texImage2D` GL error 0x500 (INVALID_ENUM). A brief video flash was seen during the test. | probe on TV |
| 7 | `createImageBitmap(video)` | page | **Crashed the app** (it closed; relaunch worked) | probe on TV |
| 8 | Video from a blob URL (XHR to Blob) | page | Video never started playing, so readback was never exercised. Earlier probe versions also hung on the play promise; fixed. | probe on TV |
| 9 | Remote CORS URL (`crossOrigin=anonymous`) | page | Not conclusive: errored or hung in the probe runs | probe on TV |
| 10 | Canvas/WebGL readback in general (earlier research) | page | Blank on this firmware | `docs/tizen4-ambilight.md` |
| 11 | AVPlay (`webapis.avplay`) | page | Not probed: the API gives no frame data, only a display rectangle for the video plane | API surface, not measured |

Reading of 2-8: HTML video on this TV is drawn on a hardware plane. The page cannot read it by canvas,
WebGL or ImageBitmap, whichever source or size is used.

## What `samsung.tizen.dcapture` offers (introspected on the TV)

Interface `samsung.tizen.dcapture` at `/samsung/tizen/dcapture`:

- `RequestCaptureToFileSync(i app_type, i capture_mode, i comp_type, i width, i height, i jpeg_quality, s dir_path, s file_name)`
  returns `(i retVal, i ret_width, i ret_height, s ret_path)`. This is the call in use, with
  `0, 2, 0, w, h, 80`: so `capture_mode` is 2 and `comp_type` is 0 (which produces PNG; `jpeg_quality` is
  presumably only used for another `comp_type`). Other modes and compression types are not yet tried.
- `StartPeriodicCapture(... , i interval_msec)` / `StartPeriodicCaptureWithoutAppInfo` and
  `EndPeriodicCapture(i app_type, s app_id, i flush_mode)`: continuous capture driven by the service
  instead of one `gdbus` process per picture. Where the pictures go is unknown.
- `RequestCapture`, `RequestCapture_SYNC` (+ `WithoutAppInfo`): other capture entry points, output target unknown.
- `*_XWD` variants and `PrepXwdCapture` / `CompleteXwdCapture`: capture of an X11 window by handle.

### Results of the sweep and the periodic probe (UE49NU7100, video playing)

- **Size:** the requested 64x36 is ignored; every successful capture returns **480x270** (PNG is RGBA).
- **`comp_type`:** 0 = PNG (94-147 KB), **1 = JPEG (9-17 KB)**; 2 and 3 fail with -6. There is no raw or BMP format.
- **`capture_mode`:** 0, 1, 2 and 3 work; 4 fails with -4. Mean colours are similar across modes 0-3, so the
  sweep did not show a mode that leaves out Nuvio's controls (a mode comparison on a screen with the player
  UI visible would be needed).
- **Speed:** with the same mode, JPEG capture finished faster than PNG in every pair (about half the time
  in most, e.g. mode 2: 261 ms vs 622 ms; mode 3: 273 vs 504 ms). The PNG encode inside the capture service
  is a major part of the cost, not only our decode.
- **Periodic capture:** `StartPeriodicCaptureWithoutAppInfo` and `EndPeriodicCapture` both returned success,
  but no new file appeared in the watched directories other than the running session's own captures, so the
  output location is still unknown (inconclusive, not a negative).

Consequence: capture as JPEG and read only the DC coefficient of each 8x8 block (`jpeg-dc.cjs`, 60x34), which
is cheaper than the PNG inflate and unfilter loop and matches how coarsely the analysis samples anyway.
It is opt-in (`/ambilight/capture-format?mode=jpeg`) until compared on the TV. In tests against Pillow the
average error of the 60x34 result is ~0.3 levels without chroma subsampling and 2-5 levels with 4:2:0, with
larger errors only in blocks straddling a hard colour edge.

Experiments (run them while a video is playing; they change nothing and are not used by a session):

- `/ambilight/capture-sweep?w=64&h=36&modes=0,1,2,3,4&comps=0,1,2,3` tries every mode x comp_type and reports
  the reply, returned size, file size, detected format (PNG/JPEG/BMP/...), time, and for PNGs the mean colour
  (all zero would mean that mode leaves out the video).
- `/ambilight/periodic-probe?ms=300&seconds=2` starts a periodic capture, lists new files in a few
  likely directories, and ends it again.

## Making the capture call cheaper (TV measurements)

The TV's system bus is kdbus, so Node cannot talk to it directly; a command-line tool is started per capture.
Per capture (idle): `gdbus` 105 ms / 199 ms CPU, `dbus-send` 97 / 184, **`busctl` 57 / 99**. busctl is now the default
capture tool with automatic fallback to gdbus. Roughly 170 ms of the old 200 ms CPU was starting gdbus itself.

Result of the long-lived capture shells (`busctl-sh`, 29 s session on the TV, JPEG): **9.3 pictures/s at 112% CPU,
capture call 119 ms, decode 14 ms**, against 5.2 pictures/s at ~270% CPU, 250 ms and 23 ms with `gdbus` (about 4x less
CPU per picture; different videos, so indicative). Starting any program from Node costs ~56 ms CPU on this TV; busctl
inside one small shell costs ~30 ms per capture in total.

Direct bus access is not possible from Node on this TV: the system bus and the session bus are both kdbus (no unix socket
exists for either: `/run/user/5001/dbus/user_bus_socket` is missing, no bus proxy under `/run/systemd`), and the capture
service is only on the system bus.

## Capture parameter bench, framebuffer check, proxy probe (TV results)

- **Sizes:** whatever is asked (64x36, 160x90, 240x135, 480x270) comes back as 480x270, ~31-38 ms per capture. Asking for 960x540 or
  1920x1080 returns 720x540 (83 KB, 52 ms, 66 ms DC decode). So nothing smaller than 480x270 can be had, and the service has a fixed
  cost of ~31 ms per capture that does not depend on size.
- **Quality (480x270):** 10/30/60/90 give 3.2/4.6/6.7/16.3 KB and 12/13/14/18 ms DC decode; the capture time stays 31 ms. Quality is
  not a lever.
- **Modes:** modes 2 and 3 take ~31 ms, modes 0 and 1 ~67 ms. app_type 0-3 all gave the same result. The files of modes 1-3 and of
  app types 1-3 had identical sizes (2667 bytes) while mode 0 gave 18445 bytes, but the screen changed during the run, so which mode
  includes Nuvio's own controls is still open (`/ambilight/capture-image?mode=N` shows each as a picture).
- **Framebuffer:** no `/dev/fb0` (`/sys/class/graphics` is empty). `/dev/dri/card0` and `/dev/dri/renderD128` can be opened by the
  service's user (uid 5001); `/dev/video10-61` (V4L2) exist. Reading planes needs ioctls, i.e. native code.
- **Bus proxy:** no `systemd-bus-proxyd` on the TV. `libsystemd.so.0` (0.16.0, systemd 231, includes sd-bus), `libsystemd-shared-231`
  and kdbus-patched `dbus-libs` / `libgio` exist, so a native bridge could use sd-bus in principle.
- **CPU after busctl-sh (43 s session):** 8.5 pictures/s, 82.9% CPU = Node 62.7% + shells 20.2%; capture 105 ms, decode 15 ms.
  The ambilight's own JavaScript (decode, analysis, tick) should be only ~25-30 ms per picture on this TV (measured about 1.5 ms
  on a desktop, ~14-20x slower on the TV), i.e. ~20-25% of a core, so ~40% of a core of Node's load is other work in the same
  process (for example serving the video). The status line now reports the ambilight's JS share separately.

## What each capture mode contains (paused frame with the player controls on screen)

- **mode 0:** everything on screen, including Nuvio's controls (and the screen's letterbox bars); ~67 ms per capture.
- **mode 1:** the picture with the screen's letterbox bars, no controls; ~67 ms.
- **modes 2 and 3:** the video picture only, full-frame, no controls and no screen bars; identical to each other; ~31 ms.
The ambilight uses mode 3 (default; mode 2 looked identical and was used before), so it follows only the video, and it is the fast one.
`/ambilight/capture-mode?mode=N` switches it live.

## Where the capture call time goes (and what is left to win)

- Idle, one capture call went from ~105 ms (gdbus started by Node) to ~31 ms (busctl run from a long-lived shell): about a third.
- A smaller picture or raw pixels cannot make the service faster: the size is ignored (min 480x270), quality does not change the
  time, and only PNG and JPEG exist. "1 ms" was never reachable, the service has to grab and encode a picture.
- Under playback a call takes ~110-190 ms (mode 2) because the service shares the TV with the video; mode 3 is about twice as fast
  there (5 loops: ~180 ms per call and ~26 pictures/s against ~320 ms and ~13.6/s). The service handles one capture at a time.
- Not yet separated: how much of the ~31 ms idle is starting busctl (kdbus connect and login) and how much is the service's own work.
  `/ambilight/capture-floor` measures it (client start, Ping, real capture, each from one shell). The Ping time is the most a permanent
  native connection (no program started per capture) could save; direct access from Node is impossible (kdbus, no proxy), so it would
  need a native helper using libsystemd/sd-bus (present on the TV).

## Ideas not yet tried

- A periodic capture that removes the per-picture `gdbus` process (output location unknown; a wider file search
  or `gdbus monitor` on the service during the call could find it).
- A capture mode that leaves out Nuvio's own controls (compare modes 0-3 with the player UI on screen).
- Measuring JPEG against PNG on the TV (CPU, pictures/s, colour match) and then making JPEG the default.
- Eco pacing (shipped in 1.2.66): fewer captures on still pictures; effect on CPU not yet measured on the TV.
- Offload: a PC/Pi/Home Assistant helper decodes the same stream at low resolution and sends DDP, kept in
  sync by position pings from the TV. Near-zero TV load; needs an always-on machine and a second read of the stream.
- Long shots: JS/WASM software decoding (too slow on this TV), H.264 DC-image extraction (research-grade,
  codec specific).

## Tooling

`tools/html-color-probe/` is the standalone widget that produced the page-side results above.
