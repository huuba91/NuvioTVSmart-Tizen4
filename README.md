<div align="center">

  <img src="assets/brand/app_logo_wordmark.png" alt="Nuvio" width="300" />

  <p>
    A free, open-source media app for your phone, your desktop, and the TV you already own.
    <br />
    Bring your own sources. Nuvio turns them into a library with artwork, ratings, subtitles, and your place saved on every screen.
  </p>

[Website](https://nuvio.tv) · [GitHub releases](https://github.com/NuvioMedia/NuvioTVSmart/releases/latest) · [Support Nuvio](https://nuvio.tv/support)

</div>

## Get Nuvio TV

Nuvio TV supports **Samsung Tizen TVs from 2018 onward (Tizen 4+)** and **LG webOS TVs from 2020 onward (webOS 5+)**.
The startup compatibility baseline is Samsung Tizen 4.0 / Chromium 56 and LG webOS 5.0 / Chromium 68 when the platform reports those versions.

Platform capabilities are intentionally version-dependent:

- **Samsung Tizen 4.x** — direct and torrent/P2P playback are supported through the bundled local EngineFS service. Some advanced audio and subtitle features may still be limited.
- **Samsung Tizen 5.x, including 5.5** — torrent/P2P playback is supported through the bundled local EngineFS service only. The PluginService, plugin execution, and remote plugin pull/push synchronization are disabled; the Plugins screen is not available.
  The Node 4.4.3 service runtime observed on Tizen 5.5 is incompatible with the current PluginService syntax and URL APIs. Experimental legacy transports are not included; plugin support starts at Tizen 6.0.
- **Samsung Tizen 6+** — torrent/P2P and the packaged PluginService are supported. Plugin execution requires the packaged service plus the TV runtime's Worker and WebAssembly support. Tizen 6 and later use the same current Tizen service pipeline.
- **LG webOS 5.x** — torrent/P2P and the packaged plugin service are supported, with the limited plugin resource quotas used by the older webOS runtime.
- **LG webOS 6+** — torrent/P2P and the packaged plugin service are supported with the modern plugin resource quotas.

On Tizen 4+ and LG webOS, torrent/P2P uses only the bundled local companion service; no external torrent streaming server is configured or required.

- [Nuvio TV Installer](https://github.com/NuvioMedia/NuvioTVSmart/releases/latest) for Windows, macOS, and Linux
- [Samsung Tizen WGT](https://github.com/NuvioMedia/NuvioTVSmart/releases/latest) for manual installation
- [LG webOS Homebrew repository](https://raw.githubusercontent.com/NuvioMedia/NuvioTVWebOS/main/webosbrew/apps.json)
- [LG webOS IPK](https://github.com/NuvioMedia/NuvioTVSmart/releases/latest) for manual installation

## Build from source

```bash
git clone https://github.com/NuvioMedia/NuvioTVSmart.git NuvioTVSmart
cd NuvioTVSmart
npm install
npm run build
```

Build TV packages with:

```bash
npm run package:tizen
npm run package:tizen:store
npm run package:webos
```

`package:tizen` creates the unsigned WGT used by development and the Nuvio TV Installer. The installer signs it locally for the target TV before installation. `package:tizen:store` is a separate Seller Office build: it requires Tizen Studio/Web CLI and a configured security profile, and creates the signed Store package with the local EngineFS service included so Tizen 4+ retains torrent/P2P playback. Nuvio TV is built with JavaScript, HTML, CSS, and platform TV APIs. Building requires Node.js and npm; package installation additionally requires the relevant Tizen or webOS tools.

## UE49NU7100 development deployment

This fork is hosted at [huuba91/NuvioTVSmart-Tizen4](https://github.com/huuba91/NuvioTVSmart-Tizen4). It keeps the original Nuvio project as the `upstream` remote, the hardware-validated compatibility baseline on `tizen4/nu7100`, and independently reviewable feature work on short-lived branches such as `feature/live-hub`. On Windows, the complete build/sign/connect/install/launch loop is:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-tizen4.ps1 -Launch
```

The script builds from source, packages the WGT with EngineFS and without the unsupported Tizen 4 PluginService, verifies the configured runtime environment, signs into a separate staging directory with the existing `NU7100-Nuvio` profile, verifies both signature files, refreshes the TV's temporary install permission, installs, and optionally launches. Override `-Device`, `-DeviceName`, `-SigningProfile`, or `-TizenStudio` when needed. `-FollowLogs` attaches the Samsung device log after launch. `-IncludePluginService` exists only for explicit compatibility experiments and is not used for this TV.

The signed development artifact is written to `.cache/tizen4-deploy/NuvioTV001_<version>.wgt`. The low-level `scripts/package-tizen.mjs` command now rejects stale frontend output; use `npm run package:tizen` unless a diagnostic workflow has explicitly run `npm run build` first.

`npm run package:tizen` and the deploy script build the production flavour. For the developer-diagnostics flavour (Settings > About > Console debug and the EngineFS `/netcheck` self-test) use `npm run package:tizen:dev` or `deploy-tizen4.ps1 -DevDiagnostics`; see [docs/nuvio-production-cleanup.md](docs/nuvio-production-cleanup.md).

Samsung author/distributor certificates, private keys, profile exports, `local.properties`, generated WGTs, build output, and deployment caches are excluded from Git. The deployment script only references an existing signing profile and never creates or modifies signing identities.

## Tizen 4 architecture and validation

- [Streaming and P2P architecture](docs/tizen4-streaming-architecture.md)
- [Hardware engineering log (research)](docs/research/tizen4-engineering-log.md)
- [Production cleanup and build flavours](docs/nuvio-production-cleanup.md)
- [Release validation matrix](docs/tizen4-validation-matrix.md)

The app remains a locally packaged frontend. User-configured Stremio-compatible HTTP add-ons flow through manifest/resource validation, normalized stream objects, resolver selection, and the shared player. Progressive MP4 uses AVPlay first; HLS and DASH use the hardware-tested MSE paths on this TV. Torrent sources use the packaged on-TV EngineFS service and expose a local byte-range stream to AVPlay—no PC, phone, cloud transcoder, or external streaming server is required after installation.

The physical UE49NU7100 has validated QR login, controlled direct HTTP MP4, HLS, DASH, EngineFS torrent metadata/file selection/range delivery, torrent playback, pause/resume, a two-minute torrent seek, and torrent cancellation. AVPlay is required for reliable torrent seeking; the HTML-video fallback can start the tested MP4 but did not complete the same seek. Tizen 4 executable scraper plugins remain disabled, while ordinary remote HTTP add-ons remain supported.

## Updating from upstream

Keep compatibility work isolated and replay it onto an inspected upstream update:

```bash
git fetch upstream
git switch tizen4/nu7100
git rebase upstream/main
npm test
npm run lint
npm run package:tizen
```

Resolve upstream player/service changes in the centralized Tizen capability, EngineFS, playback-proxy, and player-engine layers instead of adding scattered model checks. After every rebase, repeat the signed deployment and the relevant hardware checks; desktop tests do not establish Tizen 4 media compatibility.

Push maintained compatibility work to the public fork rather than to the upstream repository. Merge feature branches into `tizen4/nu7100` only after their automated checks pass and their navigation/playback path has been exercised on the UE49NU7100. Keep `upstream` reserved for fetching and rebasing original Nuvio changes.

## License

[GNU General Public License v3.0](./LICENSE)
