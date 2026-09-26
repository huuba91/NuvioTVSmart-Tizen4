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
- HLS: the current upstream order can select hls.js before AVPlay when Media Source Extensions are detected. This needs physical Tizen 4 comparison before the fork changes the default because upstream documents AVPlay connection failures on some Samsung models.
- Local EngineFS URL: AVPlay remains first, with the HTML native-file path available as a local fallback.
- Request headers: AVPlay can receive supported Samsung streaming properties. Headers that cannot be applied directly can use EngineFS if that service starts successfully. The renderer probes EngineFS through loopback, but the AVPlay URL uses the TV LAN address when Samsung's network API exposes it because AVPlay is an external native process on older firmware and cannot be assumed to share renderer loopback.

## Tizen 4 capability boundaries

- Direct URL playback does not require EngineFS or PluginService.
- The currently packaged PluginService is deliberately gated below Tizen 6. User-configured HTTP add-ons still work through the normal application network client; only executable JavaScript scraper plugins are gated.
- Torrent streams are recognized generically by `infoHash`, magnet URI, `fileIdx`, and tracker sources. The current Tizen resolver is deliberately gated below Tizen 5 until an on-device backend is proven on this model.
- A source that needs an unavailable capability must fail with a controlled compatibility message. It must never be misclassified as a direct URL.

## P2P bridge contract already present

The existing frontend contract expects a loopback HTTP service:

- `POST /<infoHash>/create` with torrent identity, peer-search sources, and optional season/episode file-selection hints.
- `GET /<infoHash>/<fileIdx>?tr=...` as the player-consumable, Range-capable stream URL.
- `GET /<infoHash>/remove` for cancellation and cleanup.
- `GET /settings` as the service health/capability probe.

The frontend validates loopback hosts and does not accept a remote service URL as an on-device P2P backend. Protocol-shape tests use a synthetic hash and nonfunctional `example.test` trackers only.

## Validation gates

- Automated: manifest parsing, resource eligibility, stream normalization, subtitle headers, magnet/direct separation, proxy URL construction, P2P bridge URL construction, player backend selection, build, and WGT packaging.
- Hardware: controlled legal HTTP/HLS/DASH sources, AVPlay buffering/seeking/transport controls, audio/subtitle tracks, suspend/resume, and all P2P behavior.

### Controlled direct-play probe

The fork-only About action **Tizen 4 direct-play test (HTML)** creates a synthetic add-on result, passes it through `mapAddonStream()`, verifies that it classifies as `direct-http`, and routes the normalized candidate through the normal player screen. It uses Blender's official HTTPS Sintel MP4 test asset (`download.blender.org/durian/trailer/sintel_trailer-480p.mp4`), which advertises `video/mp4`, byte ranges, and a content length of approximately 4.2 MB. No hosted Nuvio frontend, external player, piracy-specific provider, or PC-side media server is involved.

The first hardware run selected Samsung AVPlay and remained at `0:00 / 0:00` without loading metadata. Forcing the existing `native-file` browser pipeline against the same W3C URL produced the same result, ruling out an AVPlay-only failure. The next isolation run keeps `native-file` but uses Blender's official host for the same open trailer to separate host/TLS behavior from codec and player behavior. These are diagnostic overrides, not yet a permanent backend policy change.

### Transport matrix result

The controlled range-correct HTTP run now proves both HTML video and AVPlay decode the same compatible H.264 MP4 on the physical UE49NU7100. AVPlay starts approximately one second faster in the first clean comparison and exposes the stronger track/buffering control surface, so it remains the preferred backend. The identical asset fails during AVPlay preparation over direct HTTPS. The first loopback EngineFS proxy URL also fails, so the next hardware candidate advertises EngineFS on the TV's LAN address specifically to AVPlay while retaining loopback-only health checks in the web application. These findings do not justify a PC-hosted production dependency; the LAN server is only a controlled diagnostic oracle.
