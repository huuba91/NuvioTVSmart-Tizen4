// PC controller for the capture lab running on the TV.
//   node tools/capture-lab/lab-cli.mjs <command> --tv 192.168.129.0 [options]
// Commands: status | info | play --clip X --engine html|avplay | stop | matrix | research | mode3 | all | get /ambilight/state
// matrix options: --clips a.mp4,b.mp4 --engines html,avplay --modes 1,2,3 --seconds 6 --warm
// mode3 options: --clip h264-1080p.mp4 --engine html --strategy-seconds 3 --in-flight-seconds 3 (plays the known-colour clip,
// then runs the mode 3 async/filename/overlap research battery against it - see docs/tizen4-ambilight.md)
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

function msOrDash(v) { return v === null || v === undefined ? "-" : `${v} ms`; }

function printMode3Report(result) {
  const s = result.summary;
  console.log("\nMode 1:");
  console.log(`  real unique frames/s: ${s.mode1 ? s.mode1.realUniqueValidFramesPerSecond : "-"}   mean call latency: ${s.mode1 ? msOrDash(s.mode1.meanCallMs) : "-"}`);
  console.log("Mode 2:");
  console.log(`  real unique frames/s: ${s.mode2 ? s.mode2.realUniqueValidFramesPerSecond : "-"}   mean call latency: ${s.mode2 ? msOrDash(s.mode2.meanCallMs) : "-"}`);
  console.log("Mode 3:");
  console.log(`  API calls/s: ${s.mode3.apiCallsPerSecond ?? "-"}   real unique frames/s: ${s.mode3.realUniqueValidFramesPerSecond}`);
  console.log(`  delay until fresh JPEG: ${msOrDash(s.mode3.delayUntilFreshJpegMs)} (n=${s.mode3DelayedReadSampleCount})`);
  console.log(`  best filename strategy: ${s.mode3.bestFilenameStrategy ?? "-"} (${s.mode3BestFilenameStrategyFps ?? "-"} frames/s)`);
  console.log(`  best in-flight count: ${s.mode3.bestInFlightCount ?? "-"} (${s.mode3BestInFlightFps ?? "-"} frames/s)`);
  console.log(`  stale percentage (in-flight=1): ${s.mode3.stalePercent === null ? "-" : s.mode3.stalePercent + "%"}`);
  console.log("\nAnswers:");
  for (const [k, v] of Object.entries(s.answers)) console.log(`  ${k}: ${v}`);
  const pathResult = result.results["path-semantics-mode3"];
  if (pathResult) console.log(`\nreturned path ${pathResult.returnedPathDiffersFromRequested ? "DIFFERS from" : "matches"} the requested one (${pathResult.requestedPath} -> ${pathResult.returnedPath})`);
  const dirWatch = result.results["dir-watch-mode3"];
  if (dirWatch && (dirWatch.added.length > 1 || dirWatch.removed.length)) console.log(`dir watch: ${dirWatch.added.length} files added, ${dirWatch.removed.length} removed (beyond the requested capture)`);
}

async function runMode3() {
  await requireUi();
  const clip = opt("clip", "h264-1080p.mp4"), engine = opt("engine", "html");
  const played = await get(`/lab/command?type=play&clip=${clip}&engine=${engine}&wait=45`, 60000);
  if (!played.ok) throw new Error(`could not play the clip: ${played.error}`);
  const clipStartEpoch = played.data.clipStartEpoch;
  const params = new URLSearchParams({ clipStartEpoch: String(clipStartEpoch) });
  for (const key of ["strategySeconds", "inFlightSeconds"]) {
    const flag = key.replace(/([A-Z])/g, "-$1").toLowerCase();
    const v = opt(flag);
    if (v && v !== true) params.set(key, v);
  }
  const started = await get(`/ambilight/mode3-research-start?${params}`);
  if (!started.started) throw new Error("a mode 3 research run is already in progress on the TV");
  console.log("mode 3 research running on the TV (about 1-2 minutes)...");
  let shown = 0;
  for (;;) {
    await sleep(3000);
    const result = await get("/ambilight/mode3-research-result", 15000);
    while (shown < result.order.length) console.log(`  ${result.order[shown++]} done`);
    if (result.done) {
      await get("/lab/command?type=stop").catch(() => {});
      printMode3Report(result);
      return result;
    }
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
    case "mode3": { const r = await runMode3(); await save("mode3", r); break; }
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
