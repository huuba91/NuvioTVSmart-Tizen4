# Documentation map

**Production (how the shipped app works)**

- [player-architecture.md](player-architecture.md): PlayerController, stream inspection, backend decision, backends, fallbacks.
- [tizen4-ambilight.md](tizen4-ambilight.md): ambilight sources, zone pipeline, DDP strip, Tuya bulbs, settings, lifecycle.
- [native-ambilight-plan.md](native-ambilight-plan.md): the hidden Pepper analysis module (H.264 hardware decode, HEVC via libde265) and its TV checkpoints.
- [tizen4-streaming-architecture.md](tizen4-streaming-architecture.md): addon streams, EngineFS, the /media proxy.
- [tizen4-validation-matrix.md](tizen4-validation-matrix.md): release gates and hardware checks.
- [nuvio-production-cleanup.md](nuvio-production-cleanup.md): what was kept, moved and deleted, build flavours, WGT size.

**Developer diagnostics** live outside the package: `tools/` (see tools/README.md) and the dev-diagnostics build (`npm run package:tizen:dev`, `deploy-tizen4.ps1 -DevDiagnostics`).

**Historical research** (diaries and findings, not a description of current code): [research/](research/).
