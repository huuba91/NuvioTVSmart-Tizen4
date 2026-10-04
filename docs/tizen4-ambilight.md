# Tizen 4 ambilight

Tuya bulbs follow the picture while Nuvio plays a video on the UE49NU7100. Each bulb follows the
left half, the right half or the whole picture (center), or stays off.

## How it works

- **Capture.** The EngineFS web service calls the TV's own capture service
  (`samsung.tizen.dcapture`, `RequestCaptureToFileSync` through `gdbus`) for a small PNG of the
  real screen in `/dev/shm`. It includes the video plane, so it works for AVPlay and HTML video,
  any codec and resolution. Two captures run overlapped (~9 pictures/s, ~43% CPU in research);
  canvas or WebGL readback of the video is blank on this firmware.
- **Colours.** The service decodes the PNG and averages the left half, the right half and both
  (center), scaled by the brightness setting.
- **Bulbs.** The service talks Tuya local protocol 3.3 directly (TCP 6668, AES-128-ECB with each
  bulb's local key). It remembers each bulb's state before taking it and restores it on stop.
  If a bulb is not at its packaged address, it listens for the bulbs' UDP announcements once.
- **Lifecycle.** The player starts the session on the first real `playing` event and stops it in
  its cleanup. The app pings every 3 s; the service stops by itself after 10 s without a ping,
  and when the service exits.
- Routes share the EngineFS listener on 2710 (`/ambilight/bulbs|start|ping|stop|state`) because
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
3. In Nuvio: Settings > Playback > Ambilight. Turn it on, pick a brightness, and set each bulb to
   Left, Center, Right or Off. "Find bulbs" reloads the list from the service.
4. Stop the PC bulb hub (and screen_sync.py) first: a Tuya bulb accepts one connection at a time.

## Known limits

- The capture shows what is on screen, so Nuvio's own player controls and subtitles count
  towards the colours while they are visible.
- Picture-to-light delay is estimated at 0.2-0.35 s (research, not measured).
- Position changes apply the next time playback starts.
