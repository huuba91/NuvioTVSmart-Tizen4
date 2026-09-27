import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const scriptUrl = new URL("../scripts/deploy-tizen4.ps1", import.meta.url);

test("Tizen deployment retries only Samsung pre-validation error 116", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(script, /\[int\]\$InstallRetryCount = 1/);
  assert.match(script, /\$IsDownload116 = \$InstallText -match "download failed\\\[116\\\]"/);
  assert.match(script, /if \(\$IsDownload116 -and \$InstallAttempt -le \$InstallRetryCount\)/);
  assert.match(script, /install-permit -s \$Device/);
  assert.match(script, /if \(\$InstallExitCode -eq 0\)/);
});
