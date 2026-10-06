# Capture Lab (Tizen 4 test app, remote controlled)

A standalone app (id `CaptureLab.Lab`, never touches Nuvio) with its own web service. It plays test clips with
HTML `<video>` and AVPlay, captures the screen through the `dcapture` service with each capture mode, and scores the
pictures against the known colours of the clip (left 20% / middle 60% / right 20% rotate RGB, GBR, BRG every 2 s).
Verdicts: **PASS**, **STATIC** (the same picture over and over, the "frozen blocks" fault), **BLACK**, **WRONG**,
**PLAY FAILED**. Everything is driven from the PC; on the TV you only start the app once.

## Build, sign, install (PowerShell)

```powershell
cd <repo>
git pull origin claude/admiring-lovelace-e1jb4u
npm install
node tools/capture-lab/build.mjs
$tz = "C:\tizen-studio\tools\ide\bin\tizen.bat"
$dev = "192.168.129.0:26101"
& $tz package -t wgt -s NU7100-Nuvio -o .cache\capture-lab\signed -- .cache\capture-lab\CaptureLab.wgt
& $tz install -n CaptureLab.wgt -s $dev -- .cache\capture-lab\signed
& $tz run -p CaptureLab.Lab -s $dev
```

## Run the tests from the PC

```powershell
node tools/capture-lab/lab-cli.mjs status --tv 192.168.129.0
node tools/capture-lab/lab-cli.mjs matrix --tv 192.168.129.0          # clips x engines x modes 1,2,3, cold start each
node tools/capture-lab/lab-cli.mjs research --tv 192.168.129.0
node tools/capture-lab/lab-cli.mjs all --tv 192.168.129.0             # matrix + research with a clip playing
```

Options for `matrix`: `--clips h264-1080p.mp4,hevc-1080p-10bit.mp4 --engines html,avplay --modes 3 --seconds 8 --warm`.
Results are printed and saved as `capture-lab-*.json` in the current folder. Other commands: `info`, `play --clip X --engine html|avplay`,
`stop`, `get /ambilight/state` (any `/ambilight/*` route of the capture service works on port 2720).

Clips are regenerated with `tools/capture-lab/make-media.sh` (needs ffmpeg).
