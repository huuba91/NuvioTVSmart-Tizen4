# Tizen 4 Streaming Architecture

## Add-on to player data flow

1. `addonRepository` loads a Stremio-compatible `manifest.json`, canonicalizes its base URL, and maps catalogs/resources/types/ID prefixes.
2. `streamRepository` checks whether each add-on's `stream` resource accepts the requested content type and ID, then calls `<addon>/stream/<type>/<id>.json`.
3. Stream objects are normalized by `core/streams/playbackSource.js`. Direct URLs, external URLs, YouTube IDs, torrent hashes, file indexes, behavior hints, tracker sources, and sidecar subtitles remain distinct.
4. The stream UI passes the selected normalized stream to `PlayerScreen.playStreamCandidate()`.
5. Direct non-magnet URLs go straight to `playStreamByUrl()`. Unresolved streams first try the configured debrid resolver and then an enabled platform P2P resolver.
6. `PlayerController` infers HLS, DASH, Smooth Streaming, or progressive-file media type, selects a playback backend, and keeps the source-resolution decision separate from playback.

## Playback backends on Tizen

- Progressive HTTP/HTTPS files: Samsung AVPlay is selected first. A remote failure is reported directly instead of retrying through an HTML video element that is likely to introduce a misleading CORS failure.
- DASH: AVPlay is selected first; dash.js/native playback remain capability-dependent fallbacks.
- HLS: hls.js is preferred on this Tizen 4 target. The physical matrix repeatedly played Google's legal HLS sample with no stalls, while AVPlay could not prepare the tested modern HTTPS origins.
- Local EngineFS URL: AVPlay remains first, with the HTML native-file path available as a local fallback.
- Request headers: AVPlay can receive supported Samsung streaming properties. Headers that cannot be applied directly can use EngineFS if that service starts successfully. The renderer probes EngineFS through loopback, but the AVPlay URL uses the TV LAN address when Samsung's network API exposes it because AVPlay is an external native process on older firmware and cannot be assumed to share renderer loopback.

## Tizen 4 capability boundaries

- Direct URL playback does not require EngineFS or PluginService.
- The currently packaged PluginService is deliberately gated below Tizen 6. User-configured HTTP add-ons still work through the normal application network client; only executable JavaScript scraper plugins are gated.
- Torrent streams are recognized generically by `infoHash`, magnet URI, `fileIdx`, and tracker sources. The packaged EngineFS backend and both local render paths were proven on the physical Tizen 4 target, so production P2P is enabled from Tizen 4 onward when EngineFS is packaged.
- A source that needs an unavailable capability must fail with a controlled compatibility message. It must never be misclassified as a direct URL.

## P2P bridge contract already present

The existing frontend contract expects a loopback HTTP service:

- `POST /<infoHash>/create` with torrent identity, peer-search sources, and optional season/episode file-selection hints.
- `GET /<infoHash>/<fileIdx>?tr=...` as the player-consumable, Range-capable stream URL.
- `GET /<infoHash>/remove` for cancellation and cleanup.
- `GET /settings` as the service health/capability probe.

The frontend validates loopback hosts and does not accept a remote service URL as an on-device P2P backend. Protocol-shape tests use a synthetic hash and nonfunctional `example.test` trackers only.

EngineFS currently reports `cacheSize: 0` (no persistent torrent cache) on the target. Active torrents are removed on source changes, episode changes, playback completion, player cleanup, page exit, and app exit. The live `/<infoHash>/remove` endpoint returned HTTP 200 after the controlled test torrent, validating the cancellation route. This favors predictable storage usage on the constrained 2018 TV.

## Validation gates

- Automated: manifest parsing, resource eligibility, stream normalization, subtitle headers, magnet/direct separation, proxy URL construction, P2P bridge URL construction, player backend selection, build, and WGT packaging.
- Hardware: controlled legal HTTP/HLS/DASH sources, AVPlay buffering/seeking/transport controls, audio/subtitle tracks, suspend/resume, and all P2P behavior.

### Controlled direct-play probe

The fork-only About action **Tizen 4 direct-play test (HTML)** creates a synthetic add-on result, passes it through `mapAddonStream()`, verifies that it classifies as `direct-http`, and routes the normalized candidate through the normal player screen. It uses Blender's official HTTPS Sintel MP4 test asset (`download.blender.org/durian/trailer/sintel_trailer-480p.mp4`), which advertises `video/mp4`, byte ranges, and a content length of approximately 4.2 MB. No hosted Nuvio frontend, external player, piracy-specific provider, or PC-side media server is involved.

The first hardware run selected Samsung AVPlay and remained at `0:00 / 0:00` without loading metadata. Forcing the existing `native-file` browser pipeline against the same W3C URL produced the same result, ruling out an AVPlay-only failure. The next isolation run keeps `native-file` but uses Blender's official host for the same open trailer to separate host/TLS behavior from codec and player behavior. These are diagnostic overrides, not yet a permanent backend policy change.

### Transport matrix result

The controlled range-correct HTTP run now proves both HTML video and AVPlay decode the same compatible H.264 MP4 on the physical UE49NU7100. AVPlay starts approximately one second faster in the first clean comparison and exposes the stronger track/buffering control surface, so it remains the preferred backend. The identical asset fails during AVPlay preparation over direct HTTPS. The first loopback EngineFS proxy URL also fails, so the next hardware candidate advertises EngineFS on the TV's LAN address specifically to AVPlay while retaining loopback-only health checks in the web application. These findings do not justify a PC-hosted production dependency; the LAN server is only a controlled diagnostic oracle.

### Controlled P2P lifecycle result

The official Creative Commons WebTorrent Sintel torrent (`08ada5a7a6183aae1e09d831df6748d566095a10`) resolved entirely on the TV. EngineFS selected `Sintel.mp4`, served byte ranges locally, and both HTML video and AVPlay started in about one second with the real 888064 ms duration. A follow-up lifecycle matrix proved AVPlay pause/resume with zero clock drift, seek to 120000 ms, and continued playback beyond 122000 ms. HTML pause/resume worked, but its seek stalled near 59500 ms. Therefore AVPlay is the production P2P backend and HTML remains a startup fallback with a documented seeking limitation.
