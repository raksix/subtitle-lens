/**
 * Loads the extension's own pages (popup, options, service worker) in a real
 * browser and fails on any console error. The hover path is covered by
 * `verify.mjs`; this covers the surfaces that path never touches.
 *
 * Usage: bun test/check-pages.mjs   (needs Chrome from launch-chrome.ps1)
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9222";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot open ${url}`)), { once: true });
    });
    return new Cdp(socket);
  }
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method) for (const h of this.listeners.get(message.method) || []) h(message.params);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    });
  }
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }
  send(method, params = {}, timeout = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, timeout);
    });
  }
  close() {
    this.socket.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function install() {
  const version = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const result = await browser.send("Extensions.loadUnpacked", { path: join(ROOT, "dist") });
  browser.close();
  return result.id;
}

/** Open `url`, collect console errors, run `probe` in the page, then close. */
async function inspect(extensionId, path, probe) {
  const version = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await browser.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/${path}`
  });

  const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const target = list.find((entry) => entry.id === targetId)
    || list.find((entry) => entry.url.includes(path));
  if (!target) throw new Error(`no target for ${path}`);

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const errors = [];
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    errors.push(exceptionDetails.exception?.description || exceptionDetails.text || "exception");
  });
  cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type === "error") errors.push(args.map((a) => a.value ?? a.description).join(" "));
  });
  await cdp.send("Runtime.enable");
  await sleep(1600);

  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: probe,
    returnByValue: true,
    awaitPromise: true
  });

  await browser.send("Target.closeTarget", { targetId });
  cdp.close();
  browser.close();

  return { errors, value: evaluated.result?.value, threw: evaluated.exceptionDetails };
}

async function main() {
  const extensionId = await install();

  /* Popup ------------------------------------------------------------- */
  const popup = await inspect(
    extensionId,
    "src/popup/popup.html",
    `(() => ({
       options: document.querySelectorAll('#targetLang option').length,
       source: document.querySelectorAll('#sourceLang option').length,
       site: document.getElementById('site-line')?.textContent || '',
       delay: document.getElementById('hoverDelayOut')?.textContent || '',
       lang: document.getElementById('targetLang')?.value || ''
     }))()`
  );
  check("popup loads without console errors", popup.errors.length === 0, popup.errors.join(" | "));
  check("popup populated the language list", popup.value?.options > 10, `${popup.value?.options} options`);
  check("popup defaults to Turkish", popup.value?.lang === "tr", popup.value?.lang);
  check("popup rendered the delay readout", /ms$/.test(popup.value?.delay || ""), popup.value?.delay);

  /* Options ----------------------------------------------------------- */
  const options = await inspect(
    extensionId,
    "src/options/options.html",
    `(async () => ({
       target: document.querySelectorAll('#targetLang option').length,
       provider: document.getElementById('provider')?.value || '',
       theme: document.getElementById('theme')?.value || '',
       width: document.getElementById('cardWidthOut')?.textContent || '',
       cache: document.getElementById('cacheCount')?.textContent || ''
     }))()`
  );
  check("options page loads without console errors", options.errors.length === 0, options.errors.join(" | "));
  check("options populated selects", options.value?.target > 10 && options.value?.theme === "dark");
  check(
    "options reached the service worker for cache stats",
    /Önbellekte|çalışmıyor|okunamadı/.test(options.value?.cache || ""),
    options.value?.cache
  );

  /* Service worker ---------------------------------------------------- */
  const version = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  await browser.send("Target.setDiscoverTargets", { discover: true });
  const workers = [];
  browser.on("Target.targetCreated", ({ targetInfo }) => {
    if (targetInfo.type === "service_worker") workers.push(targetInfo);
  });
  const all = await browser.send("Target.getTargets");
  for (const info of all.targetInfos) {
    if (info.type === "service_worker") workers.push(info);
  }
  const sw = workers.find((worker) => worker.url.includes(extensionId));
  check("service worker is registered and running", Boolean(sw), sw?.url || "not found");
  browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

await main();
