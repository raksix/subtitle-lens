/**
 * Dev/test harness: serves the repo over HTTP so the extension can be loaded
 * against a realistic page. Not part of the packaged extension.
 *
 * Usage: bun test/serve.mjs [port]
 */

import { join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(dirname(fileURLToPath(import.meta.url))));
const PORT = Number(process.argv[2] || 8123);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/test/demo.html";

    const target = normalize(join(ROOT, pathname));
    if (!target.startsWith(ROOT)) return new Response("forbidden", { status: 403 });

    const file = Bun.file(target);
    if (!(await file.exists())) return new Response("not found", { status: 404 });

    const extension = pathname.slice(pathname.lastIndexOf("."));
    return new Response(file, {
      headers: { "content-type": TYPES[extension] || "application/octet-stream" }
    });
  }
});

console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/test/demo.html`);
