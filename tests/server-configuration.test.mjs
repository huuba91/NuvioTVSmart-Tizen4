import assert from "node:assert/strict";
import test from "node:test";

import {
  createServerConfiguration,
  supportsEmailPasswordAuth
} from "../js/core/server/serverConfiguration.js";

function configuration({ isCustom = false, emailPasswordAuth = false } = {}) {
  return createServerConfiguration({
    backendUrl: "https://auth.example.test",
    publishableKey: "public-test-key",
    capabilities: { emailPasswordAuth, tvLogin: true },
    isCustom
  });
}

test("packaged Tizen fallback enables password login only for the official backend", () => {
  assert.equal(supportsEmailPasswordAuth(configuration(), { allowOfficialFallback: true }), true);
  assert.equal(supportsEmailPasswordAuth(configuration()), false);
});

test("custom servers retain their advertised password-login capability", () => {
  assert.equal(
    supportsEmailPasswordAuth(configuration({ isCustom: true }), {
      allowOfficialFallback: true
    }),
    false
  );
  assert.equal(
    supportsEmailPasswordAuth(configuration({ isCustom: true, emailPasswordAuth: true }), {
      allowOfficialFallback: true
    }),
    true
  );
});
