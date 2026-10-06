// Run on the PC: receives the probe's JSON report and serves the test clip with CORS + Range
// (so the TV can run the "remote CORS URL" test against known colours).
//   node tools/html-color-probe/report-server.mjs [port]
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 8099;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges"
};

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const rep = JSON.parse(body);
        await mkdir(path.join(here, "reports"), { recursive: true });
        const file = path.join(here, "reports", `report-${Date.now()}.json`);
        await writeFile(file, JSON.stringify(rep, null, 2));
        console.log(`\n== report from ${rep.env && rep.env.model} (Tizen ${rep.env && rep.env.tizen}) -> ${file}`);
        for (const r of rep.results) console.log(`${r.status.toUpperCase().padEnd(8)} ${r.name.padEnd(46)} ${String(r.match).padEnd(8)} ${r.msGrab ?? ""} ms  ${r.detail}`);
      } catch (e) { console.log("bad report:", e.message); }
      res.writeHead(200, cors); res.end("ok");
    });
    return;
  }
  const m = /^\/media\/(pattern(?:-frag)?\.mp4)$/.exec(req.url || "");
  if (m && req.method === "GET") {
    const file = path.join(here, "media", m[1]);
    const { size } = await stat(file);
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    let start = 0, end = size - 1, status = 200;
    const h = { ...cors, "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
    if (range) {
      if (range[1]) start = Number(range[1]);
      if (range[2]) end = Math.min(size - 1, Number(range[2]));
      if (!range[1] && range[2]) { start = size - Number(range[2]); end = size - 1; }
      status = 206; h["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    h["Content-Length"] = end - start + 1;
    res.writeHead(status, h);
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(404, cors); res.end("not found");
}).listen(port, "0.0.0.0", () => {
  console.log(`probe report server on port ${port}. Build the widget with one of:`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) console.log(`  node tools/html-color-probe/build.mjs --pc http://${a.address}:${port}`);
});
