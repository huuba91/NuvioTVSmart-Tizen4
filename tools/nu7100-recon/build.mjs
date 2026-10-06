// Packs NU-7100-Recon into an unsigned NU-7100-Recon.wgt (sign + install: see BUILD.md).
//   node tools/nu7100-recon/build.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../../.cache/nu7100-recon");
const files = ["config.xml", "index.html", "css/style.css", "js/core.js", "js/app.js", "js/tests/system.js", "js/tests/filesystem.js", "js/tests/dcapture.js",
  "js/tests/process.js", "js/tests/network.js", "js/tests/ipc.js", "assets/icon.png"];
const zip = new JSZip();
for (const f of files) zip.file(f, await readFile(path.join(here, f)));
await mkdir(outDir, { recursive: true });
const out = path.join(outDir, "NU-7100-Recon.wgt");
const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
await writeFile(out, data);
console.log(`wrote ${out} (${data.length} bytes)`);
