# UE49NU7100 / Tizen 4 validation matrix

This matrix is the release gate for the `tizen4/nu7100` branch. A passing desktop test is not a substitute for a hardware result. Status meanings:

- **Verified** — observed on the physical Samsung UE49NU7100 or established by an inspected release artifact.
- **Automated** — covered by the repository test/build/package pipeline, but not sufficient by itself for TV behavior.
- **Pending hardware** — still requires a precise run on the physical TV before the maintained fork can be called fully validated.

## Milestone status

| Milestone | Status | Authoritative evidence | Remaining gate |
| --- | --- | --- | --- |
| 1. Tizen 4 compatibility base | Verified | Locally packaged frontend installs and launches; QR renders and completes account linking; guest mode and remote navigation have been exercised. The build emits compatibility assets for Chromium 56 and hashes mutable boot assets to prevent WRT cache reuse. | Include close/relaunch and persisted-session checks in the final reliability pass. |
| 2. Add-on/source pipeline | Verified | Controlled sources and real user-installed add-ons traverse manifest validation, normalized stream objects, resolver selection, and the shared player. Protected live-sports HLS now plays through its add-on-aware request path. | Recheck one direct and one live add-on source after each upstream player rebase. |
| 3. Direct playback | Partially verified | Physical matrices proved controlled H.264 MP4 through HTML and AVPlay, HLS through hls.js/MSE, and DASH through dash.js/MSE with time progression and zero-stall runs. | Exercise subtitle selection, alternate audio selection, normal player seek, suspend/resume, and network-loss recovery on hardware. |
| 4. Local P2P investigation | Verified | EngineFS and PluginService contracts, Tizen service constraints, NaCl, WebAssembly, local HTTP paths, AVPlay, and MSE alternatives are documented in the engineering log and architecture document. Tizen 4 can run packaged EngineFS; executable scraper plugins remain disabled. | None for the investigation decision. |
| 5. P2P proof of concept | Verified | Creative Commons Sintel resolved on-device, selected `Sintel.mp4`, connected to peers, served byte ranges, and played through both HTML video and AVPlay on the TV. | None for the controlled proof. |
| 6. P2P integration | Verified with limitation | Normal torrent sources use packaged EngineFS, automatic media-file selection, local range playback, AVPlay preference, cancellation, and cleanup identity. Hardware validated pause/resume, a seek to two minutes, continued playback, and torrent removal. | HTML fallback seeking remains unreliable; AVPlay is the maintained seeking backend. Recheck episode-file selection when a legal multi-file episodic fixture is available. |
| 7. TV UX/reliability | Partially verified | NU7100-responsive sizing, lazy artwork, bounded catalog work, remote navigation, player controls, loading states, P2P cancellation, and source failover are implemented. The Live hub focus/cleanup regression has automated coverage. | Run the final hardware checklist below, including the newly installed Live hub fix. |
| 8. Release/maintainability | Verified except final acceptance | Public fork and upstream remote exist; commits are logically separated; build, packaging, deployment, architecture, engineering history, limitations, security boundaries, and rebase workflow are documented. Deployment signs with the existing `NU7100-Nuvio` profile and verifies signatures without modifying the identity. | Merge `feature/live-hub` only after its hardware checklist passes, then produce and retain the final signed development WGT from that merged revision. |

## Final hardware checklist

Record the app version, commit, and result in the engineering log for every run.

### Startup and state

- [ ] Launch the app from Samsung Home, close it, and launch it again.
- [ ] Confirm the linked account/session survives relaunch.
- [ ] Confirm installed add-ons and selected profile survive relaunch.
- [ ] Put the TV/app into the background during browsing and playback, then resume without a broken focus layer or orphaned audio.

### Remote and navigation

- [ ] Navigate Home, Search, Library, Live, Settings, profile selection, and back using only the Samsung remote.
- [ ] Open **Live**, open an event, press Back to return to Live, then return Home. Profile selection must not open accidentally and no Live UI may overlap Home.
- [ ] Traverse a long catalog row and a long vertical page; focus must remain visible and restore sensibly after returning from details.
- [ ] Open and dismiss source selection and error dialogs; Back must dismiss the current layer before changing routes.

### Direct and adaptive playback

- [ ] Play a controlled MP4, pause/resume, seek, and exit.
- [ ] Play a legal HLS stream and a legal DASH stream through the normal source flow.
- [ ] Select an alternate audio track when the fixture provides one.
- [ ] Enable, change, and disable subtitles when the fixture provides them.
- [ ] Temporarily interrupt the network during playback and verify a bounded recovery or useful error instead of an indefinite spinner.

### Torrent/P2P playback

- [x] Resolve and play the Creative Commons Sintel torrent without a PC/server after installation.
- [x] Pause/resume and seek to two minutes through AVPlay.
- [x] Stop playback and confirm the controlled torrent is removed.
- [ ] Relaunch after interrupted torrent playback and confirm no abandoned transfer resumes indefinitely.

## Automated release gate

Before a hardware candidate is signed and installed:

```powershell
npm test
npm run lint
npm run package:tizen
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-tizen4.ps1 -Launch
```

The deploy script must use the existing `NU7100-Nuvio` profile. Generated WGTs, certificate material, private keys, profile exports, deployment caches, and `local.properties` must remain outside Git.
