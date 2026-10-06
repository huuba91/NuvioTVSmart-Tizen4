# Tizen 4 ambilight

Tuya bulbs follow the picture while Nuvio plays a video on the UE49NU7100. Each bulb follows the
left edge, the right edge or the whole picture (center), or stays off.

## How it works

- **Capture.** The EngineFS web service calls the TV's own capture service
  (`samsung.tizen.dcapture`, `RequestCaptureToFileSync` through `gdbus`) for a small PNG of the
  real screen in `/dev/shm`. It includes the video plane, so it works for AVPlay and HTML video,
  any codec and resolution. Two captures run overlapped (~9 pictures/s, ~43% CPU in research);
  canvas or WebGL readback of the video is blank on this firmware.
- **Colours.** `runtime/ambilight-colour.cjs` is a port of the PC's `screen_sync.py`, so TV and
  PC look the same:
  - dominant colour instead of a plain average: each pixel weighs saturation² × value, so vivid,
    bright parts win (Philips' dominant colour; a plain average turns most scenes brown-grey);
  - colours mixed in linear light (gamma 2.2), as HyperHDR does;
  - left/right follow the outer 20% of the moving picture, center the whole picture;
  - one colour, not a blend: vivid pixels are binned by hue, the strongest hue family wins (it
    keeps the previous one while that has 80% of the winner's weight, so near-ties don't flip)
    and other hues stop counting; red next to blue gives red or blue, never purple (Philips'
    dominant colour, HyperHDR's dominant-colour mode);
  - black bars are dropped as soon as their size is stable for 3 pictures (Hyperion's
    black-border detector), and anything unchanged for 10 s (logos, a paused player bar) drops to
    5% weight;
  - saturation × 1.5, faded out on black-and-white video; never darker than 15%;
  - an almost entirely white screen switches to the bulb's own warm white, with hysteresis.
- **Eco pacing.** A still or slowly changing picture needs far fewer captures than a busy one, since
  the colours glide between pictures anyway. Each picture is compared with the previous one (mean
  change per byte, 0-255, jumping up at once on a cut and decaying 15% per picture): below 0.6 the
  service captures about 3 pictures/s, below 2.5 about 6/s, otherwise flat out (~9/s). Turn it off
  with `/ambilight/eco?mode=off` to compare. The settings line under Ambilight now shows pictures/s,
  mode, CPU (service plus its gdbus children, share of one core) and the gdbus/decode times.
- **Smooth fades without extra captures.** A new picture only moves the target. A 20 Hz tick
  glides every bulb towards it with a critically damped spring in Oklab (0.6 s for gradual
  changes, 0.08 s on a scene cut), so the bulbs pass through intermediate colours between
  captures. Identical values are not resent, and a bulb never flips straight back to the step it
  just left within 0.5 s (anti-shimmer).
- **Brightness.** An overall cap (Settings, or the Lights slider in the player's More actions,
  live) times each bulb's own cap (Settings).
- **Bulbs.** The service talks Tuya local protocol 3.3 directly (TCP 6668, AES-128-ECB with each
  bulb's local key). DP 5 comes in two formats: classic `rrggbbhhhhssvv` (0-255) and
  `hhhhssssvvvv` (0-1000, bulbs with `colour_data_v2`). A bulb sent the wrong one still changes
  colour but ignores brightness, so the format comes from the bulb list (written from the wizard's
  data points) or else from the length of DP 5 in the bulb's own status. `/ambilight/state` shows
  each bulb's format and the last value sent. It remembers each bulb's state before taking it and restores it on stop.
  If a bulb is not at its packaged address, it listens for the bulbs' UDP announcements once.
- **Lifecycle.** The player starts the session on the first real `playing` event and stops it in
  its cleanup. The app pings every 3 s; the service stops by itself after 10 s without a ping,
  and when the service exits.
- Routes share the EngineFS listener on 2710 (`/ambilight/bulbs|start|level|ping|stop|state`) because
  Tizen 4 refuses a second listener in the same service sandbox. They never return keys.

## Setup

1. On the PC, write the bulb list from the tinytuya folder (devices.json, bulbs.py,
   bulb_ips.json, positions.json). Excluded devices in `bulbs.py` (and anything named "groei") are
   never written; bulbs the PC hub has not seen lately start as "off".

   ```
   python scripts/make-ambilight-bulbs.py --tuya-dir "D:\06 ai\Projects\tuya"
   ```

   This writes `ambilight-bulbs.json` in the repo root (git-ignored: it holds local keys).
2. Build and install as usual (`scripts/deploy-tizen4.ps1`). The packager picks up
   `ambilight-bulbs.json` automatically (or `NUVIO_AMBILIGHT_BULBS=<path>`) and then also declares
   the filesystem and system privileges the research app used. Store builds refuse the file.
3. In Nuvio: Settings > Playback > Ambilight. Turn it on, set the overall max brightness, and set
   each bulb to Left, Center, Right or Off with its own max brightness. "Find bulbs" reloads the
   list from the service. During playback, More actions > Lights (the % button) opens a vertical
   slider: Up/Down change the overall brightness in 10% steps, OK or Back closes it.
4. Stop the PC bulb hub (and screen_sync.py) first: a Tuya bulb accepts one connection at a time.

## Capture format

`RequestCaptureToFileSync(app_type, capture_mode, comp_type, width, height, jpeg_quality, dir, name)`: the
service uses `0, 2, comp_type, 64, 36, quality`. The size is ignored (always 480x270). `comp_type` 0 is PNG, 1 is JPEG (default since the TV measurements: capture 250 vs 696 ms, decode 23 vs 188 ms,
analysis 10 vs 47 ms; ~10x smaller files). All capture files live in `/dev/shm`, which is RAM, not flash. JPEG is decoded by `runtime/jpeg-dc.cjs`, which reads
only each 8x8 block's DC coefficient (60x34 picture). Switch with `/ambilight/capture-format?mode=jpeg|png&quality=40` (default quality 40)
(reset when the service restarts); three decode failures switch back to PNG on their own. The Strip status line
shows the format and picture size in use. Any three JPEG failures in a row (the service refusing it, or a file
that cannot be decoded) switch back to PNG. `/ambilight/jpeg-sample` takes one JPEG now, keeps it as
`/dev/shm/nuvio-sample.jpg`, and reports its structure (frame type, sampling, scans), whether it decodes and how long it took.

## Direct system-bus access (experiment)

Each capture currently spawns `gdbus`, which on the TV is likely the largest CPU cost (the status line showed
~270% of one core, of which the service's own decode and analysis is under half a core).
`runtime/dbus-lite.cjs` is a small D-Bus client (EXTERNAL auth, int/string calls) that would keep one connection open
and call `RequestCaptureToFileSync` on it instead. It was verified against a real `dbus-daemon` and byte-exact
messages from an independent implementation, but not yet on the TV, where the open question is whether the service
sandbox may open the system bus socket. `GET /ambilight/dbus-probe?count=10` answers that: it reports the socket
files, whether connecting and authenticating works, and time and CPU per capture for the direct path against `gdbus`
(run it with no session active so the figures are not mixed with a session's own captures). Nothing uses the client yet.

### TV results: the system bus is kdbus, so busctl is used

`/ambilight/dbus-where` on the UE49NU7100: the system bus is **kdbus** (`/sys/fs/kdbus/0-system/bus`, `kdbusfs` mounted;
`DBUS_SESSION_BUS_ADDRESS=kernel:path=/sys/fs/kdbus/5001-user/bus;unix:path=/run/user/5001/dbus/user_bus_socket`). kdbus
is spoken through kernel calls that Node cannot make, which is why no unix socket exists and why the direct client
(`dbus-lite.cjs`) cannot connect on this TV. It is kept for TVs with a classic bus, nothing uses it.

`/ambilight/capture-tools` (10 captures, idle, read + decode included):

| tool | ms per capture | CPU ms per capture |
| --- | --- | --- |
| gdbus (was used) | 105 | 199 |
| gdbus, lean GIO environment | 102 | 193 |
| dbus-send | 97 | 184 |
| **busctl** | **57** | **99** |

Second round (same TV): starting a trivial program (`true`) from Node costs **~56 ms CPU** per call, more than half of
busctl's 110 ms (incl. ~25 ms read + decode); busctl run ten times inside one small shell cost **~30 ms per capture**.
Node's process starts are expensive because Node is a big process. So each capture worker now keeps one long-lived
`sh` (`CaptureShell`) that runs busctl per request line (`comp quality w h dir name` in, busctl's reply and
`__DONE__ <exit code>` out). It ends by itself when Node goes away. The status line's CPU figure includes these shells
(their busctl children only show up in Node's own figures once the shell exits, so /proc is read for the live shells).

Capture tool chain, each step falling back to the next after three failures in a row (or at once when the tool is
missing): `busctl-sh` (default) -> `busctl` started by Node -> `gdbus`, the way the ambilight was validated with.
`/ambilight/capture-tool?mode=busctl-sh|busctl|gdbus` forces one.

`/ambilight/periodic-probe` (3 s): `StartPeriodicCaptureWithoutAppInfo(iiiisi)` returned an empty reply and
`EndPeriodicCapture(isi)` returned 0, so both exist, but no new file appeared anywhere under /dev/shm, /tmp, /run,
/var/tmp, /opt/usr/media, /opt/media, /home/owner/share (3 levels deep), and `busctl monitor` is refused
("Operation not permitted"), so where a periodic capture delivers its pictures, if anywhere, is still unknown.
`/ambilight/dbus-where` also checks the session bus (see below) for the capture service.

### Next idea: systemd-bus-proxyd

kdbus clients on a classic socket are what `systemd-bus-proxyd` was made for: it is handed an accepted unix socket as its
stdin/stdout, speaks D-Bus to the client and kdbus to the kernel. If the TV has it, `dbus-lite.cjs` could keep one connection
open and call the capture service in-process (~1 ms instead of ~30 ms of busctl per capture, no per-capture processes).
`GET /ambilight/bus-proxy-probe?count=10` searches for the binary (and libsystemd/sd-bus files), runs it for one
connection with and without `--address=kernel:path=/sys/fs/kdbus/0-system/bus`, says Hello through it and makes captures,
reporting each attempt's stage, the proxy's stderr, time per capture and CPU of the proxy and of Node. Tested here against a stand-in
proxy and bus (not against kdbus, and on a newer Node than the TV's 4.4.3). Other ideas considered: a persistent C bridge
(needs a binary built for the TV and permission to execute it) and an FFI library such as Koffi (needs N-API, Node 8+; the TV has Node 4).

### Reconsidered ideas (parameters, native decode, framebuffer, DC coefficients)

- **Smaller picture / raw pixels from the capture service.** Width and height are not honoured (a request for 64x36 returned 480x270
  for every mode tried) and `comp_type` 2 and 3 fail with -6, so the sweep found no raw format. Not yet tried: sizes other than
  64x36, other `app_type` values, quality below 60. `GET /ambilight/capture-bench?group=sizes|quality|modes|all` measures all of
  these from one shell (time and CPU per capture, size and format of what comes back, DC-decode time). Note that the service's
  idle cost per capture is ~30 ms for the whole call, so JPEG encoding is not necessarily the dominant part.
- **Decode and averaging in a native bridge.** The decode half is already cheap: `jpeg-dc.cjs` reads only each block's DC
  coefficient (14 ms on the TV; the Huffman pass over the AC coefficients cannot be skipped because it is how the next DC is
  found). A C bridge with libjpeg-turbo's 1/8 scaling would take that to ~1-2 ms, but needs a toolchain, the TV's libraries and
  permission to run our binary, for a saving of roughly 25-35 ms of ~120 ms CPU per picture. The analysis is also not a plain
  average of 8 zones (dominant colour, black bars, Oklab smoothing), so a 24-byte result would lose that unless it were ported too.
- **Framebuffer / DRM.** `GET /ambilight/fb-check` lists the graphics device files and permissions and tries to open `/dev/fb0` and
  `/dev/dri/card0`. Even if readable, video is drawn on a separate hardware plane, so the framebuffer is expected to lack the
  picture (the same reason canvas readback is black); this settles it cheaply.
- **JPEG DC coefficients.** Already in use (`jpeg-dc.cjs`), see Capture format.
- The status line now splits CPU into Node and the capture shells.

### Regression report (mode 3 default + faster decoder shipped together)

After that deploy the lights lit while the movie loaded and then stopped (status: session of 10 s, ended by watchdog, 1 frame sent to
the strip, 71% still pictures), and a second run stayed on one solid purple (97% still). The two changes were not separated, and the
watchdog ending suggests the app itself may have closed or hung (the service stops after 10 s without a ping). Safeguards added:
mode 2 is the default again (3 stays one URL away); the first pictures of every run are decoded by the fast decoder and by the
original simple one (`jpeg-dc-reference.cjs`) and compared, and any difference or exception switches to the reference decoder for
good; the status line shows the decoder in use, the average colour of the last picture and why the session ended.

### Mode 3 and the live dials

Mode 3 works too (verified live: lights followed the movie, no errors) and looks identical to mode 2; mode 2 stays the default.
In `/ambilight/capture-compare` on a moving scene modes 2 and 3 show the picture stretched to the full frame without the
screen's letterbox bars (so the strip's edge zones are the real picture edges), modes 0 and 1 show the bars. State of a movie at
mode 2: 10.1 pictures/s, CPU 96.9% = Node 73.1% (ambilight JS 24.2%: decode 13.5, analyse 9.2, tick 1.4) + shells 23.7%, so ~49% of
Node's one thread is other work and only ~27% is left: roughly 14-15 pictures/s is where this thread saturates. The faster
JPEG decoder did not give the desktop's 2.5x on the TV (decode is still ~13 ms per picture), so measure on the TV, not the desktop.
Live dials (all reset when the service restarts), and `capture.recent` in `/ambilight/state` reports the last ~10 s (rate, CPU, Node,
shells, ambilight JS) so a change can be judged within seconds:
`/ambilight/eco?mode=on|off`, `/ambilight/capture-workers?count=1..8`, `/ambilight/capture-mode?mode=0..3`.

### Live tuning on the TV: mode 3 is twice as fast under playback

Measured with `capture.recent` (the percentages in the first version of that field were 1000x too large; the figures below are
corrected) while a movie played. Mode 2, 3 loops: 13.5 pictures/s, CPU 188%, Node 156%, ambilight JS 65%, shells 32%, capture
175-190 ms. Eco off changed nothing (13.5/s). 5 loops in mode 2 changed nothing either (13.3-13.6/s) but each capture took
~320 ms: the capture service handles one capture at a time. Mode 3 with 5 loops: ~25.8/s, capture ~180 ms, CPU 276%, Node 216%,
ambilight JS 90%, shells 60%. So mode 3 captures about twice as fast and fresher, at the price of load: the ambilight's JavaScript
needs ~48 ms per picture under playback (twice the idle figure) and at ~26/s takes ~90% of a core. Node's total CPU exceeds 100% (it
uses several threads), so what matters for stutter is the main thread, not that total.

Defaults now: mode 3, 3 loops, eco on, a cap of 15 pictures/s for all loops together (`/ambilight/capture-rate?max=N`, 0 = no cap),
and a watchdog of 30 s. The earlier failure (lights lit during loading and stopped when the movie started, session ended by the
10 s watchdog) fits a starved app thread at movie start; the cap keeps the load near the known-good level (~190% at 13.5/s) and
the longer watchdog stops a short stall from ending a working session.

### Where the CPU goes now (TV, paused/still picture, 3.6 pictures/s)

Status line: 45.4% CPU = Node 36% (ambilight JS 9.6%: decode 6, analyse 2.5, tick 1.1) + shells 8.7%. About 26% of a core of
Node's load is not the ambilight (the same process hosts the media service), and per picture the ambilight needs ~24 ms of
JavaScript (~17 decode, ~7 analysis) plus ~24 ms in the shell. Node runs it on one thread, so decoding was the biggest piece.
`jpeg-dc.cjs` now decodes the Huffman codes through a 9-bit lookup table instead of bit by bit: identical output on 106 test
JPEGs (qualities 10-95, 4:4:4/4:2:2/4:2:0, restart markers, noisy content, odd sizes) and ~2.5x faster on a desktop. The colour
analysis was profiled too (68% of it is the per-region loops); precomputing hue cos/sin gave only 6%, so it was left alone.

## Finding out what the capture service can do

`GET /ambilight/introspect` (any time Nuvio's service is running) lists the methods and arguments of
`samsung.tizen.dcapture` and the other D-Bus services whose names look capture-related. It also writes
the text to `/dev/shm/nuvio-dcapture-introspect.txt` (fetch with `sdb pull`). The current call passes
`0 2 0 <w> <h> 80 <dir> <name>`; knowing the real meaning of those arguments, and whether a raw or BMP
format exists, would let us skip the PNG inflate.

## Known limits

- Capture mode 3 (now the default; it looked identical to mode 2 and is believed to also leave out subtitles) is the video picture only: on a paused frame with the player controls on screen, modes 2 and 3
  showed the picture full-frame without controls and without the screen's letterbox bars, while mode 0 includes the controls
  and mode 1 the letterbox bars (`/ambilight/capture-compare`, UE49NU7100). So Nuvio's controls do not count towards the colours.
  (Whether subtitles drawn by Nuvio are excluded too was not checked separately; bars baked into the video file itself still
  show up and are handled by the black-bar detection.)
- Picture-to-light delay is estimated at 0.2-0.35 s (research, not measured).
- Sources: Philips patent US12062220 (dominant colour per zone), Hyperion configuration wiki
  (black borders, smoothing, saturation gain), HyperHDR v22 release notes (linear-light pipeline).
