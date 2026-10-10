/**
 * Syntax gate: parse every source file without running it.
 *
 * The extension has no test framework on purpose — the runtime it targets is a
 * browser with a real player. This only catches the class of mistake that
 * `bun build` would otherwise surface after a manual reload.
 *
 * Usage: bun run scripts/check.mjs
 */

import { readdir } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IGNORE = new Set(["node_modules", "dist", ".git"]);

async function collect(directory, out = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await collect(full, out);
    else if ([".js", ".mjs"].includes(extname(entry.name))) out.push(full);
  }
  return out;
}

const files = await collect(ROOT);
const failures = [];

for (const file of files) {
  const source = await Bun.file(file).text();
  try {
    // Parsing as an ES module also validates import statements.
    new Bun.Transpiler({ loader: "js" }).transformSync(source, { loader: "js" });
  } catch (error) {
    failures.push(`${file.replace(ROOT, ".")}: ${error.message}`);
  }
}

if (failures.length) {
  console.error(`syntax errors in ${failures.length} file(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`${files.length} file(s) parsed clean`);
