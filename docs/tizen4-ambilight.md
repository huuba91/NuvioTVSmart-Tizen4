# Tizen 4 ambilight

Optional feature of the Samsung build (UE49NU7100): while Nuvio plays a video, Tuya bulbs and an
8-segment OpenBeken LED strip behind the TV follow the picture. Each bulb follows the left edge, the
right edge or the whole picture (center), or stays off; each strip segment follows the edge of the
picture next to it. With ambilight switched off nothing runs and nothing is sent.

## Architecture

```
 app (Chromium 56)                                 TV service (Node 4, EngineFS listener :2710)
 ───────────────────────────────────────           ───────────────────────────────────────────────
 ambilightSettingsStore.js  (all config)
          │ start / config query
 AmbilightController ─── /ambilight/start|config|pause|resume|blackout|level|ping|stop ──► Session
   ▲ player: playing/pause/error/cleanup                                                     │
   ▲ app: visibilitychange, pagehide, exit                     zone source                   │
   │                                                ┌──────────────────────────────────┐     │
 ZoneSource (future, native) ── /ambilight/zones ──►│ external zones (8 x RGB, frameId) │     │
                                                    │ or screen capture + Analyser      │◄────┘
                                                    └───────────────┬──────────────────┘
                                                      summaries per fresh frame
                                                    (left/center/right + 8 zones)
                                                                    │
                                                     Regions: Oklab spring smoothing (20 Hz tick)
                                                        │                              │
                                              Tuya bulbs (TCP 6668)        strip: DDP over UDP 4048
```

### Zone sources

A zone source turns one fresh frame into summaries: `left`, `center`, `right` for the bulbs and
eight edge `zones` for the strip (`STRIP_ZONES`: tl, t, tr, r, br, b, bl, l). Everything after that
(smoothing, bulbs, strip) does not know where the frame came from (`Session.feed()` in
`services/tizen/runtime/ambilight.cjs`).

- **Screen capture (today, default).** The service calls the TV's own capture service
  (`samsung.tizen.dcapture`, `RequestCaptureToFileSync` through `gdbus`) for a small PNG of the real
  screen in `/dev/shm`. It includes the video plane, so it works for AVPlay and HTML video, any codec
  and resolution. Three overlapped captures give ~9 pictures/s; canvas or WebGL readback of the video
  is blank on this firmware. `ambilight-colour.cjs` (`Analyser`) reduces each picture to summaries.
  The capture idles while the player is paused, while the lights are dark, and while an external
  source feeds zones.
- **External / native source (future).** A Pepper/NaCl module in the app that decodes the video
  itself (H.264 on the hardware decoder, or HEVC with libde265) and reduces each fresh decoded frame
  to 8 zone colours. See "Where a native source plugs in" below.

### Colours (`ambilight-colour.cjs`)

A port of the PC's `screen_sync.py`, so TV and PC look the same:

- dominant colour instead of a plain average: each sample weighs saturation² × value, so vivid,
  bright parts win (a plain average turns most scenes brown-grey); colours are mixed in linear light
  (gamma 2.2);
- one colour, not a blend: vivid samples are binned by hue, the strongest hue family wins (sticky
  at 80% so near-ties don't flip) and other hues stop counting;
- black bars are dropped once their size is stable for 3 pictures; anything unchanged for 10 s
  (logos, a paused player bar) drops to 5% weight;
- bulbs: left/right follow the outer 20% of the moving picture, center the whole picture;
- strip zones are stripes along the edges of the picture without its black bars (top and bottom
  zones: a third of the width × 20% of the height; left/right: 20% of the width × the middle third),
  so every zone is an area statistic over a few hundred samples, never single pixels;
- strip zones also leave out small isolated highlights: samples brighter than the zone's 85th
  percentile + 0.25 (subtitles, UI text, a logo) do not count, so a few bright text pixels cannot
  swing a dark zone; a bright area larger than ~15% of the zone still counts. The bulbs keep the
  untrimmed statistic, exactly as before;
- saturation × 1.5 for the bulbs (faded out on black-and-white video), never darker than 15%; an
  almost entirely white screen switches to warm white, with hysteresis.

### Smoothing

A new frame only moves the target. A 20 Hz tick glides every output towards it with a critically
damped spring in Oklab (chroma kept apart), slow for gradual changes and near-instant on a scene cut.
Bulbs: 0.6 s / 0.08 s (unchanged). Strip: the smoothing setting picks low 0.08 s / 0.04 s,
medium 0.15 s / 0.05 s (default, the previous fixed value) or high 0.6 s / 0.08 s (the bulbs' glide).

### Outputs

- **Tuya bulbs** (unchanged). Local protocol 3.3 over TCP 6668 (AES-128-ECB with each bulb's local
  key), at most 10 colours/s per bulb and never while the previous one is unanswered, heartbeat every
  8 s, reconnect after a drop, UDP discovery when a bulb moved. DP 5 in `rgb8` or `hsv16` (from the
  bulb list or the length of DP 5 in the bulb's own status). The state before the session is
  remembered and restored on stop.
- **Strip** (`ambilight-strip.cjs` + `ddp-packet.cjs`). The 8 zone colours, in the order set by the
  strip's controller end and direction, scaled by brightness and saturation, go out as one DDP packet.

### DDP (`services/tizen/runtime/ddp-packet.cjs`)

OpenBeken runs `startDriver SM16703P; SM16703P_Init 16 BRG; startDriver DDP`: 16 pixels, even ones
the RGB segments, odd ones white chips kept black. One packet = 10 byte header + 48 byte payload:

| bytes | value                                                       |
| ----- | ----------------------------------------------------------- |
| 0     | `0x41` DDP version 1 + push flag                            |
| 1     | sequence 1..15, wrapping (never 0)                          |
| 2     | `0x01` RGB, 8 bit                                           |
| 3     | `0x01` destination: default output                          |
| 4-7   | offset 0 (big endian)                                       |
| 8-9   | length 48 (big endian)                                      |
| 10-57 | zone 1 RGB, black, zone 2 RGB, black, ... zone 8 RGB, black |

`tests/fixtures/ddp-vectors.json` lists zone inputs with the expected payload and packet hex; any
other sender (a future C++ one included) can be tested against the same vectors.

Pacing: a packet goes out only when the output colours differ from the last packet sent; when
nothing changes, at most one keep-alive packet per second. There is no queue: each tick sends the
newest colours or nothing, so a stale frame is never sent after a newer one (the HTTP fallback keeps
a single waiting slot that a newer frame replaces). A health check reads the strip's "DDP received"
counter and falls back from plain UDP to a fresh socket, a bound socket and finally OpenBeken's HTTP
command interface when packets are sent but never counted.

## Configuration

All configuration lives in `js/data/local/ambilightSettingsStore.js` (localStorage key
`ambilightSettings`, version 2), with its defaults there:

| setting                      | default         | UI row (Settings > Playback > Ambilight)    |
| ---------------------------- | --------------- | ------------------------------------------- |
| `enabled`                    | off             | Ambilight                                   |
| `level`                      | 100%            | Overall max brightness (also player Lights) |
| `blackoutOnPause`            | on              | Dark while paused                           |
| `positions`, `maxBrightness` | packaged / 100% | one pair of rows per bulb                   |
| `strip.enabled`              | off             | Surround strip                              |
| `strip.ip`                   | 192.168.129.20  | Strip address                               |
| `strip.port`                 | 4048 (DDP)      | not shown                                   |
| `strip.layout`               | `edges-8`       | Strip layout (8 zones round the edges)      |
| `strip.start`, `.clockwise`  | bottom left, cw | Strip controller end, Strip direction       |
| `strip.level`                | 60%             | Strip max brightness                        |
| `strip.saturation`           | 130%            | Strip saturation (100/115/130/150/170)      |
| `strip.smoothing`            | medium          | Strip smoothing (low/medium/high)           |

The version 1 shape (no version field, no address/port/saturation/smoothing/layout/pause setting)
is migrated on first read with its values kept and the new fields defaulted.

The service keeps no settings: `/ambilight/start` and `/ambilight/config` carry the whole
configuration as query parameters (`level`, `assign`, `pause=black|hold`, `source=capture|external`,
`strip=on|off`, `stripIp`, `ddpPort`, `stripStart`, `stripDir`, `stripBright`, `stripSat`,
`stripSmooth`, `zones`). `/ambilight/config` updates a running session live: a new address or port
reopens the strip's socket, saturation and smoothing apply on the next tick, nothing restarts. The
strip module's own `DEFAULT_IP` is only a last resort when a request names no address.

## Lifecycle

| event                                                                  | app (`AmbilightController`) | service                                            |
| ---------------------------------------------------------------------- | --------------------------- | -------------------------------------------------- |
| first real `playing`                                                   | `start()`                   | `/start`: session, capture, bulbs connect          |
| `playing` after pause / error                                          | `start()` (resumes)         | `/resume`                                          |
| player `pause`                                                         | `pause()`                   | `/pause?mode=black` (dark) or `hold` (last colour) |
| playback error                                                         | `blackout()`                | `/blackout`                                        |
| app hidden (`visibilitychange`)                                        | dark                        | `/blackout`; shown again: `/resume` or `/pause`    |
| player closed (cleanup)                                                | `stop()`                    | `/stop`                                            |
| app exit (`pagehide`, `beforeunload`, `unload`, `nuvio:beforeExitApp`) | stop via `sendBeacon`       | `/stop`                                            |
| settings change                                                        | `updateConfig()`            | `/config`                                          |
| every 3 s                                                              | ping                        | watchdog: stops after 10 s without a ping          |

Blackout (and pause to black) sends 3 black DDP packets 40 ms apart, then black keep-alives; bulbs
are restored to their earlier state as stop does (or switched off when that state is unknown), and
re-enter colour mode on resume. Stop does the same and then closes everything. Control requests are
sent one after another, so a pause never overtakes the resume before it. When a ping or resume
reports that the service no longer has a session (watchdog after a long background, service
restart), the controller starts a new one if the lights are wanted.

Playback always wins: every controller method swallows its own failures, and the player never
awaits the ambilight. The service's 10 s watchdog stays as the safety net when the app dies.

## Where a native source plugs in

App side, `AmbilightController.attachZoneSource(source)` (or `start({ zoneSource })`) accepts an
object with `subscribe(listener) -> unsubscribe`. The listener receives, for every fresh decoded
frame:

```js
{ zones: [[r, g, b] x 8], frameId, ptsMs } // sRGB 0..255, STRIP_ZONES order tl t tr r br b bl l
```

Each zone should be the same kind of area statistic as the capture path (an edge stripe of the
picture without black bars, highlights trimmed). The controller drops malformed frames, frames whose
`frameId` is not higher than the last one, identical zones, and everything while paused or dark; it
keeps one request in flight and lets a newer frame replace a waiting one. It forwards to
`/ambilight/zones?z=<rrggbb x 8>&frame=<n>&pts=<ms>`; the session (started or switched with
`source=external`) stops capturing and feeds the zones through `summariesFromZones()` into the same
smoothing and outputs (bulb left/right = side zones with their corners, center = all eight).
`detachZoneSource()` switches back to the screen capture.

A native module that sends DDP itself would reuse `ddp-packet.cjs`'s layout and pacing rules and
`tests/fixtures/ddp-vectors.json` as its test vectors.

## Setup

1. On the PC, write the bulb list from the tinytuya folder (devices.json, bulbs.py,
   bulb_ips.json, positions.json). Excluded devices in `bulbs.py` (and anything named "groei") are
   never written; bulbs the PC hub has not seen lately start as "off".

   ```
   python scripts/make-ambilight-bulbs.py --tuya-dir "D:\06 ai\Projects\tuya"
   ```

   This writes `ambilight-bulbs.json` in the repo root (git-ignored: it holds local keys).

2. Build and install as usual (`scripts/deploy-tizen4.ps1`). The packager picks up
   `ambilight-bulbs.json` automatically (or `NUVIO_AMBILIGHT_BULBS=<path>`). Every non-Store
   package with the EngineFS service declares the filesystem and system privileges the screen
   capture needs, with or without a bulb list (so an LED-strip-only setup works too). Store builds
   refuse the bulb list and do not declare those privileges.
3. In Nuvio: Settings > Playback > Ambilight. Turn it on, set the overall max brightness, and set
   each bulb to Left, Center, Right or Off with its own max brightness. "Find bulbs" reloads the
   list from the service. For the strip: switch on Surround strip, check Strip address, controller
   end and direction; "Strip status" shows what the strip receives. During playback, More actions >
   Lights (the % button) opens a vertical slider: Up/Down change the overall brightness in 10%
   steps, OK or Back closes it.
4. Stop the PC bulb hub (and screen_sync.py) first: a Tuya bulb accepts one connection at a time.

## Known limits

- The capture shows what is on screen, so Nuvio's own player controls count towards the bulbs'
  colours while they are visible (strip zones trim small bright text, but not large overlays).
- A seek may report a pause first: with "Dark while paused" on, the lights can dip briefly.
- Picture-to-light delay is estimated at 0.2-0.35 s (research, not measured).
- Sources: Philips patent US12062220 (dominant colour per zone), Hyperion configuration wiki
  (black borders, smoothing, saturation gain), HyperHDR v22 release notes (linear-light pipeline).
