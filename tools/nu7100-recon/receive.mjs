// Run on the PC: receives the recon report that the TV app posts and saves it in the current folder.
//   node tools/nu7100-recon/receive.mjs [port]
import http from "node:http";
import os from "node:os";
import { writeFile } from "node:fs/promises";

const port = Number(process.argv[2]) || 8099;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };

http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const report = JSON.parse(body);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = `nu7100-recon-${stamp}.json`;
        await writeFile(file, JSON.stringify(report, null, 2));
        console.log(`\nreport received (${body.length} bytes) -> ${file}`);
        for (const line of report.fingerprint || []) console.log("  " + line);
        res.writeHead(200, cors); res.end("saved " + file);
      } catch (e) { console.log("bad report:", e.message); res.writeHead(400, cors); res.end("bad report"); }
    });
    return;
  }
  res.writeHead(200, cors); res.end("nu7100-recon receiver, POST /report");
}).listen(port, "0.0.0.0", () => {
  console.log(`waiting for the report on port ${port}. In the TV app enter one of:`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) console.log(`  http://${a.address}:${port}`);
  console.log("(Windows may ask to allow Node through the firewall: allow it for private networks.)");
});
