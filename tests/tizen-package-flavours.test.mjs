import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ambilightCapturePrivileges,
  buildConfigXml,
  buildMainJs,
  includesAmbilightRuntime,
  tizenPackageExcludedPaths
} from "../scripts/package-tizen.mjs";

const configFor = ({ storeBuild = false, includeEngineFsService = true } = {}) =>
  buildConfigXml({
    appId: "NuvioTV001.NuvioTV",
    packageId: "NuvioTV001",
    version: "1.2.65",
    includeEngineFsService,
    includePluginService: true,
    includeAmbilight: includesAmbilightRuntime({ includeEngineFsService, storeBuild })
  });

test("production Tizen package leaves out netcheck.cjs and the webOS runtime", () => {
  const excluded = tizenPackageExcludedPaths();
  assert.ok(excluded.includes("services/tizen/runtime/netcheck.cjs"));
  assert.ok(excluded.includes("assets/libs/webOSTV.js"));
});

test("developer-diagnostics Tizen package keeps netcheck.cjs but still drops webOSTV.js", () => {
  const excluded = tizenPackageExcludedPaths({ devDiagnostics: true });
  assert.ok(!excluded.includes("services/tizen/runtime/netcheck.cjs"));
  assert.ok(excluded.includes("assets/libs/webOSTV.js"));
});

test("capture privileges follow the ambilight runtime, not the bulb list", () => {
  const xml = configFor();
  for (const privilege of ambilightCapturePrivileges) {
    assert.match(xml, new RegExp(`<tizen:privilege name="${privilege.replace(/\./g, "\\.")}"/>`));
  }
  assert.match(xml, /developer\.samsung\.com\/privilege\/network\.public/);
});

test("Store packages and packages without EngineFS declare no capture privileges", () => {
  for (const xml of [
    configFor({ storeBuild: true }),
    configFor({ includeEngineFsService: false })
  ]) {
    for (const privilege of ambilightCapturePrivileges) {
      assert.ok(!xml.includes(privilege), `${privilege} must not be declared`);
    }
  }
});

test("generated bootstrap carries no research-harness hooks", () => {
  const mainJs = buildMainJs({
    packageId: "NuvioTV001",
    includeEngineFsService: true,
    includePluginService: false,
    appBundleFileName: "app.bundle.0123456789abcdef.js",
    runtimeEnvFileName: "nuvio.env.0123456789abcdef.js"
  });
  assert.doesNotMatch(mainJs, /MATRIX|REPORT_STAGE|XMLHttpRequest/);
});

test("build exposes the developer-diagnostics define and the dev package script", async () => {
  const buildScript = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.match(buildScript, /NUVIO_DEV_DIAGNOSTICS/);
  assert.match(buildScript, /__NUVIO_DEV_DIAGNOSTICS__: JSON\.stringify\(devDiagnostics\)/);
  assert.doesNotMatch(buildScript, /NUVIO_TIZEN4_PROBE_MEDIA_FILE/);
  assert.match(packageJson.scripts["package:tizen:dev"], /package-tizen\.mjs --dev-diagnostics/);
  assert.doesNotMatch(packageJson.scripts["package:tizen"], /dev-diagnostics/);
});

test("EngineFS registers /netcheck only when netcheck.cjs is packaged", async () => {
  const service = await readFile(
    new URL("../services/tizen/enginefs-service.js", import.meta.url),
    "utf8"
  );
  assert.match(
    service,
    /existsSync\(require\("path"\)\.join\(__dirname, "runtime", "netcheck\.cjs"\)\)/
  );
  assert.match(service, /if \(netcheckAvailable && requestUrl === "\/netcheck"\)/);
});
