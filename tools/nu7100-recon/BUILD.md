# NU-7100-Recon: build, install, run

Read-only capability scanner for the UE49NU7100 (Tizen 4.0). It only reads, and the only files it writes are ones it creates itself under a
unique name (`nu7100-recon-test-<time>`) in `/tmp`, `/dev/shm` and its own temp folder, deleted again straight away. No exploits, no command
execution, no scanning (the only network tests are `http://127.0.0.1/`, `http://localhost/` and one `ws://127.0.0.1/` attempt).

Deviation from the brief: Tizen package ids must be exactly 10 characters, so the ids are package `NU7100Reco`, app `NU7100Reco.Recon`
(`com.research.nu7100recon` would fail to install with error 118019).

## 1. Build (unsigned WGT)

```powershell
cd C:\Users\huuba\Desktop\NuvioTVSmart-Tizen4
git pull origin claude/admiring-lovelace-e1jb4u
npm install
node tools/nu7100-recon/build.mjs
```

Writes `.cache\nu7100-recon\NU-7100-Recon.wgt` (about 20 KB; it is only zipped, never signed here).

Tizen Studio: any version that has `tizen.bat` and `sdb.exe` works; I could not run Tizen Studio in my environment, so signing and
installing are untested by me. Nuvio and the lab use the same commands.

## 2. Sign (needs your author + distributor certificate profile, `NU7100-Nuvio` in the examples)

The TV must be in developer mode with your PC's IP, and the distributor certificate must contain the TV's DUID (same as for Nuvio).

```powershell
$sdb = "C:\tizen-studio\tools\sdb.exe"
$tz  = "C:\tizen-studio\tools\ide\bin\tizen.bat"
$dev = "192.168.129.0:26101"
& $sdb connect $dev
& $tz package -t wgt -s NU7100-Nuvio -o .cache\nu7100-recon\signed -- .cache\nu7100-recon\NU-7100-Recon.wgt
```

## 3. Install, run, uninstall

```powershell
& $tz install -n NU-7100-Recon.wgt -s $dev -- .cache\nu7100-recon\signed
& $tz run -p NU7100Reco.Recon -s $dev
& $tz uninstall -p NU7100Reco -s $dev
```

If the install fails with a privilege error, remove the `productinfo` line in `config.xml` first (it is the only Samsung-specific
privilege) and rebuild.

## 4. What you see

A dark page with RUN ALL TESTS and group buttons. Arrow keys move the focus, ENTER presses, BACK exits. After RUN ALL TESTS the table
fills live (about 60 rows, 1 to 2 minutes), then the summary (Passed / Blocked / Unavailable / Failed), the FINGERPRINT block and the full
JSON in the REPORT box. The two PROBE fields test one explicit path each (default `/dev/shm`; put a file name seen in Nuvio into
"Known dcapture path" and press PROBE to test read + change detection while Nuvio is capturing).

## 5. Report location

EXPORT REPORT writes `nu7100-recon-YYYYMMDD-HHMMSS.json` into the app's `documents` virtual root and prints the exact URI it got. If saving
is refused it says so; the same JSON is always in the REPORT text box (copy it, or photograph the screen). With the URI shown you can fetch
it with `& $sdb pull <path-from-the-uri> .` (if sdb is allowed to read that folder).

## Notes on limits

- A web page can only reach files through `tizen.filesystem`, so "can the WGT see /proc" means "can tizen.filesystem resolve it".
- `window.require`, `process` and `Buffer` almost certainly do not exist in a page; that is exactly what the report will confirm. Node only
  exists inside the packaged web service (which is where Nuvio's capture runs), not in this page.

## v0.2 changes

- Fixed the write test: `openStream`'s 4th argument is the **encoding**, not the mode (v0.1 passed `"w"` there, which is not a
  valid encoding and threw `TypeMismatchError` before anything was written - so the old PASS/PARTIAL verdicts never proved a real
  write). It now writes `NU7100_RECON_TEST`, closes, reopens with a fresh handle, reads it back and checks the bytes match exactly,
  for `/dev/shm`, `/tmp` and `wgt-private-tmp`.
- New **SHARED MEMORY** tests: every non-semaphore `/dev/shm` object found in v0.1 (`shm_ave`, `shm_ave_tddg`, `shm_socpq`,
  `shm_tvsystem`) is read and classified (JPEG/PNG/GZIP/ELF signature, printable/zero-byte ratio). `WK2SharedMemory.inspector.port`
  gets its own probe (hex + text, never interpreted). `sem.DevToolsPort.lock*` gets metadata only, never opened. A **WATCH SHM** field
  polls any one path at 10 Hz for 5 s and reports size/mtime/content changes.
- **Known dcapture path** now has separate READ and WATCH 5 SEC buttons (was one combined probe).
- New `/tmp` one-level inventory of socket/inspector/WebKit-looking names, and a dedicated resolve/stat/open probe for
  `/tmp/fcgi_plugin_0.socket` (never a connection attempt).
- `FINDINGS` block added above the full report: short PASS/FAIL per headline question.
- Deliberately **not** built: raw device-node probing (`/dev/mem`, `/dev/kmem`, `/dev/RAW-mmap`, video device nodes), reading
  `/etc/passwd` or other general system files, `/proc`/`/sys` one-level enumeration, and the API member-recursion scan. None of these
  bear on the ambilight project (the goal of this app), and several (`/dev/mem`, `/dev/kmem`) are exactly the kind of kernel-memory
  access this scanner is meant to stay away from. Ask if you want any of these added back.
