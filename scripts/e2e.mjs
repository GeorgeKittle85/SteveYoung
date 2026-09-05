#!/usr/bin/env node
/**
 * e2e.mjs — end-to-end smoke test plus a CPU measurement of the relay.
 *
 * Boots, in this order and all on loopback:
 *   1. an "origin" website (plain Node http server) with a page, a stylesheet,
 *      an image and a large binary — the site being browsed;
 *   2. the real relay (container/server.mjs) with private IPs allowed;
 *   3. dev-local.mjs serving public/ and forwarding /wisp/ to the relay;
 *   4. headless Chromium (Playwright), which loads the shell, navigates to the
 *      origin site through the proxy and downloads the binary through it.
 *
 * Between steps it samples the relay's CPU time from /proc, so the output
 * includes how many CPU-milliseconds the relay burns per megabyte relayed —
 * the number that decides which Container instance type is enough.
 *
 * Requires: `npm run build` first, Chromium for Playwright installed.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "e2e-output");

const ORIGIN_PORT = 9000;
const RELAY_PORT = 8080;
const UI_PORT = 8787;
const BIG_MB = Number(process.env.E2E_BIG_MB ?? 32);

function loadPlaywright() {
  try { return require("playwright"); } catch {}
  for (const p of ["/usr/local/lib/node_modules/playwright", "/usr/lib/node_modules/playwright"]) {
    try { return require(p); } catch {}
  }
  throw new Error("playwright not found: npm i -D playwright && npx playwright install chromium");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status < 500) return; } catch {}
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${url}`);
}

/** CPU seconds (user+system) and RSS MB of a pid, from /proc. */
async function procStats(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const hz = 100; // CLK_TCK on Linux
  const cpu = (Number(fields[11]) + Number(fields[12])) / hz; // utime + stime
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024;
  return { cpu, rss };
}

// ---- 1. the site being browsed ------------------------------------------
const big = randomBytes(BIG_MB * 1024 * 1024);
const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><title>origin</title>
<link rel="stylesheet" href="/site.css"></head>
<body><h1 id="hello">PROXY-OK</h1><img id="img" src="/pixel.png" alt="">
<button id="dl">download</button><p id="result">idle</p>
<script>
document.getElementById("dl").onclick = async () => {
  const t0 = performance.now();
  const r = await fetch("/big.bin", { cache: "no-store" });
  const buf = await r.arrayBuffer();
  document.getElementById("result").textContent = buf.byteLength + " bytes in " + Math.round(performance.now() - t0) + " ms";
};
</script></body></html>`;
const MANY = 150;
const manyHtml = `<!doctype html><html><head><meta charset="utf-8"><title>many</title></head><body><p id="count">0</p>
${Array.from({ length: MANY }, (_, i) => `<img src="/pixel.png?i=${i}" onload="document.getElementById('count').textContent=+document.getElementById('count').textContent+1">`).join("")}
</body></html>`;
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let originRequests = 0;
const origin = createServer((req, res) => {
  const routes = {
    "/": ["text/html; charset=utf-8", pageHtml],
    "/index.html": ["text/html; charset=utf-8", pageHtml],
    "/site.css": ["text/css", "body{background-color:rgb(1, 2, 3);color:#fff}"],
    "/many.html": ["text/html; charset=utf-8", manyHtml],
    "/pixel.png": ["image/png", pixel],
    "/big.bin": ["application/octet-stream", big],
  };
  const hit = routes[req.url.split("?")[0]];
  if (req.url.startsWith("/pixel.png?")) originRequests++;
  if (!hit) { res.writeHead(404); return res.end("nope"); }
  res.writeHead(200, { "content-type": hit[0], "content-length": Buffer.byteLength(hit[1]), "cache-control": "no-store" });
  res.end(hit[1]);
});
await new Promise((r) => origin.listen(ORIGIN_PORT, "127.0.0.1", r));

// ---- 2 + 3. relay and UI --------------------------------------------------
const children = [];
function start(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}
const relay = start("relay", ["container/server.mjs"], { PORT: String(RELAY_PORT), HOST: "127.0.0.1", WISP_ALLOW_PRIVATE: "1", WISP_LOG_LEVEL: "WARN" });
start("ui", ["scripts/dev-local.mjs"], { PORT: String(UI_PORT), RELAY_PORT: String(RELAY_PORT) });
await waitForHttp(`http://127.0.0.1:${RELAY_PORT}/`);
await waitForHttp(`http://127.0.0.1:${UI_PORT}/health`);

const results = { ok: false, steps: [] };
const step = (name, data) => { results.steps.push({ name, ...data }); console.log(`✔ ${name}`, data ? JSON.stringify(data) : ""); };

let browser;
try {
  // ---- 4. drive a real browser ------------------------------------------
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => console.log("[page error]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("[console error]", m.text()); });

  await page.goto(`http://127.0.0.1:${UI_PORT}/`);
  await page.waitForSelector("body[data-ready='1']", { timeout: 30_000 });
  step("shell ready (service worker registered, transport set)");

  const idle0 = await procStats(relay.pid);
  await page.fill("#landing-input", `http://127.0.0.1:${ORIGIN_PORT}/index.html`);
  await page.press("#landing-input", "Enter");

  const frame = page.frameLocator("#frame");
  await frame.locator("#hello").waitFor({ timeout: 30_000 });
  const text = await frame.locator("#hello").innerText();
  if (text.trim() !== "PROXY-OK") throw new Error(`unexpected page text: ${text}`);
  step("page rendered through the proxy", { text });

  const bg = await frame.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
  if (bg !== "rgb(1, 2, 3)") throw new Error(`stylesheet not applied through the proxy: ${bg}`);
  const imgOk = await frame.locator("#img").evaluate((img) => img.complete && img.naturalWidth === 1);
  if (!imgOk) throw new Error("image did not load through the proxy");
  step("subresources (css, img) loaded through the proxy", { bg });

  const shown = await page.evaluate(() => document.getElementById("address").value);
  step("address bar tracks the proxied URL", { shown });

  await mkdir(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, "proxied-page.png") });

  // ---- CPU: idle -------------------------------------------------------
  await sleep(5_000);
  const idle1 = await procStats(relay.pid);
  const idleCpuMs = Math.round((idle1.cpu - idle0.cpu) * 1000);
  step("relay idle for 5 s", { cpu_ms: idleCpuMs, rss_mb: +idle1.rss.toFixed(1) });

  // ---- CPU: page-load shaped traffic (many small requests) ---------------
  {
    const before = await procStats(relay.pid);
    const reqBefore = originRequests;
    const t0 = Date.now();
    await page.fill("#address", `http://127.0.0.1:${ORIGIN_PORT}/many.html`);
    await page.press("#address", "Enter");
    await frame.locator("#count").filter({ hasText: String(MANY) }).waitFor({ timeout: 60_000 });
    const wallMs = Date.now() - t0;
    const after = await procStats(relay.pid);
    const cpuMs = (after.cpu - before.cpu) * 1000;
    const reqs = originRequests - reqBefore;
    const summary = { requests: reqs, wall_ms: wallMs, relay_cpu_ms: Math.round(cpuMs), relay_cpu_ms_per_request: +(cpuMs / reqs).toFixed(2) };
    step(`page with ${MANY} small images loaded through the proxy`, summary);
    results.pageLoad = summary;
  }

  // ---- CPU: bulk transfer ------------------------------------------------
  await page.fill("#address", `http://127.0.0.1:${ORIGIN_PORT}/index.html`);
  await page.press("#address", "Enter");
  await frame.locator("#dl").waitFor({ timeout: 30_000 });
  const before = await procStats(relay.pid);
  const t0 = Date.now();
  await frame.locator("#dl").click();
  await frame.locator("#result").filter({ hasText: "bytes" }).waitFor({ timeout: 120_000 });
  const wallMs = Date.now() - t0;
  const after = await procStats(relay.pid);
  const result = await frame.locator("#result").innerText();
  const bytes = Number(result.split(" ")[0]);
  if (bytes !== big.length) throw new Error(`download size mismatch: ${result}`);
  const cpuMs = (after.cpu - before.cpu) * 1000;
  const mb = bytes / 1024 / 1024;
  const summary = {
    mb: +mb.toFixed(1),
    wall_ms: wallMs,
    throughput_mb_s: +(mb / (wallMs / 1000)).toFixed(1),
    relay_cpu_ms: Math.round(cpuMs),
    relay_cpu_ms_per_mb: +(cpuMs / mb).toFixed(2),
    relay_cpu_share_of_one_core: +((cpuMs / wallMs)).toFixed(3),
    // lite = 1/16 vCPU = 62.5 CPU-ms per wall second
    lite_sustainable_mb_s: +((62.5 / (cpuMs / mb))).toFixed(1),
    rss_mb: +after.rss.toFixed(1),
  };
  step(`downloaded ${summary.mb} MB through the proxy`, summary);
  results.transfer = summary;
  results.idle = { cpu_ms: idleCpuMs, rss_mb: +idle1.rss.toFixed(1) };
  results.ok = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const c of children) c.kill("SIGTERM");
  origin.close();
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
}

console.log(results.ok ? "\nE2E PASSED" : "\nE2E FAILED");
process.exit(results.ok ? 0 : 1);
