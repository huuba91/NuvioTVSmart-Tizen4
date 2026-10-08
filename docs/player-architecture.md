# Player architecture

This document describes how Nuvio plays a stream: which layer decides what, which engine (backend) owns the picture, and
where future ambilight analysis modules plug in. It applies to the Tizen 4 build (Samsung UE49NU7100, Chromium 56) and to
webOS/browser builds that share the same code.

## Layers

```
 Player UI  (js/ui/screens/player/playerScreenMethods-*, playerVideo*Handlers.js)
     │  play/pause/seek, state reads, PlayerController.on/off
     ▼
 PlayerController  (js/core/player/playerController.js + playerControllerMethods-01..21)
     │  orchestration: proxies, engine ladder, fallbacks, progress, tracks
     ├──► inspection   js/core/player/inspection/streamInspection.js   inspectStream()
     ├──► decision     js/core/player/backends/playbackDecision.js      decidePlayback()
     │                 js/core/player/backends/engineCandidates.js      engine ladder (pure)
     ▼
 Backends  (js/core/player/backends/)
     ├── avplayBackend.js   Samsung webapis.avplay ("tizen-avplay")
     └── html5Backend.js    <video>: native-file / native-hls / native-dash, hls.js, dash.js (MSE)

 AmbilightController  (js/core/ambilight/ambilightController.js) ── beside the player, never in its path
```

- **UI** never calls `webapis.avplay` and no longer reads playback state from the `<video>` element. It reads state from
  `PlayerController` (`getCurrentTimeSeconds`, `getDurationSeconds`, `getPlaybackRate`, `getPlaybackReadyState`,
  `isPlaybackEnded`, `isMediaElementPaused`, `getMediaElementErrorCode`, `getMediaNetworkState`, ...) and subscribes to
  neutral events with `PlayerController.on/off`. It still uses the element for DOM layout (see "Remaining element uses").
- **PlayerController** stays the single orchestrator. `play()` resolves the source type, computes the inspection and
  decision **once per load**, resolves the Tizen/webOS proxy, starts the preferred engine and applies the in-call
  fallbacks. It keeps `playbackInspection`, `playbackDecision` and `playbackFallbackHistory` for the current load.
- **Inspection** (`inspectStream(stream, context)`) is pure and metadata-only: add-on/debrid metadata, `behaviorHints`
  (filename, videoSize), stream name/title/description, URL extension/query, the resolved source type and, once known,
  engine-reported tracks. It never touches the network.
- **Decision** (`decidePlayback(inspection, capabilities, settings)`) is pure. It returns the engine ladder, the preferred
  engine and the ambilight analysis source, with human-readable reasons.
- **Backends** are thin adapters over existing controller methods. They add no engine logic.
- **AmbilightController** runs beside the player. It is started by the player UI when real playback is reported and it
  must never delay or stop playback.

## Backend interface

`js/core/player/backends/playerBackend.js` documents the interface (JSDoc `PlayerBackend`):

| Method                                                         | AVPlay adapter                                       | HTML5 adapter                          |
| -------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| `load(url, options)`                                           | `PlayerController.play(url, {forceEngine})`          | same, with the HTML5 engine name       |
| `play()` / `pause()` / `stop()`                                | `resume()` / `pause()` / `stop()`                    | same                                   |
| `seek(seconds)`                                                | `seekToSeconds()`                                    | same                                   |
| `setVolume(level)` / `getVolume()`                             | `false` / `null` (TV system volume)                  | element `volume`                       |
| `getDuration()` / `getCurrentTime()`                           | AVPlay timeline via controller                       | element via controller                 |
| `getBufferedRanges()`                                          | `[]` (AVPlay reports only buffering progress)        | element `buffered` as `{start, end}[]` |
| `isPaused()` / `isSeeking()` / `isEnded()` / `getReadyState()` | AVPlay state / seek-in-flight / controller           | element / controller                   |
| `getAudioTracks()` / `selectAudioTrack(i)`                     | `getAvPlayAudioTracks` / `setAvPlayAudioTrack`       | hls.js / dash.js / native audio tracks |
| `getSubtitleTracks()` / `selectSubtitleTrack(i)`               | `getAvPlaySubtitleTracks` / `setAvPlaySubtitleTrack` | hls.js / dash.js / element text tracks |
| `on(event, fn)` / `off(event, fn)`                             | `PlayerController.on/off`                            | same                                   |

`PlayerController.getActiveBackend()` returns the adapter for the current engine (`null` when nothing plays).
`PlayerController.getPlaybackInfo()` returns `{ backend, engine, inspection, decision, fallbackHistory }`.

### Events

`PlayerController.on(event, fn)` / `off(event, fn)` emit the same events whatever engine is active: `loading`, `ready`,
`playing`, `paused`, `seeking`, `seeked`, `timeupdate`, `buffering`, `ended`, `error`, `tracks`. The payload is
`{ type, engine, backend, sourceEvent, detail }`.

AVPlay, hls.js and dash.js already report through `emitVideoEvent()` on the `<video id="videoPlayer">` element, so a
single bridge (`bindPlayerEventBridge()`, bound in `init()`) maps element events to neutral events:
`canplay→ready`, `playing→playing`, `pause→paused`, `seeking/seeked`, `timeupdate`, `waiting→buffering`, `ended`,
`error`, and `loadedmetadata/avplaytrackschanged/hlstrackschanged/dashtrackschanged→tracks`. `loading` is emitted by
`play()`. A throwing handler is reported with `console.warn` and never affects playback or other handlers.

## Inspection

`inspectStream()` returns `{container, videoCodec, bitDepth, hdr, height, frameRate, audioCodecs[], streamType,
sourceKind, mimeType, isLive, isRemoteDirectHttp, fileSizeBytes, confidence, sources[]}`.

Confidence per field, strongest first:

| Confidence | Comes from                                                                               |
| ---------- | ---------------------------------------------------------------------------------------- |
| `metadata` | engine-reported tracks, declared MIME/codecs string, debrid/add-on parsed release fields |
| `filename` | release tokens in `behaviorHints.filename`, debrid file name, URL path/extension         |
| `text`     | release tokens in stream name/title/description                                          |
| `unknown`  | nothing found                                                                            |

Recognised tokens: `x265/HEVC/H.265/H265`, `x264/AVC/H.264/H264`, `AV1`, `VP9`, `MPEG-2`; `10bit/10-bit/Hi10/Main10`;
`HDR/HDR10/HDR10+/DV/DoVi/Dolby Vision/HLG` (HDR implies 10-bit when no depth is named); `2160p/4K/UHD/1080p/720p/480p`
and `WxH`; `23.976/24/25/30/50/60fps` and `1080p60`; `AAC/AC3/DD/EAC3/DDP/DD+/DTS/DTS-HD/TrueHD/Atmos/Opus/FLAC/MP3`.
`sources[]` lists every value found and its origin, so you can see why a field has its value. Resolution parsing reuses
`resolutionFromText()` from `js/core/debrid/streamResolution.js`; source classification reuses `classifyPlaybackSource()`.

When the engine reports its tracks (`avplaytrackschanged`, hls.js levels, element `videoHeight`), the inspection is
refined with `metadata` confidence. The decision for the load is **not** recomputed.

## Decision table

The engine ladder is the pre-refactor `getPlaybackEngineCandidates()` code, moved unchanged to
`engineCandidates.js`. `getPlaybackEngineCandidates()`, `choosePlaybackEngine()` and `decidePlayback()` all call it.
`tests/playback-decision.test.mjs` compares it against a verbatim copy of the 1.2.65 code for every combination of
9 capability flags × 17 representative sources × 4 item types (34,816 cases).

Samsung UE49NU7100 (Tizen 4: AVPlay available, hls.js/MSE available, no native HLS/DASH in `<video>`):

| Source                       | Engine ladder                 | Starts with    |
| ---------------------------- | ----------------------------- | -------------- |
| remote progressive (mkv/mp4) | `tizen-avplay`                | `tizen-avplay` |
| local EngineFS / proxy file  | `tizen-avplay`, `native-file` | `tizen-avplay` |
| HLS VOD or live              | `hls.js`, `tizen-avplay`      | `hls.js`       |
| DASH VOD                     | `tizen-avplay`, `dash.js`     | `tizen-avplay` |
| Smooth Streaming             | `tizen-avplay`                | `tizen-avplay` |

A forced engine (`forceEngine`, used by diagnostics and by engine-switch replays) wins over the automatic choice and the
reasons say so. Ambilight analysis never changes the engine ladder.

### Ambilight source

| Condition (first match wins)                                                                                        | `ambilightSource` |
| ------------------------------------------------------------------------------------------------------------------- | ----------------- |
| ambilight disabled in settings                                                                                      | `off`             |
| no screen capture and no Pepper analysis on this platform                                                           | `off`             |
| `pepperAnalysis.h264` and codec `h264` with `metadata`/`filename` confidence                                        | `pepper-h264`     |
| `pepperAnalysis.hevc`, codec `hevc` (`metadata`/`filename`), 8-bit or unknown depth, known height ≤ `hevcMaxHeight` | `libde265-hevc`   |
| screen capture available (the EngineFS service capture used today)                                                  | `screen-capture`  |
| otherwise                                                                                                           | `off`             |

Today `pepperAnalysis` is `{h264: false, hevc: false, hevcMaxHeight: 0}`, so production behaviour is `screen-capture` on
Tizen when ambilight is on, and `off` elsewhere. The decision is informational: `AmbilightController` still starts the
service capture exactly as before.

## Fallback rules

Unchanged engine behaviour; every engine change is now recorded:

- Inside `play()`: AVPlay start failure → native element (`avplay-start-failed`, never for remote progressive Tizen
  sources); hls.js start failure → native HLS; dash.js start failure → native DASH; Tizen proxy unavailable for HLS →
  AVPlay when it preserves every header; native "unsupported source" → hls.js / dash.js / AVPlay.
- From the UI: startup error or startup/playback stall → `getAlternativePlaybackEngine()` → replay with `forceEngine`
  (`startup-error mediaErrorCode=N`, `startup-stall`, `playback-stall`); the user's "switch player" action
  (`user-requested-engine-switch`).
- A forced engine never falls through to another engine (`canFallbackFromPlaybackEngine`). On Tizen, an hls.js session
  behind the header proxy never falls back (would lose headers).

`recordPlaybackFallback(from, to, reason)` appends `{from, to, reason, at}` to `fallbackHistory` (last 20) and logs one
line: `Playback engine fallback: <from> -> <to> (<reason>)`. Nothing is shown to the user. A forced replay of the same
source keeps the load's inspection, decision and history; a new automatic load resets them.

Known pre-existing quirk (not changed): `attemptVideoPlay()` returns the `play()` promise from a `then` handler, so a
rejected `video.play()` reaches the final `catch` and the `onRejected` fallbacks in `play()` do not run. The UI's
startup-error/stall fallbacks cover these cases.

## Hybrid rule and future Pepper analysis

AVPlay or the HTML5 element **always** owns picture, audio and subtitles. Ambilight analysis is optional and must never
block, delay or replace playback.

Planned (not implemented): a Pepper/NaCl module that decodes the same stream a second time purely to compute ambilight
colours — H.264 on the hardware decoder (`pepper-h264`) or HEVC 8-bit up to a height limit with libde265
(`libde265-hevc`) — while AVPlay keeps playing. It plugs in here:

1. The module reports what it can do; the build sets `PlayerController.pepperAnalysisCapabilities =
{h264, hevc, hevcMaxHeight}`.
2. `decidePlayback()` picks `ambilightSource` from the inspection. The engine ladder is unaffected.
3. `AmbilightController` reads `PlayerController.getPlaybackInfo().decision.ambilightSource` and starts either the
   Pepper analysis or the existing service screen capture. If the analysis fails to load or falls behind, it switches
   to `screen-capture` or `off`; playback is not touched.
4. `PlayerController.on("seeked" | "paused" | "playing" | "ended")` keeps the analysis in sync with the picture without
   reading the `<video>` element or AVPlay directly.

## Remaining element uses in the player UI

These stay on `<video id="videoPlayer">` on purpose (DOM, not playback state):

| File                              | Use                                                             | Why it stays                                   |
| --------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| `playerScreenMethods-64` (aspect) | `videoWidth/Height`, pixel aspect, `style` transform            | layout of the element itself                   |
| `playerScreenMethods-45`          | `calculateAspectRect(mode, video)` for bitmap subtitles         | layout                                         |
| `playerScreenMethods-29`          | fullscreen `style` box for post-play mini window                | layout                                         |
| `playerScreenMethods-24`          | `createMediaElementSource(video)` (WebAudio gain), subtitle CSS | WebAudio needs the element; styling            |
| `playerScreenMethods-43`          | ASS renderer bound to the element                               | renderer draws over the element                |
| `playerScreenMethods-55`, `-68`   | append `<track>` nodes                                          | DOM                                            |
| `playerScreenMethods-12`          | `textTracks`/`audioTracks` lists (HTML5 track discovery)        | HTML5-only track lists and their events        |
| `playerScreenMethods-27`          | element event binding (incl. AVPlay/hls.js synthetic events)    | handlers need engine-specific events/details   |
| `playerScreenMethods-32`          | DIAG PKG3 overlay, `commitSeekPreview` element presence check   | diagnostic overlay is being removed separately |
| `playerScreenMethods-05`          | post-play trailer `<video>`                                     | a separate element                             |
