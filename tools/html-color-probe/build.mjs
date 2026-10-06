// Packs the probe into an unsigned HtmlColorProbe.wgt (sign + install it like the Nuvio WGT, see README.md).
//   node tools/html-color-probe/build.mjs [--pc http://192.168.1.20:8099]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../../.cache/html-color-probe");
const files = ["config.xml", "index.html", "probe.css", "probe.js", "icon.png", "media/pattern.mp4", "media/pattern-frag.mp4"];

const argIdx = process.argv.indexOf("--pc");
const pc = argIdx > 0 ? process.argv[argIdx + 1].replace(/\/$/, "") : "";
let config = await readFile(path.join(here, "config.js"), "utf8");
if (pc) {
  config = config
    .replace(/REPORT_URL: "[^"]*"/, `REPORT_URL: "${pc}"`)
    .replace(/REMOTE_URL: "[^"]*"/, `REMOTE_URL: "${pc}/media/pattern.mp4"`)
    .replace(/REMOTE_IS_PATTERN: \w+/, "REMOTE_IS_PATTERN: true");
}

const zip = new JSZip();
for (const f of files) zip.file(f, await readFile(path.join(here, f)));
zip.file("config.js", config);
await mkdir(outDir, { recursive: true });
const out = path.join(outDir, "HtmlColorProbe.wgt");
await writeFile(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(`wrote ${out}${pc ? ` (report + remote clip via ${pc})` : " (no PC server configured)"}`);
