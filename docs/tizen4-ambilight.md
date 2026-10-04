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
  - pixels unchanged for 10 s (black bars, logos, a paused player bar) drop to 5% weight, like
    Hyperion's black-border detection;
  - saturation × 1.5, faded out on black-and-white video; never darker than 15%;
  - an almost entirely white screen switches to the bulb's own warm white, with hysteresis.
- **Smooth fades without extra captures.** A new picture only moves the target. A 20 Hz tick
  glides every bulb towards it with a critically damped spring in Oklab (0.6 s for gradual
  changes, 0.08 s on a scene cut), so the bulbs pass through intermediate colours between
  captures. Identical values are not resent, and a bulb never flips straight back to the step it
  just left within 0.5 s (anti-shimmer).
- **Brightness.** An overall cap (Settings, or the Lights slider in the player's More actions,
  live) times each bulb's own cap (Settings).
- **Bulbs.** The service talks Tuya local protocol 3.3 directly (TCP 6668, AES-128-ECB with each
  bulb's local key). It remembers each bulb's state before taking it and restores it on stop.
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

## Known limits

- The capture shows what is on screen, so Nuvio's own player controls and subtitles count
  towards the colours while they are visible.
- Picture-to-light delay is estimated at 0.2-0.35 s (research, not measured).
- Sources: Philips patent US12062220 (dominant colour per zone), Hyperion configuration wiki
  (black borders, smoothing, saturation gain), HyperHDR v22 release notes (linear-light pipeline).
