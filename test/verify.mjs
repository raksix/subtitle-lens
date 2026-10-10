/**
 * End-to-end check against a real Chrome.
 *
 * Branded Chrome builds ignore `--load-extension` since Chrome 137, so the
 * extension is installed over CDP (`Extensions.loadUnpacked`). That needs the
 * browser started with `--enable-unsafe-extension-debugging`, which
 * `test/launch-chrome.ps1` does, and it also means every rebuild needs a fresh
 * browser: an unpacked extension is not reloaded from disk.
 *
 * What is exercised: a hover on a word inside a `pointer-events: none` caption
 * layer, the round trip through the service worker to the translation and
 * dictionary providers, and the card surviving the cue DOM being replaced
 * underneath it. Closed shadow roots are invisible to page scripts but not to
 * CDP, so the assertions read the card over `DOM.getDocument { pierce: true }`.
 *
 * Usage:
 *   bun test/serve.mjs 8123                    # terminal 1
 *   powershell -File test/run-e2e.ps1          # terminal 2 (builds, restarts, verifies)
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9222";
const PAGE_MATCH = process.env.PAGE_MATCH || "demo.html";
const SHOT_PATH = process.env.SHOT_PATH || join(ROOT, "docs/screenshot.png");
const EXTENSION_PATH = process.env.EXTENSION_PATH || join(ROOT, "dist");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Minimal CDP client                                                 */
/* ------------------------------------------------------------------ */

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot open ${url}`)), {
        once: true
      });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    /** method -> handlers, for the few CDP events this check needs. */
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method) {
        for (const handler of this.listeners.get(message.method) || []) {
          handler(message.params);
        }
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
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
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
    });
  }

  close() {
    this.socket.close();
  }
}

/* ------------------------------------------------------------------ */
/* Install                                                            */
/* ------------------------------------------------------------------ */

async function installExtension() {
  const version = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  try {
    const result = await browser.send("Extensions.loadUnpacked", { path: EXTENSION_PATH });
    console.log(`      extension installed: ${result.id}`);
  } catch (error) {
    if (/already|exist|duplicate/i.test(error.message)) {
      console.log("      extension already installed");
      return;
    }
    throw new Error(
      `Extensions.loadUnpacked failed: ${error.message}. ` +
        "Start Chrome with test/launch-chrome.ps1 so --enable-unsafe-extension-debugging is set."
    );
  } finally {
    browser.close();
  }
}

/* ------------------------------------------------------------------ */
/* Pierced-DOM helpers                                                */
/* ------------------------------------------------------------------ */

function attribute(node, name) {
  const attributes = node.attributes || [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === name) return attributes[index + 1];
  }
  return "";
}

function collectByClass(node, className, out = []) {
  if (attribute(node, "class").split(/\s+/).includes(className)) out.push(node);
  for (const child of node.children || []) collectByClass(child, className, out);
  for (const shadow of node.shadowRoots || []) collectByClass(shadow, className, out);
  return out;
}

function textOf(node) {
  let text = node.nodeName === "#text" ? node.nodeValue || "" : "";
  for (const child of node.children || []) text += textOf(child);
  for (const shadow of node.shadowRoots || []) text += textOf(shadow);
  return text;
}

function px(style, property) {
  const match = style.match(new RegExp(`${property}:\\s*(-?[\\d.]+)px`));
  return match ? Number.parseFloat(match[1]) : null;
}

/* ------------------------------------------------------------------ */

async function main() {
  await installExtension();

  const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const target = list.find(
    (candidate) => candidate.type === "page" && candidate.url.includes(PAGE_MATCH)
  );
  if (!target) {
    throw new Error(
      `no page target matching "${PAGE_MATCH}". Found: ${list
        .map((entry) => `${entry.type}:${entry.url}`)
        .join(", ")}`
    );
  }

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

  /** Isolated-world context owned by the content script. */
  let isolatedContext = null;
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.auxData?.isDefault === false && context.name === "SubtitleLens") {
      isolatedContext = context.id;
    }
  });
  cdp.on("Runtime.executionContextsCleared", () => {
    isolatedContext = null;
  });

  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Page.enable");

  // The content script only reaches documents loaded after install.
  await cdp.send("Page.navigate", {
    url: `http://127.0.0.1:8123/test/${PAGE_MATCH}?e2e=${Date.now()}`
  });
  await sleep(2600);

  // A hidden or occluded page stops `requestAnimationFrame`, and the hover
  // pipeline is frame-driven. Focus emulation tells Chrome to treat this
  // document as visible and focused, which is the state a real user is in.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Page.bringToFront");
  await sleep(300);

  const evaluate = async (expression) => {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || "evaluate threw");
    }
    return response.result.value;
  };

  /** Read state out of the content script's isolated world. */
  const readContent = async (expression) => {
    if (isolatedContext === null) return null;
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      contextId: isolatedContext
    });
    if (response.exceptionDetails) return null;
    return response.result.value;
  };

  const highlighted = async () =>
    collectByClass(
      (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })).root,
      "lens-highlight"
    );

  const cardText = async () => {
    const root = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })).root;
    return collectByClass(root, "lens-card")
      .map(textOf)
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
  };

  /* 1. The page reproduces the hostile conditions. ---------------------- */
  const page = await evaluate(
    `(() => {
       const layer = document.querySelector('.player-timedtext');
       return {
         layer: !!layer,
         pointerEvents: layer ? getComputedStyle(layer).pointerEvents : null,
         spans: document.querySelectorAll('.player-timedtext-text-container span').length,
         hook: typeof window.__lensTest
       };
     })()`
  );
  check("caption layer exists", page.layer === true);
  check(
    "caption layer ignores the pointer (the hard case)",
    page.pointerEvents === "none",
    `pointer-events: ${page.pointerEvents}`
  );
  check("caption DOM is rebuilt per word", page.spans > 5, `${page.spans} spans`);
  check("test hook available", page.hook === "object");

  /* 2. Freeze rotation and hover a known word. -------------------------- */
  await evaluate(`window.__lensTest.pause()`);
  await evaluate(`window.__lensTest.seek(0)`); // cue 0 contains "run"
  await sleep(250);
  const spot = await evaluate(`JSON.stringify(window.__lensTest.wordPoint('run'))`);
  const word = JSON.parse(spot);
  if (!word) throw new Error("could not locate the word 'run' in the demo player");
  console.log(
    `      hovering "${word.word}" at ${Math.round(word.x)},${Math.round(word.y)}`
  );

  for (const offset of [0, 1, -1, 0]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: word.x + offset,
      y: word.y,
      button: "none",
      pointerType: "mouse"
    });
    await sleep(50);
  }

  // Poll for the card rather than sleeping a fixed amount: the providers are
  // remote and their latency is not ours to predict.
  let cards = await highlighted();
  let text = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    text = await cardText();
    if (text && !/Looking up/.test(text) && text.length > 20) break;
    await sleep(400);
  }
  cards = await highlighted();

  const stats = JSON.parse(
    (await readContent(`JSON.stringify(window.__subtitleLensController.stats)`)) || "null"
  ) || { moves: 0, frames: 0, tokens: 0 };
  check(
    "pointer pipeline ran (move → frame → token)",
    stats.moves > 0 && stats.frames > 0 && stats.tokens > 0,
    JSON.stringify(stats)
  );

  const hasHost = await evaluate(`!!document.querySelector('[data-subtitle-lens]')`);
  check("overlay host injected on first hover", hasHost === true);
  check("highlight box rendered", cards.length > 0, `${cards.length} box(es)`);

  if (cards.length) {
    const style = attribute(cards[0], "style");
    const left = px(style, "left");
    const top = px(style, "top");
    check(
      "highlight sits on the hovered word",
      left !== null && Math.abs(left - word.box.x) < 10 && Math.abs(top - word.box.y) < 10,
      `highlight ${left},${top} vs word ${Math.round(word.box.x)},${Math.round(word.box.y)}`
    );
  }

  /* 3. Real provider data, not a spinner. ------------------------------ */
  console.log(`      card: ${text.slice(0, 110)}`);
  check("card rendered", text.length > 0);
  check("no lingering loading spinner", !/Looking up/.test(text));
  check(
    "translation rendered in the target language",
    /[çğıöşüÇĞİÖŞÜ]/.test(text) && /koş|çalış|yönet|gitmek|sevk|işlet/i.test(text),
    text.match(/[^·]{0,30}(koş|çalış|yönet|gitmek|işlet)[^·]{0,20}/)?.[0] || ""
  );
  check(
    "provider attribution present",
    /Google|MyMemory/.test(text),
    text.match(/Google|MyMemory/)?.[0] || ""
  );
  check(
    "Cambridge section rendered",
    /Cambridge/.test(text),
    text.match(/Cambridge[^·]{0,30}/)?.[0] || ""
  );
  check(
    "English definition rendered",
    /to move|move quickly|move along|faster than walking/i.test(text)
  );

  /* 4. Screenshot. ------------------------------------------------------ */
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(SHOT_PATH, Buffer.from(shot.data, "base64"));
  console.log(`      screenshot → ${SHOT_PATH}`);

  /* 5. Survive a cue rewrite. ------------------------------------------- */
  const wordBefore = await evaluate(`window.__lensTest.cueText()`);
  await evaluate(`window.__lensTest.next()`);
  const wordAfter = await evaluate(`window.__lensTest.cueText()`);
  await sleep(700);
  const textAfter = await cardText();
  check(
    "cue actually changed under the card",
    wordBefore !== wordAfter,
    `"${wordBefore.slice(0, 34)}…" → "${wordAfter.slice(0, 34)}…"`
  );
  check(
    "card survives the cue rewrite",
    textAfter.length > 0 && !/Looking up/.test(textAfter)
  );

  /* 6. Dismissal. ------------------------------------------------------- */
  for (const type of ["rawKeyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    });
  }
  await sleep(400);
  const afterEsc = await highlighted();
  check("Escape dismisses the highlight", afterEsc.length === 0);

  /* 7. Re-hovering the same word is served from the service worker cache. */
  await evaluate(`window.__lensTest.seek(0)`); // back to the cue with "run"
  await evaluate(`window.__lensTest.pause()`);
  await sleep(300);
  const again = JSON.parse(await evaluate(`JSON.stringify(window.__lensTest.wordPoint('run'))`));
  check("same word still present for the cache check", Boolean(again), again?.word);

  for (const offset of [0, 1, -1, 0]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: again.x + offset,
      y: again.y,
      button: "none",
      pointerType: "mouse"
    });
    await sleep(45);
  }

  let cachedText = "";
  for (let attempt = 0; attempt < 15; attempt += 1) {
    cachedText = await cardText();
    if (/cached/.test(cachedText)) break;
    await sleep(300);
  }
  check("second lookup served from cache", /cached/.test(cachedText), cachedText.slice(0, 90));

  cdp.close();
  report();
}

function report() {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

await main();
