# Tizen 4 playback findings (research)

Historical record moved out of `docs/tizen4-streaming-architecture.md`. The About actions and harnesses mentioned below (direct-play probe `PKG3`, playback matrix `MATRIX5`) no longer exist in the app; the day-by-day log is in [tizen4-engineering-log.md](tizen4-engineering-log.md).

## Controlled direct-play probe

The fork-only About action **Tizen 4 direct-play test (HTML)** creates a synthetic add-on result, passes it through `mapAddonStream()`, verifies that it classifies as `direct-http`, and routes the normalized candidate through the normal player screen. It uses Blender's official HTTPS Sintel MP4 test asset (`download.blender.org/durian/trailer/sintel_trailer-480p.mp4`), which advertises `video/mp4`, byte ranges, and a content length of approximately 4.2 MB. No hosted Nuvio frontend, external player, piracy-specific provider, or PC-side media server is involved.

The first hardware run selected Samsung AVPlay and remained at `0:00 / 0:00` without loading metadata. Forcing the existing `native-file` browser pipeline against the same W3C URL produced the same result, ruling out an AVPlay-only failure. The next isolation run keeps `native-file` but uses Blender's official host for the same open trailer to separate host/TLS behavior from codec and player behavior. These are diagnostic overrides, not yet a permanent backend policy change.

## Transport matrix result

The controlled range-correct HTTP run now proves both HTML video and AVPlay decode the same compatible H.264 MP4 on the physical UE49NU7100. AVPlay starts approximately one second faster in the first clean comparison and exposes the stronger track/buffering control surface, so it remains the preferred backend. The identical asset fails during AVPlay preparation over direct HTTPS. The first loopback EngineFS proxy URL also fails, so the next hardware candidate advertises EngineFS on the TV's LAN address specifically to AVPlay while retaining loopback-only health checks in the web application. These findings do not justify a PC-hosted production dependency; the LAN server is only a controlled diagnostic oracle.

## Controlled P2P lifecycle result

The official Creative Commons WebTorrent Sintel torrent (`08ada5a7a6183aae1e09d831df6748d566095a10`) resolved entirely on the TV. EngineFS selected `Sintel.mp4`, served byte ranges locally, and both HTML video and AVPlay started in about one second with the real 888064 ms duration. A follow-up lifecycle matrix proved AVPlay pause/resume with zero clock drift, seek to 120000 ms, and continued playback beyond 122000 ms. HTML pause/resume worked, but its seek stalled near 59500 ms. Therefore AVPlay is the production P2P backend and HTML remains a startup fallback with a documented seeking limitation.
