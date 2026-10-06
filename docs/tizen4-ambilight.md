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
only each 8x8 block's DC coefficient (60x34 picture). Switch with `/ambilight/capture-format?mode=jpeg|png&quality=60`
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

## Finding out what the capture service can do

`GET /ambilight/introspect` (any time Nuvio's service is running) lists the methods and arguments of
`samsung.tizen.dcapture` and the other D-Bus services whose names look capture-related. It also writes
the text to `/dev/shm/nuvio-dcapture-introspect.txt` (fetch with `sdb pull`). The current call passes
`0 2 0 <w> <h> 80 <dir> <name>`; knowing the real meaning of those arguments, and whether a raw or BMP
format exists, would let us skip the PNG inflate.

## Known limits

- The capture shows what is on screen, so Nuvio's own player controls and subtitles count
  towards the colours while they are visible.
- Picture-to-light delay is estimated at 0.2-0.35 s (research, not measured).
- Sources: Philips patent US12062220 (dominant colour per zone), Hyperion configuration wiki
  (black borders, smoothing, saturation gain), HyperHDR v22 release notes (linear-light pipeline).
