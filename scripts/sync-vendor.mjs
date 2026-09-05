#!/usr/bin/env node
/**
 * sync-vendor.mjs — copy the browser-side proxy runtime from node_modules into
 * public/ so Workers Static Assets can serve it from the edge.
 *
 *   public/scram/    Scramjet (URL/HTML/JS rewriter that runs in a service worker)
 *   public/baremux/  bare-mux (SharedWorker that owns the transport)
 *   public/epoxy/    epoxy-transport (TLS + HTTP in WASM, tunnelled over Wisp)
 *   public/credits.html  generated licence/version notice
 *
 * Runs automatically before `wrangler dev` / `wrangler deploy` (see the
 * "build" key in wrangler.jsonc). Idempotent.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

function pkgDir(name) {
  // Not require.resolve(): these packages restrict "exports" and do not expose package.json.
  return path.join(root, "node_modules", ...name.split("/"));
}

const VENDOR = [
  {
    name: "@mercuryworkshop/scramjet",
    dest: "scram",
    files: ["dist/scramjet.all.js", "dist/scramjet.sync.js", "dist/scramjet.wasm.wasm"],
    url: "https://github.com/MercuryWorkshop/Scramjet",
  },
  {
    name: "@mercuryworkshop/bare-mux",
    dest: "baremux",
    files: ["dist/index.js", "dist/worker.js"],
    url: "https://github.com/MercuryWorkshop/bare-mux",
  },
  {
    name: "@mercuryworkshop/epoxy-transport",
    dest: "epoxy",
    files: ["dist/index.mjs"],
    url: "https://github.com/MercuryWorkshop/EpoxyTransport",
  },
];

/** package.json "license", else the first line of the LICENSE file. */
async function licenseOf(dir, pkg) {
  if (pkg.license) return pkg.license;
  try {
    const text = await readFile(path.join(dir, "LICENSE"), "utf8");
    if (/Permission is hereby granted, free of charge/.test(text)) return "MIT";
    if (/GNU AFFERO GENERAL PUBLIC LICENSE/.test(text)) return "AGPL-3.0";
    return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "see repository";
  } catch {
    return "see repository";
  }
}

const rows = [];
for (const v of VENDOR) {
  const src = pkgDir(v.name);
  const pkg = JSON.parse(await readFile(path.join(src, "package.json"), "utf8"));
  const out = path.join(publicDir, v.dest);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const f of v.files) {
    await copyFile(path.join(src, f), path.join(out, path.basename(f)));
  }
  rows.push({ name: v.name, version: pkg.version, license: await licenseOf(src, pkg), url: v.url, files: v.files.length });
  console.log(`  ${v.dest}/  <- ${v.name}@${pkg.version} (${v.files.length} files)`);
}

// Wisp relay is not served to browsers but is part of the deployed system.
const wispPkg = JSON.parse(await readFile(path.join(pkgDir("@mercuryworkshop/wisp-js"), "package.json"), "utf8"));
rows.push({ name: "@mercuryworkshop/wisp-js (relay container)", version: wispPkg.version, license: wispPkg.license, url: "https://github.com/MercuryWorkshop/wisp-js", files: 0 });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const credits = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>px — open-source components</title>
<link rel="stylesheet" href="/style.css">
<style>body{padding:24px;display:block}table{border-collapse:collapse}td,th{padding:6px 12px;text-align:left;border-bottom:1px solid #333}a{color:var(--accent)}</style>
</head><body>
<h1>Open-source components</h1>
<p>px is built on the following projects. Their source is available at the linked repositories, and this deployment ships them unmodified.</p>
<table><thead><tr><th>Component</th><th>Version</th><th>Licence</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><a href="${esc(r.url)}" rel="noopener">${esc(r.name)}</a></td><td>${esc(r.version)}</td><td>${esc(r.license)}</td></tr>`).join("\n")}
</tbody></table>
<p><a href="/">Back</a></p>
</body></html>
`;
await writeFile(path.join(publicDir, "credits.html"), credits);
console.log("  credits.html generated");
