#!/usr/bin/env node
/**
 * dev-local.mjs — run the browser UI against a local relay with no Docker,
 * no wrangler and no Cloudflare account.
 *
 *   npm run build            # once, vendors the proxy runtime into public/
 *   npm run relay            # terminal 1: container/server.mjs on :8080
 *   npm run dev:local        # terminal 2: this file on :8787
 *
 * Serves public/ (like Static Assets), fakes /api/whoami, and forwards the
 * /wisp/ WebSocket upgrade to the relay byte-for-byte — the same topology as
 * production (Worker in front, relay behind), minus Access.
 *
 * Env: PORT (8787), RELAY_PORT (8080), RELAY_HOST (127.0.0.1)
 */
import http from "node:http";
import net from "node:net";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8787);
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8080);
const RELAY_HOST = process.env.RELAY_HOST ?? "127.0.0.1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") return send(res, 200, '{"status":"healthy","service":"dev-local"}', "application/json");
  if (url.pathname === "/api/whoami") return send(res, 200, '{"email":"dev@localhost"}', "application/json");
  if (url.pathname.startsWith("/scramjet/")) url.pathname = "/bootstrap.html";
  if (url.pathname === "/") url.pathname = "/index.html";

  const file = path.normalize(path.join(publicDir, url.pathname));
  if (!file.startsWith(publicDir + path.sep)) return send(res, 400, "bad path");
  let st;
  try { st = statSync(file); } catch { return send(res, 404, "not found"); }
  if (!st.isFile()) return send(res, 404, "not found");

  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "content-length": st.size,
    "cache-control": "no-store",
    // Same headers the Worker adds (src/index.ts withSecurityHeaders).
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  });
  createReadStream(file).pipe(res);
});

// Forward the WebSocket upgrade to the relay as raw TCP: replay the request
// head, then pipe both directions. No WebSocket parsing happens here.
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/wisp/") { socket.destroy(); return; }
  const upstream = net.connect(RELAY_PORT, RELAY_HOST, () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(raw + "\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`px dev-local: http://127.0.0.1:${PORT}  (relay ws://${RELAY_HOST}:${RELAY_PORT}/wisp/)`);
});
