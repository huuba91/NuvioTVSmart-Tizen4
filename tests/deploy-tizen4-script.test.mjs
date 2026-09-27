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

test("Tizen packaging omits unreachable plugin execution assets when PluginService is disabled", async () => {
  const packageScript = await readFile(new URL("../scripts/package-tizen.mjs", import.meta.url), "utf8");

  assert.match(packageScript, /async function pruneDisabledPluginRuntimeAssets\(\)/);
  assert.match(packageScript, /if \(includePluginService\)[\s\S]*else \{\s*await pruneDisabledPluginRuntimeAssets\(\)/);
  assert.match(packageScript, /if \(!requirePluginService\)[\s\S]*assets\/runtime\/plugin-worker\.js/);
});
