import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_PROPERTY_KEYS, normalizeEnvProperties } from "./envProperties.mjs";
import {
  assertQrRuntimeEnv,
  readRuntimeEnvFromWgt,
  runtimeEnvSummary,
  serializeProperties
} from "./tizenRuntimeEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const [sourceArg, outputArg] = process.argv.slice(2);

if (!sourceArg) {
  throw new Error(
    "Usage: node scripts/import-runtime-env-from-wgt.mjs <official.wgt> [local.properties]"
  );
}

const sourcePath = path.resolve(sourceArg);
const outputPath = path.resolve(outputArg || path.join(rootDir, "local.properties"));
const env = normalizeEnvProperties(await readRuntimeEnvFromWgt(sourcePath));
assertQrRuntimeEnv(env);
await writeFile(outputPath, serializeProperties(env, ENV_PROPERTY_KEYS), "utf8");

console.log(`Imported public runtime configuration from: ${sourcePath}`);
console.log(`Wrote ignored local configuration: ${outputPath}`);
console.log(JSON.stringify(runtimeEnvSummary(env), null, 2));
