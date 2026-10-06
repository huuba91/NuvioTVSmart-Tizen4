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
