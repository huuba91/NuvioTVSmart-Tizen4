import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeEnvScript } from "../scripts/envProperties.mjs";
import {
  assertQrRuntimeEnv,
  parseRuntimeEnvScript,
  runtimeEnvSummary
} from "../scripts/tizenRuntimeEnv.mjs";

const configuredEnv = {
  NUVIO_SUPABASE_URL: "https://api.example.test",
  NUVIO_SUPABASE_ANON_KEY: "public-client-key-that-is-long-enough-for-validation",
  NUVIO_SUPABASE_FALLBACK_URL: "https://fallback.example.test",
  TV_LOGIN_WEB_BASE_URL: "https://example.test/tv-login",
  DEVICE_LOGIN_WEB_BASE_URL: "https://example.test/link"
};

test("generated runtime env can be parsed without executing package JavaScript", () => {
  const parsed = parseRuntimeEnvScript(buildRuntimeEnvScript(configuredEnv));
  assert.equal(parsed.NUVIO_SUPABASE_URL, configuredEnv.NUVIO_SUPABASE_URL);
  assert.equal(parsed.NUVIO_SUPABASE_ANON_KEY, configuredEnv.NUVIO_SUPABASE_ANON_KEY);
});

test("QR runtime verification rejects a package with blank backend configuration", () => {
  assert.throws(
    () => assertQrRuntimeEnv({}),
    /NUVIO_SUPABASE_URL.*NUVIO_SUPABASE_ANON_KEY.*TV_LOGIN_WEB_BASE_URL/
  );
});

test("runtime summaries never expose the public client key value", () => {
  const summary = runtimeEnvSummary(assertQrRuntimeEnv(configuredEnv));
  assert.equal(summary.NUVIO_SUPABASE_ANON_KEY.configured, true);
  assert.equal(
    summary.NUVIO_SUPABASE_ANON_KEY.length,
    configuredEnv.NUVIO_SUPABASE_ANON_KEY.length
  );
  assert.equal(JSON.stringify(summary).includes(configuredEnv.NUVIO_SUPABASE_ANON_KEY), false);
});
