// Packs the capture lab into an unsigned CaptureLab.wgt (sign + install it like the Nuvio WGT, see README.md).
//   node tools/capture-lab/build.mjs
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(here, "../../services/tizen/runtime");
const outDir = path.resolve(here, "../../.cache/capture-lab");
const zip = new JSZip();
for (const f of ["config.xml", "index.html", "lab.css", "lab.js", "icon.png"]) zip.file(f, await readFile(path.join(here, f)));
zip.file("service/lab-service.js", await readFile(path.join(here, "service/lab-service.js")));
zip.file("service/lab-core.cjs", await readFile(path.join(here, "service/lab-core.cjs")));
for (const f of ["ambilight.cjs", "ambilight-colour.cjs", "ambilight-strip.cjs", "jpeg-dc.cjs", "jpeg-dc-reference.cjs", "dbus-lite.cjs"]) {
  zip.file(`service/runtime/${f}`, await readFile(path.join(runtime, f)));
}
const clips = (await readdir(path.join(here, "media"))).filter((f) => f.endsWith(".mp4"));
if (!clips.length) throw new Error("no clips in tools/capture-lab/media (run make-media.sh)");
for (const f of clips) zip.file(`media/${f}`, await readFile(path.join(here, "media", f)));
await mkdir(outDir, { recursive: true });
const out = path.join(outDir, "CaptureLab.wgt");
await writeFile(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(`wrote ${out} (${clips.length} clips)`);
