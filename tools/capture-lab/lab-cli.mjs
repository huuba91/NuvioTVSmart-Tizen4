// PC controller for the capture lab running on the TV.
//   node tools/capture-lab/lab-cli.mjs <command> --tv 192.168.129.0 [options]
// Commands: status | info | play --clip X --engine html|avplay | stop | matrix | research | all | get /ambilight/state
// matrix options: --clips a.mp4,b.mp4 --engines html,avplay --modes 1,2,3 --seconds 6 --warm
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "status";
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
};
const tv = opt("tv", process.env.TV_IP);
if (!tv || tv === true) { console.error("give the TV address: --tv 192.168.129.0"); process.exit(2); }
const base = `http://${tv}:${opt("port", 2720)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, timeoutMs = 60000) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) });
  return response.json();
}

async function save(name, data) {
  const file = `capture-lab-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(file, JSON.stringify(data, null, 2));
  console.log(`saved ${file}`);
}

async function requireUi() {
  const health = await get("/lab/health", 8000);
  if (!health.uiConnected) throw new Error("the Capture Lab page is not running on the TV (launch the Capture Lab app)");
  return health;
}

function table(results) {
  const rows = results.map((r) => [
    r.clip, r.engine, `mode ${r.mode}`, r.verdict,
    r.score === undefined ? "" : `${Math.round(r.score * 100)}%`,
    r.perSecond === undefined ? "" : `${r.perSecond}/s`,
    r.distinctPictures === undefined ? "" : `${r.distinctPictures} distinct`,
    r.startupMs === undefined ? "" : `start ${r.startupMs} ms`,
    r.timing && r.timing.callMs ? `call ${r.timing.callMs.median}/${r.timing.callMs.p90} ms, decode ${r.timing.decodeMs.median} ms` : "",
    r.error || ""
  ]);
  const widths = rows[0] ? rows[0].map((_, c) => Math.max(...rows.map((row) => String(row[c]).length))) : [];
  for (const row of rows) console.log(row.map((cell, c) => String(cell).padEnd(widths[c])).join("  "));
}

async function runMatrix() {
  await requireUi();
  const params = new URLSearchParams({ plan: "matrix" });
  for (const key of ["clips", "engines", "modes", "seconds"]) { const v = opt(key); if (v && v !== true) params.set(key, v); }
  if (opt("warm")) params.set("warm", "1");
  const started = await get(`/lab/run?${params}`);
  if (!started.started) throw new Error("a test is already running on the TV (see /lab/job)");
  let shown = 0;
  for (;;) {
    await sleep(2000);
    const { job } = await get("/lab/job", 15000);
    while (shown < job.progress.length) console.log(job.progress[shown++]);
    if (!job.running) {
      if (job.error) throw new Error(job.error);
      console.log("");
      table(job.results);
      return job.results;
    }
  }
}

async function runResearch() {
  await get("/ambilight/research-start");
  console.log("research running on the TV (about 20 s)...");
  for (;;) {
    await sleep(3000);
    const result = await get("/ambilight/research-result", 15000);
    if (result.done) return result;
  }
}

try {
  switch (command) {
    case "status": console.log(JSON.stringify(await get("/lab/health", 8000), null, 2)); break;
    case "info": { await requireUi(); console.log(JSON.stringify(await get("/lab/command?type=info"), null, 2)); break; }
    case "play": { await requireUi(); console.log(JSON.stringify(await get(`/lab/command?type=play&clip=${opt("clip", "h264-1080p.mp4")}&engine=${opt("engine", "html")}&wait=45`, 60000), null, 2)); break; }
    case "stop": console.log(JSON.stringify(await get("/lab/command?type=stop"), null, 2)); break;
    case "matrix": { const r = await runMatrix(); await save("matrix", r); break; }
    case "research": { const r = await runResearch(); await save("research", r); break; }
    case "all": {
      const matrix = await runMatrix();
      await requireUi();
      // research runs while a clip is playing so the capture service sees real video
      await get(`/lab/command?type=play&clip=h264-1080p.mp4&engine=html&wait=45`, 60000);
      const research = await runResearch();
      await get("/lab/command?type=stop");
      await save("all", { matrix, research });
      break;
    }
    case "get": console.log(JSON.stringify(await get(String(args[1] || "/lab/health")), null, 2)); break;
    default: console.error("unknown command"); process.exit(2);
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
