# Native ambilight analysis (Pepper) — design and plan

Status: design agreed (hybrid), native sources not yet in this repository. This document is the
contract the native module has to meet; the JavaScript side it plugs into already exists.

## Decision: hybrid

AVPlay (or hls.js / dash.js / the HTML5 element, as chosen by `decidePlayback`) always owns the
picture, audio, subtitles, seeking and track selection. A hidden Pepper (NaCl, Pepper 56, ARMv7)
module decodes the same stream a second time **only to compute the eight ambilight zone colours**.
It never draws video and playback never waits for it. If it fails, ambilight falls back to the
service's screen capture (`ambilightSource: "screen-capture"`), and if that fails the lights go dark.

A full Pepper H.264 player (own demuxer, audio, A/V sync, subtitles) was considered and rejected for
now: it would regress working playback for no user-visible gain. It can still be added later as one
more backend behind `PlayerController` (see [player-architecture.md](player-architecture.md)).

## What is already proven on the UE49NU7100 (see the Pepper video decoding manual)

| Fact                                                                                                                                          | Evidence                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Pepper 56 ARM NEXE runs from an ordinary WGT                                                                                                  | D265Bench1 and pepper56 probes                              |
| `PPB_VideoDecoder` H.264, hardware-only, returns `GL_TEXTURE_EXTERNAL_OES` pictures that can be sampled and must be recycled                  | 1,499 pictures in 10 s, 0 GL errors (Baseline profile clip) |
| `PPB_VideoDecoder` has no HEVC profile; profile 13 → `PP_ERROR_BADARGUMENT`                                                                   | probe report                                                |
| Samsung NaCl `MediaPlayer` plays HEVC but exposes no decoded frame                                                                            | hevc_probe                                                  |
| libde265 (portable, 1 thread) decodes 640×360 HEVC at 133 fps unpaced, ~50 fresh samples/s paced; DDP from the NEXE via `pp::UDPSocket` works | D265Bench1 modes 1–4                                        |

Not proven, and therefore TV checkpoints below:

1. `PPB_VideoDecoder` working **while AVPlay holds the hardware decoder** (the SoC may have one
   instance).
2. H.264 **High** profile (real releases) on `PPB_VideoDecoder` (only Baseline was tested).
3. libde265 speed on real content. HEVC cannot be decoded below its coded size, so the 640×360
   result does not carry over: 1080p is ~9× and 2160p ~36× the work. Rough expectation from the
   unpaced figure: ~15 fps at 1080p on one thread, a few fps at 2160p (inferred, not measured).
   Main10 (10-bit HDR) support in libde265 1.0.16 is unverified.
4. A UDP socket from the NEXE to the TV service on loopback (the service side would bind a UDP port;
   Tizen 4 refused a second TCP listener, UDP is untested).

## Data flow

```
stream URL (same one AVPlay plays)
   │  PPB_URLLoader range reads (EngineFS torrents: served from the local engine, no extra internet)
   ▼
demux (MKV / MP4 only; HLS, DASH, TS stay on screen capture)
   │  video packets + PTS, codec config (avcC / hvcC → Annex-B)
   ├─ H.264 → PPB_VideoDecoder (HW) → OES texture → GPU downscale → edge strips readback (a few hundred px)
   └─ HEVC  → libde265 worker thread (YUV planes, no RGB frame) → sparse edge sampling
   ▼
8 zone colours per fresh picture, robust statistic (trimmed / percentile-aware, as the service does)
   ▼  paced to the player clock (JS posts AVPlay currentTime ~4×/s; samples are released at their PTS,
   ▼  late ones are dropped, never queued)
TV service colour engine + DDP sender (ambilight-strip.cjs / ddp-packet.cjs) and Tuya bulbs
```

The colour engine, smoothing, saturation, brightness, DDP packet format and the bulbs stay in **one
place**: the Node service. The NEXE only produces zone colours. Transport, in order of preference:

1. NEXE → service over loopback UDP (one 24-byte datagram per picture plus a frame id and PTS);
   needs checkpoint item 4.
2. NEXE → JS `PostMessage` → `AmbilightController.attachZoneSource()` → service `/ambilight/zones`
   (already implemented and tested; costs one HTTP request per picture on the TV).

If the shared engine ever becomes the bottleneck, the NEXE may send DDP itself; it must then build
packets from `tests/fixtures/ddp-vectors.json` exactly as `ddp-packet.cjs` does.

## Lifecycle rules

- Created by the player only when `getPlaybackInfo().decision.ambilightSource` is `pepper-h264` or
  `libde265-hevc`; the embed is 1×1 and off-screen. Capabilities `pepperAnalysis.{h264,hevc,
hevcMaxHeight}` turn on only after the module reports it loaded and passed its self-check.
- Seek: JS sends `seek(t)`; the module flushes the decoder (`Reset` / `de265_reset`), clears queues,
  demuxes from the keyframe at or before `t`, and drops samples until the clock reaches them.
- Pause: the module stops reading and decoding; lights follow `blackoutOnPause` in the service.
- Stream switch / stop / app hide / exit: the module is destroyed (decoder, GL context, worker
  thread, loaders released); a new one is created for the next stream. No module is ever reused
  across streams.
- Falling behind: HEVC skips to the next keyframe when it is more than ~0.5 s behind the clock. If
  fresh samples stay below ~10/s for 5 s, the module reports `degraded` and the controller switches
  to screen capture for the rest of that stream.
- Resolution change mid-stream: reinitialise the decoder (H.264) or let libde265 reconfigure; the
  sampler reads the plane sizes per picture.

## Repository layout (once the sources arrive)

```
native/
  README.md                build on the developer PC (WSL + pepper_56 SDK), ncval, outputs
  third_party/libde265-1.0.16/   upstream source + licence
  src/
    module.cc              pp::Module / pp::Instance, JS messaging
    demux/mkv.cc mp4.cc    minimal demuxers (video track only)
    h264_gpu_sampler.cc    PPB_VideoDecoder + Graphics3D + edge reduction
    hevc_sampler.cc        libde265 worker + sparse YUV sampling
    zones.cc               zone statistics shared by both paths
    clock.cc               PTS pacing against the player clock
  build/                   build scripts (portable and NEON libde265 archives, NEXE link, NMF)
diagnostics/pepper/        the historical probes and the D265Bench app (never packaged)
```

The packager adds `nuvio-analysis.nmf` and the NEXE closure to the WGT only when the built files
exist; a WGT without them behaves exactly as today.

## Order of work and TV checkpoints

| Step                                                                                          | Done where                     | TV checkpoint |
| --------------------------------------------------------------------------------------------- | ------------------------------ | ------------- |
| Sources committed under `native/` and `diagnostics/pepper/`                                   | Huub's PC                      | —             |
| Probe: `PPB_VideoDecoder` H.264 High while AVPlay plays a stream; loopback UDP to the service | PC build, small diagnostic WGT | B             |
| H.264 analysis module (demux MP4/MKV, HW decode, GPU sampling, pacing)                        | cloud writes code, PC builds   | C             |
| HEVC playback unchanged on AVPlay                                                             | —                              | D             |
| libde265 analysis module, measured on real 1080p and 2160p releases                           | cloud writes code, PC builds   | E             |
| Seek / pause / resume / stream switch with the module running                                 | —                              | F             |
| Two-hour playback, memory and temperature                                                     | —                              | G             |
