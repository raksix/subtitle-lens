/**
 * Build: bundle the content script as a classic script.
 *
 * Content scripts are not ES modules, so `src/content/*.js` (which imports the
 * shared settings module) has to be flattened. Everything else — the service
 * worker and the popup/options pages — is loaded as a real ES module by Chrome
 * and is copied unchanged.
 *
 * Usage: bun build.mjs
 */

import { mkdir, cp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");

/** Copied verbatim; Chrome loads these directly. */
const STATIC = [
  "manifest.json",
  "src/background",
  "src/common",
  "src/popup",
  "src/options",
  "src/library",
  "icons"
];

async function main() {
  await rm(DIST, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/content/index.js")],
    target: "browser",
    format: "iife",
    minify: false,
    naming: "content.js",
    outdir: join(DIST, "src")
  });

  if (!result.success) {
    for (const message of result.logs) console.error(message);
    process.exit(1);
  }

  for (const path of STATIC) {
    const from = join(ROOT, path);
    if (!existsSync(from)) continue;
    const info = await stat(from);
    const to = join(DIST, path);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: info.isDirectory() });
  }

  const bundle = await Bun.file(join(DIST, "src/content.js")).text();
  console.log(`built dist/src/content.js (${(bundle.length / 1024).toFixed(1)} kB)`);
}

await main();
