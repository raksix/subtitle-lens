/**
 * Card-level checks for the paths a real outage produces.
 *
 * `test/providers.test.mjs` proves the service worker classifies failures
 * correctly. This proves the card renders that classification the way a user
 * reads it: a Turkish sentence naming what failed, never a raw provider code.
 *
 * The service worker's answer is stubbed inside the content script's own
 * isolated world, so the card is driven end to end through the real render
 * path without touching the network. The card itself is read through
 * `DOM.getDocument { pierce: true }` because it lives in a closed shadow root.
 *
 * Usage: bun test/verify-ui-errors.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((res, rej) => {
      socket.addEventListener("open", res, { once: true });
      socket.addEventListener("error", () => rej(new Error("cannot open " + url)), { once: true });
    });
    return new Cdp(socket);
  }
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const m = JSON.parse(event.data);
      if (m.method) for (const h of this.listeners.get(m.method) || []) h(m.params);
      if (!m.id || !this.pending.has(m.id)) return;
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    });
  }
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }
  send(method, params = {}, timeout = 25000) {
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
  close() { this.socket.close(); }
}

function attr(node, name) {
  const a = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return "";
}
function collect(node, cls, out = []) {
  if (attr(node, "class").split(/\s+/).includes(cls)) out.push(node);
  for (const c of node.children || []) collect(c, cls, out);
  for (const s of node.shadowRoots || []) collect(s, cls, out);
  return out;
}
function text(node) {
  let t = node.nodeName === "#text" ? node.nodeValue || "" : "";
  for (const c of node.children || []) t += text(c);
  for (const s of node.shadowRoots || []) t += text(s);
  return t;
}

const version = await (await fetch(`${CDP_HTTP}/json/version`)).json();
const browser = await Cdp.connect(version.webSocketDebuggerUrl);
const ext = await browser.send("Extensions.loadUnpacked", { path: join(ROOT, "dist") });
browser.close();

const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("demo.html"));
if (!page) throw new Error("start Chrome with test/launch-chrome.ps1 first");

const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
let isolated = null;
const pageErrors = [];
cdp.on("Runtime.executionContextCreated", ({ context }) => {
  if (context.auxData?.isDefault === false && context.name === "SubtitleLens") {
    isolated = context.id;
  }
});
cdp.on("Runtime.executionContextsCleared", () => { isolated = null; });
cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
  pageErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
});

await cdp.send("Runtime.enable");
await cdp.send("DOM.enable");
await cdp.send("Page.enable");
await cdp.send("Page.navigate", { url: `http://127.0.0.1:8123/test/demo.html?ui=${Date.now()}` });
await sleep(2600);
await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
await sleep(300);

check("content script isolated world present", isolated !== null, `context ${isolated}`);

const inContent = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    contextId: isolated
  });
  if (r.exceptionDetails) return "EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const cardText = async () => {
  const root = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })).root;
  return collect(root, "lens-card").map(text).join("\n").replace(/\s+/g, " ").trim();
};

/** The notice that names which sources failed, on its own. */
const noticeText = async () => {
  const root = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })).root;
  return collect(root, "lens-partial").map(text).join(" ").replace(/\s+/g, " ").trim();
};

/** Stub the service worker's answer, run a lookup, return the rendered card. */
const renderWith = async (answer) => {
  const patched = await inContent(
    `(() => {
       if (!window.__realSendMessage) window.__realSendMessage = chrome.runtime.sendMessage;
       chrome.runtime.sendMessage = async () => (${JSON.stringify(answer)});
       return String(chrome.runtime.sendMessage).slice(0, 40);
     })()`
  );
  console.log(`      stub installed: ${patched}`);
  await inContent(`window.__subtitleLensController.runTest({ word: 'subtitle', anchor: { left: 420, top: 520, width: 70, height: 20, right: 490, bottom: 540 } })`);
  let card = "";
  for (let i = 0; i < 14; i += 1) {
    card = await cardText();
    if (card && !/Looking up/.test(card)) break;
    await sleep(250);
  }
  if (/Looking up/.test(card)) {
    const probe = await inContent(`(() => {
      const c = window.__subtitleLensController;
      try {
        c.overlay.card.replaceChildren();
        return 'cleared';
      } catch (error) { return 'clear threw: ' + error.message; }
    })()`);
    console.log(`      stuck on loading; probe: ${probe}`);
    if (pageErrors.length) console.log(`      exceptions: ${pageErrors.splice(0).join(" | ")}`);
  }
  return card;
};

/* --- 1. Total translation outage ------------------------------------- */
const outage = await renderWith({
  ok: true,
  data: {
    word: "subtitle",
    targetLang: "tr",
    sourceLang: "en",
    translation: null,
    dictionary: null,
    cambridge: null,
    errors: { translation: "HTTP 429" }
  }
});
check("outage card names the cause in Turkish", /sınırda|tekrar deneyin/i.test(outage), outage.slice(0, 110));
check("outage card hides the raw provider code", !/\bHTTP 429\b/.test(outage), outage.slice(0, 60));

/* --- 2. Partial: translation fine, dictionary rate limited ----------- */
const partial = await renderWith({
  ok: true,
  data: {
    word: "subtitle",
    targetLang: "tr",
    sourceLang: "en",
    translation: { text: "alt yazı", provider: "google", alternatives: [] },
    dictionary: null,
    cambridge: { language: "english-turkish", senses: [{ translation: "alt yazı", definition: "words shown on screen", examples: [], level: "", pos: "noun" }] },
    errors: { dictionary: "HTTP 403" }
  }
});
check("partial card still shows the translation", /alt yazı/.test(partial), partial.slice(0, 90));
const partialNotice = await noticeText();
check(
  "partial card names only the failing source",
  /^sözlük sonucu alınamadı/.test(partialNotice) && !/çeviri|Cambridge/i.test(partialNotice),
  partialNotice || "(no notice rendered)"
);
check("partial card does not claim nothing was found", !/Bu kelime için sonuç bulunamadı/.test(partial));

/* --- 3. Nothing anywhere --------------------------------------------- */
const empty = await renderWith({
  ok: true,
  data: {
    word: "subtitle",
    targetLang: "tr",
    sourceLang: "en",
    translation: null,
    dictionary: null,
    cambridge: null,
    errors: {}
  }
});
check("empty card says the word has no results", /sonuç bulunamadı/i.test(empty), empty.slice(0, 90));

/* --- 4. Extension reloaded under a live page ------------------------- */
const orphaned = await renderWith({ ok: false, error: "Extension context invalidated." });
check(
  "an orphaned content script tells the user to refresh",
  /yenileyin/i.test(orphaned),
  orphaned.slice(0, 110)
);

/* Restore the real message channel so later runs are unaffected. */
await inContent(
  `(() => { if (window.__realSendMessage) chrome.runtime.sendMessage = window.__realSendMessage; return true; })()`
).catch(() => {});

cdp.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
void ext;
