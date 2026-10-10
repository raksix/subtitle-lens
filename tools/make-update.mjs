/**
 * Pack and sign the extension, and write the update manifest a self-hosted
 * `update_url` needs.
 *
 * Chrome will only accept an update that is signed with the same key as the
 * installed copy, so the key must persist between releases. It is written to
 * `dist-crx/`, which is gitignored: if that file is lost, every installed copy
 * is a different extension and will never update.
 *
 * Chrome has to do the packing. `--pack-extension` produces the .crx and, on the
 * first run, the .pem; later runs reuse the key if `--pack-extension-key` points
 * at it. The signing key never leaves this machine.
 *
 * Usage:
 *   bun tools/make-update.mjs [--url https://example.com/subtitle-lens/]
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "dist-crx");
const DIST = join(ROOT, "dist");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
];

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

/** The id Chrome derives from the public key: the SHA-256 of the DER key. */
function extensionIdFromKey(pemPath) {
  const der = execFileSync(
    "openssl",
    ["rsa", "-in", pemPath, "-pubout", "-outform", "DER"],
    { maxBuffer: 1024 * 1024 }
  );
  const digest = execFileSync("openssl", ["dgst", "-sha256", "-binary"], { input: der });
  return [...digest.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

async function main() {
  if (!existsSync(DIST)) {
    console.error("dist/ is missing — run `bun build.mjs` first");
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });

  const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
  const keyPath = join(OUT, "subtitle-lens.pem");
  const crxPath = join(OUT, "subtitle-lens.crx");

  // With an existing key, pack straight into the output directory and skip the
  // move dance entirely.
  const packArgs = [`--pack-extension=${DIST}`];
  if (existsSync(keyPath)) {
    packArgs.push(`--pack-extension-key=${keyPath}`);
  } else if (existsSync(`${DIST}.pem`)) {
    packArgs.push(`--pack-extension-key=${DIST}.pem`);
  }
  await writeFile(
    join(OUT, "README.txt"),
    [
      "Packaging output. Everything here is gitignored.",
      "",
      "subtitle-lens.pem  signing key. Losing it means every installed copy is a",
      "                   different extension and can never be updated.",
      "subtitle-lens.crx  the packed, signed extension.",
      "update.xml         the manifest a self-hosted update_url points at.",
      ""
    ].join("\n")
  );

  if (!chrome) {
    console.error("Chrome not found; cannot pack. Tried:");
    for (const path of CHROME_CANDIDATES) console.error(`  ${path}`);
    process.exit(1);
  }

  console.log(`packing dist/ with ${chrome}`);
  try {
    execFileSync(chrome, packArgs, { stdio: "inherit" });
  } catch (error) {
    // Chrome exits non-zero on some platforms even when packing succeeded.
    console.warn(`chrome exited with ${error.status ?? "an error"}; checking output`);
  }

  // Chrome writes `<basename>.crx` and `<basename>.pem` NEXT TO the packed
  // directory — that is, `dist.crx`/`dist.pem` in the project root — not into the
  // output directory, and it refuses to pack again while a stray `dist.pem` is
  // sitting there ("a private key already exists"). So the key is moved into
  // dist-crx/ and passed back in on the next run.
  const sourceCrx = `${DIST}.crx`;
  const sourceKey = `${DIST}.pem`;

  if (existsSync(sourceKey)) {
    await writeFile(keyPath, await readFile(sourceKey));
    await rm(sourceKey, { force: true });
  }
  if (!existsSync(keyPath)) {
    console.error(`no signing key found; expected Chrome to write ${sourceKey}`);
    process.exit(1);
  }

  if (existsSync(sourceCrx)) {
    await writeFile(crxPath, await readFile(sourceCrx));
    await rm(sourceCrx, { force: true });
  } else if (!existsSync(crxPath)) {
    console.error(`no .crx produced; expected Chrome to write ${sourceCrx}`);
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile(join(DIST, "manifest.json"), "utf8"));
  const base = (argValue("--url") || `https://example.com/${manifest.name}/`).replace(/\/?$/, "/");

  let id = "";
  try {
    id = extensionIdFromKey(keyPath);
  } catch {
    console.warn("could not derive the extension id (openssl unavailable); using a placeholder");
    id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  }

  const xml = `<?xml version='1.0' encoding='UTF-8'?>
<!--
  Served at the URL declared as update_url in the packaged manifest.
  Chrome fetches this, compares <version> with the installed one and downloads
  <codebase> when it is newer. The id must match the installed extension.
-->
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${base}${"subtitle-lens.crx"}' version='${manifest.version}' />
  </app>
</gupdate>
`;

  await writeFile(join(OUT, "update.xml"), xml);

  console.log(`\nextension id: ${id}`);
  console.log(`version:      ${manifest.version}`);
  console.log(`crx:          ${crxPath}`);
  console.log(`key:          ${keyPath}`);
  console.log(`update.xml:   ${join(OUT, "update.xml")}`);
  console.log(`\nServe ${base} with subtitle-lens.crx and update.xml, then set:`);
  console.log(`  "update_url": "${base}update.xml"`);
  console.log("in manifest.json and rebuild for that channel.");
}

await main();
