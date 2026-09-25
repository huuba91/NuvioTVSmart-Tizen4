import path from "node:path";
import {
  assertQrRuntimeEnv,
  readRuntimeEnvFromWgt,
  runtimeEnvSummary
} from "./tizenRuntimeEnv.mjs";

const [wgtArg] = process.argv.slice(2);
if (!wgtArg) {
  throw new Error("Usage: node scripts/verify-tizen-runtime-env.mjs <package.wgt>");
}

const wgtPath = path.resolve(wgtArg);
const env = assertQrRuntimeEnv(await readRuntimeEnvFromWgt(wgtPath));
console.log(`Verified QR runtime configuration in: ${wgtPath}`);
console.log(JSON.stringify(runtimeEnvSummary(env), null, 2));
