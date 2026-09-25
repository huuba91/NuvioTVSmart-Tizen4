import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";

export function parseRuntimeEnvScript(source = "") {
  const match = String(source).match(/\bvar\s+values\s*=\s*(\{[\s\S]*?\});\s*for\s*\(/);
  if (!match) {
    throw new Error("Runtime env script does not contain the generated values object");
  }
  const values = JSON.parse(match[1]);
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Runtime env values must be an object");
  }
  return values;
}

export async function readRuntimeEnvFromWgt(wgtPath) {
  const zip = await JSZip.loadAsync(await readFile(wgtPath));
  const candidates = Object.keys(zip.files).filter(
    (name) => name === "nuvio.env.js" || /^nuvio\.env\.[a-f0-9]{16}\.js$/.test(name)
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Tizen WGT must contain exactly one runtime env script; found ${candidates.length}`
    );
  }
  const entry = zip.file(candidates[0]);
  return parseRuntimeEnvScript(await entry.async("string"));
}

function validHttpsUrl(value) {
  try {
    return new URL(String(value || "")).protocol === "https:";
  } catch (_) {
    return false;
  }
}

export function assertQrRuntimeEnv(env = {}) {
  const missing = [];
  if (!validHttpsUrl(env.NUVIO_SUPABASE_URL)) missing.push("NUVIO_SUPABASE_URL");
  if (String(env.NUVIO_SUPABASE_ANON_KEY || "").trim().length < 40) {
    missing.push("NUVIO_SUPABASE_ANON_KEY");
  }
  if (!validHttpsUrl(env.TV_LOGIN_WEB_BASE_URL)) missing.push("TV_LOGIN_WEB_BASE_URL");
  if (!validHttpsUrl(env.DEVICE_LOGIN_WEB_BASE_URL)) {
    missing.push("DEVICE_LOGIN_WEB_BASE_URL");
  }
  if (missing.length) {
    throw new Error(
      `Tizen WGT cannot start QR login because runtime configuration is missing or invalid: ${missing.join(
        ", "
      )}`
    );
  }
  return env;
}

export function runtimeEnvSummary(env = {}) {
  const summarize = (value, { url = false } = {}) => {
    const normalized = String(value || "").trim();
    let host = "";
    if (url && normalized) {
      try {
        host = new URL(normalized).hostname;
      } catch (_) {
        host = "invalid";
      }
    }
    return {
      configured: Boolean(normalized),
      length: normalized.length,
      ...(url ? { host } : {}),
      fingerprint: normalized
        ? createHash("sha256").update(normalized).digest("hex").slice(0, 12)
        : ""
    };
  };
  return {
    NUVIO_SUPABASE_URL: summarize(env.NUVIO_SUPABASE_URL, { url: true }),
    NUVIO_SUPABASE_ANON_KEY: summarize(env.NUVIO_SUPABASE_ANON_KEY),
    NUVIO_SUPABASE_FALLBACK_URL: summarize(env.NUVIO_SUPABASE_FALLBACK_URL, {
      url: true
    }),
    TV_LOGIN_WEB_BASE_URL: summarize(env.TV_LOGIN_WEB_BASE_URL, { url: true }),
    DEVICE_LOGIN_WEB_BASE_URL: summarize(env.DEVICE_LOGIN_WEB_BASE_URL, { url: true })
  };
}

export function serializeProperties(env = {}, keys = Object.keys(env)) {
  return `${keys
    .map((key) => `${key}=${String(env[key] ?? "").replace(/\\/g, "\\\\")}`)
    .join("\n")}\n`;
}
