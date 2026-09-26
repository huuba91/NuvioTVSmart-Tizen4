import assert from "node:assert/strict";
import test from "node:test";

import { getTizenCapabilities } from "../js/platform/tizen/tizenCapabilities.js";

function tizenRuntime(version, { webService = true, packaged = true } = {}) {
  return {
    __NUVIO_PLATFORM__: "tizen",
    __NUVIO_TIZEN_ENGINEFS_SERVICE_ENABLED__: packaged,
    navigator: {
      userAgent: `Mozilla/5.0 (SMART-TV; LINUX; Tizen ${version}) AppleWebKit/537.36 Version/${version} TV Safari/537.36`
    },
    tizen: {
      systeminfo: {
        getCapability(name) {
          if (name.endsWith("platform.version")) return version;
          if (name.endsWith("web.service")) return webService;
          return null;
        }
      }
    }
  };
}

test("Tizen 4 supports packaged EngineFS P2P while retaining newer-feature gates", () => {
  const capabilities = getTizenCapabilities(tizenRuntime("4.0"));

  assert.equal(capabilities.isTizen, true);
  assert.equal(capabilities.tizenMajorVersion, 4);
  assert.equal(capabilities.supportsWebService, true);
  assert.equal(capabilities.supportsP2p, true);
  assert.equal(capabilities.tizenPluginVersionSupported, false);
  assert.equal(capabilities.supportsTizenAvPlayDashAudioSwitching, false);
});

test("Tizen services fail closed when they are not packaged", () => {
  const capabilities = getTizenCapabilities(tizenRuntime("6.0", { packaged: false }));

  assert.equal(capabilities.supportsWebService, false);
  assert.equal(capabilities.supportsP2p, false);
});

test("modern non-Tizen browsers retain plugin support", () => {
  const capabilities = getTizenCapabilities({
    navigator: { userAgent: "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36" }
  });

  assert.equal(capabilities.isTizen, false);
  assert.equal(capabilities.tizenPluginVersionSupported, true);
});
