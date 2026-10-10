/**
 * Interaction checks for the features added after 1.0.1.
 *
 * Covers what a unit test cannot: that the pointer can travel from the word to
 * the card without losing it, that clicking a word reaches storage, that
 * Shift+click collects words, that Ctrl+click translates the whole caption, that
 * the transparency setting reaches the card, and that the library page renders,
 * reviews and lists a session.
 *
 * Storage is read through the library page rather than the service worker. Every
 * extension page has `chrome.storage` access, and attaching to a worker over CDP
 * is fragile: it is suspended between events and its `/json/list` entry carries
 * no websocket URL.
 *
 * Usage: bun test/verify-interactions.mjs   (Chrome from launch-chrome.ps1)
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9222";
const DEMO = "http://127.0.0.1:8123/test/demo.html";

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
      socket.addEventListener("error", () => rej(new Error(`cannot open ${url}`)), { once: true });
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
  send(method, params = {}, sessionId = undefined, timeout = 25000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.socket.send(JSON.stringify(message));
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

/* ------------------------------------------------------------------ */
/* Pierced-DOM helpers                                                */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */

const version = await (await fetch(`${CDP_HTTP}/json/version`)).json();
const browser = await Cdp.connect(version.webSocketDebuggerUrl);
const ext = await browser.send("Extensions.loadUnpacked", { path: join(ROOT, "dist") });
console.log(`      extension: ${ext.id}`);

/** Open one of the extension's own pages and bind it to a flatten session. */
async function openExtensionPage(path) {
  const { targetId } = await browser.send("Target.createTarget", {
    url: `chrome-extension://${ext.id}/${path}`
  });
  const { sessionId } = await browser.send("Target.attachToTarget", {
    targetId,
    flatten: true
  });
  await browser.send("Runtime.enable", {}, sessionId);

  const errors = [];
  browser.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    const description = exceptionDetails.exception?.description || exceptionDetails.text;
    if (description) errors.push(description);
  });

  return {
    errors,
    targetId,
    async eval(expression) {
      const r = await browser.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId
      );
      if (r.exceptionDetails) {
        return "EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    },
    async reload() {
      await browser.send("Page.enable", {}, sessionId).catch(() => {});
      await browser.send("Page.reload", { ignoreCache: true }, sessionId).catch(() => {});
      await sleep(1600);
    },
    async close() {
      await browser.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      await browser.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  };
}

/** Every extension page can reach storage; the library page already exists. */
const storage = await openExtensionPage("src/library/library.html");
await sleep(1800);

/**
 * The extension's storage outlives a browser restart when the profile wipe loses
 * its race with Chrome shutting down, so every run starts from a known state
 * instead of inheriting the previous run's list.
 */
await storage.eval(`chrome.storage.local.remove(['lens:words', 'lens:history']).then(() => 'cleared')`);
await sleep(300);

const readStorage = (key) =>
  storage.eval(
    `chrome.storage.local.get(${JSON.stringify(key)}).then((all) => JSON.stringify(all[${JSON.stringify(key)}] ?? null))`
  );

async function storedWords() {
  const raw = await readStorage("lens:words");
  if (typeof raw !== "string") return null;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

/* ------------------------------------------------------------------ */
/* The page under test                                                */
/* ------------------------------------------------------------------ */

const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("demo.html"));
if (!page) throw new Error("no demo page target; run test/launch-chrome.ps1 first");

const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
let isolated = null;
cdp.on("Runtime.executionContextCreated", ({ context }) => {
  if (context.auxData?.isDefault === false && context.name === "SubtitleLens") {
    isolated = context.id;
  }
});
cdp.on("Runtime.executionContextsCleared", () => { isolated = null; });

await cdp.send("Runtime.enable");
await cdp.send("DOM.enable");
await cdp.send("Page.enable");
await cdp.send("Page.navigate", { url: `${DEMO}?interactions=${Date.now()}` });
await sleep(2600);
await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
await cdp.send("Page.bringToFront");
await sleep(300);

/** Page world: where `__lensTest` lives and where DOM geometry is readable. */
const evaluate = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return "EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

/** Isolated world: where the content script's controller lives. */
const inContent = async (expression) => {
  if (isolated === null) return "EXC: no isolated world";
  const r = await cdp.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, contextId: isolated
  });
  if (r.exceptionDetails) return "EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

/** The card element is always present in the shadow root; `hidden` is what
 *  makes it invisible, so counting nodes alone would report it as open. */
const visibleCardCount = () =>
  inContent(
    `(() => {
       const card = window.__subtitleLensController?.overlay?.card;
       return card && !card.hidden && card.childElementCount > 0 ? 1 : 0;
     })()`
  );

const cardText = async () =>
  collect((await cdp.send("DOM.getDocument", { depth: -1, pierce: true })).root, "lens-card")
    .map(text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const cardBox = async () => {
  const raw = await inContent(
    `(() => {
       const card = window.__subtitleLensController?.overlay?.card;
       if (!card || card.hidden) return "null";
       const r = card.getBoundingClientRect();
       return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom });
     })()`
  );
  if (typeof raw !== "string" || raw === "null") return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const move = (x, y) =>
  cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", pointerType: "mouse" });

const MODIFIERS = { none: 0, alt: 1, ctrl: 2, meta: 4, shift: 8 };
const SHIFT = MODIFIERS.shift;
const CTRL = MODIFIERS.ctrl;

/**
 * Dispatch a real click with modifiers. The modifier bitmask must be passed on
 * BOTH the press and the release, otherwise the page sees a modifier that
 * changed mid-gesture.
 */
async function click(x, y, modifiers = 0) {
  await move(x, y);
  await sleep(120);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", clickCount: 1, pointerType: "mouse", modifiers
    });
  }
}

/** Freeze the cue (page world), hover a word, wait for the card. */
async function hoverWord(word, cue = 0) {
  await evaluate(`(window.__lensTest.seek(${cue}), window.__lensTest.pause(), true)`);
  await sleep(150);
  const raw = await evaluate(`JSON.stringify(window.__lensTest.wordPoint(${JSON.stringify(word)}))`);
  if (typeof raw !== "string" || raw === "null") return null;
  const spot = JSON.parse(raw);
  await move(4, 4);
  await sleep(80);
  for (const dx of [0, 1, -1, 0]) {
    await move(spot.x + dx, spot.y);
    await sleep(45);
  }
  for (let i = 0; i < 20; i += 1) {
    const t = await cardText();
    if (t && !/Looking up/.test(t)) break;
    await sleep(350);
  }
  return spot;
}

const wordPoint = async (word) => {
  const raw = await evaluate(`JSON.stringify(window.__lensTest.wordPoint(${JSON.stringify(word)}))`);
  return typeof raw === "string" && raw !== "null" ? JSON.parse(raw) : null;
};

const selectionCount = () => inContent(`window.__subtitleLensController.selectedWords.length`);
const selectedWords = () => inContent(`JSON.stringify(window.__subtitleLensController.selectedWords.map((w) => w.word))`);

/* ================================================================== */
/* 1. Transparency reaches the card                                   */
/* ================================================================== */

const spot = await hoverWord("run", 0);
check("a word was hovered for the pointer tests", Boolean(spot), spot ? `${Math.round(spot.x)},${Math.round(spot.y)}` : "not found");

const hostStyle = () =>
  evaluate(`document.querySelector('[data-subtitle-lens]')?.getAttribute('style') || ''`);

check("the overlay host is mounted", /--lens-opacity/.test(await hostStyle()), (await hostStyle()).slice(0, 60));

await inContent(
  `window.__subtitleLensController.applySettings({ ...window.__subtitleLensController.settings, cardOpacity: 0.7, cardBlur: 4 })`
);
await sleep(200);
const styled = await hostStyle();
check("the opacity setting reaches the host", /--lens-opacity:\s*0\.7/.test(styled), styled.match(/--lens-opacity:[^;]*/)?.[0] || "");
check("the blur setting reaches the host", /--lens-blur:\s*4px/.test(styled), styled.match(/--lens-blur:[^;]*/)?.[0] || "");

const alpha = await inContent(
  `(() => {
     const card = window.__subtitleLensController.overlay.card;
     const bg = getComputedStyle(card).backgroundColor;
     const m = /rgba?\\(([^)]+)\\)/.exec(bg);
     if (!m) return "unparsed";
     const parts = m[1].split(",").map((v) => Number(v.trim()));
     return String(parts.length === 4 ? parts[3] : 1);
   })()`
);
check("the card background is actually translucent", Number(alpha) > 0 && Number(alpha) < 1, `alpha=${alpha}`);

await inContent(
  `window.__subtitleLensController.applySettings({ ...window.__subtitleLensController.settings, cardOpacity: 0.94, cardBlur: 16 })`
);

/* ================================================================== */
/* 2. Grace period: the pointer can reach the card                    */
/* ================================================================== */

const box = await cardBox();
check("the card has a measurable box", Boolean(box), box ? `${Math.round(box.width)}×${Math.round(box.height)}` : "none");

if (box && spot) {
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await move(
      spot.x + (box.left + box.width / 2 - spot.x) * t,
      spot.y + (box.top + Math.min(box.height, 40) - spot.y) * t
    );
    await sleep(60);
  }
  await sleep(700);
  check("the card survives the pointer travelling onto it", Number(await visibleCardCount()) === 1);
  await sleep(1500);
  check("the card stays open while the pointer rests on it", Number(await visibleCardCount()) === 1);
  await move(6, 6);
  await sleep(1200);
  check("leaving the card closes it after the grace period", Number(await visibleCardCount()) === 0);
}

/* ================================================================== */
/* 3. Shift+click multi-select                                        */
/* ================================================================== */

await evaluate(`(window.__lensTest.seek(0), window.__lensTest.pause(), true)`);
await sleep(200);
await inContent(`window.__subtitleLensController.dismiss()`);
await sleep(150);

const wordA = await wordPoint("children");
const wordB = await wordPoint("station");
check("two words available for multi-select", Boolean(wordA && wordB), `${wordA?.word}, ${wordB?.word}`);

if (wordA && wordB) {
  await click(wordA.x, wordA.y, SHIFT);
  await sleep(500);
  check("shift+click collects the first word", Number(await selectionCount()) === 1, await selectedWords());

  await click(wordB.x, wordB.y, SHIFT);
  await sleep(600);
  check("shift+click collects the second word", Number(await selectionCount()) === 2, await selectedWords());

  const selectionBoxes = await inContent(
    `(() => {
       const host = document.querySelector('[data-subtitle-lens]');
       return host ? host.shadowRoot === null : false;
     })()`
  );
  void selectionBoxes;

  const boxesInDom = collect(
    (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })).root,
    "lens-highlight"
  ).length;
  check("collected words are drawn on the overlay", boxesInDom >= 2, `${boxesInDom} boxes`);

  /* Shift+click on an already collected word removes it. */
  await click(wordB.x, wordB.y, SHIFT);
  await sleep(500);
  check("shift+click again removes the word", Number(await selectionCount()) === 1, await selectedWords());
  await click(wordB.x, wordB.y, SHIFT);
  await sleep(500);

  /* The selection card offers a save action. */
  const selectionCardText = await cardText();
  check(
    "a selection card is shown",
    /kelime/i.test(selectionCardText) && /kaydet/i.test(selectionCardText),
    selectionCardText.slice(0, 100)
  );

  const beforeSave = (await storedWords())?.length ?? 0;
  await inContent(`window.__subtitleLensController.saveSelection()`);
  await sleep(2500);
  const afterSave = await storedWords();
  check(
    "saving the selection writes every collected word",
    Array.isArray(afterSave) && afterSave.length >= beforeSave + 2,
    `${beforeSave} → ${afterSave?.length}: ${afterSave?.map((w) => w.word).join(", ")}`
  );
  check("the selection is cleared after saving", Number(await selectionCount()) === 0);
}

/* ================================================================== */
/* 4. Ctrl+click translates the whole caption                         */
/* ================================================================== */

await evaluate(`(window.__lensTest.seek(0), window.__lensTest.pause(), true)`);
await sleep(300);
await inContent(`window.__subtitleLensController.dismiss()`);
await sleep(150);

const lineWord = await wordPoint("children");
if (lineWord) {
  await click(lineWord.x, lineWord.y, CTRL);
  // The line request goes through the service worker to a real provider.
  let lineText = "";
  for (let i = 0; i < 25; i += 1) {
    lineText = await inContent(
      `(() => {
         const node = window.__subtitleLensController.overlay.line;
         if (!node || node.hidden) return "";
         return node.textContent.replace(/\\s+/g, " ").trim();
       })()`
    );
    if (typeof lineText === "string" && lineText && !/Çevriliyor/.test(lineText)) break;
    await sleep(400);
  }
  check("ctrl+click opens the line translation", Boolean(lineText), String(lineText).slice(0, 90));
  check(
    "the line panel shows the source caption",
    /children had to run/i.test(String(lineText)),
    String(lineText).slice(0, 120)
  );

  // Read the translation element on its own: the panel also contains the source
  // line and the provider name, so matching the panel as a whole says nothing.
  const translated = await inContent(
    `(() => {
       const node = window.__subtitleLensController.overlay.line?.querySelector(".lens-line-text");
       return node ? node.textContent.trim() : "";
     })()`
  );
  check(
    "the line panel shows a Turkish translation",
    Boolean(translated) && /[çğıöşüÇĞİÖŞÜ]/.test(translated) && !/^The children/i.test(translated),
    String(translated).slice(0, 100)
  );
  check(
    "the translation is not just the source echoed back",
    String(translated) !== String(lineWord) && /koş|istasyon|tren|çocuk/i.test(String(translated)),
    String(translated).slice(0, 100)
  );

  /* Escape closes it. */
  for (const type of ["rawKeyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    });
  }
  await sleep(400);
  const lineHidden = await inContent(`window.__subtitleLensController.overlay.line.hidden`);
  check("escape closes the line translation", lineHidden === true);
}

/* ================================================================== */
/* 5. Click a word to save it                                         */
/* ================================================================== */

const beforeCount = (await storedWords())?.length ?? 0;
await evaluate(`(window.__lensTest.seek(0), window.__lensTest.pause(), true)`);
await sleep(200);
const clickSpot = await wordPoint("train");
if (clickSpot) {
  await click(clickSpot.x, clickSpot.y);
  await sleep(3200);
}
const after = await storedWords();
check(
  "a plain click still saves the word",
  Array.isArray(after) && after.length === beforeCount + 1,
  Array.isArray(after) ? `${beforeCount} → ${after.length}` : "storage unreadable"
);
const savedEntry = Array.isArray(after) ? after.find((entry) => entry.word === "train") : null;
check("the saved word is the one that was clicked", Boolean(savedEntry), savedEntry?.word);
check(
  "the saved word carries a translation",
  Boolean(savedEntry?.translation) && savedEntry.translation !== "—",
  savedEntry?.translation
);

/* ================================================================== */
/* 6. The library page renders, reviews and lists                     */
/* ================================================================== */

// The page was opened to reach storage before anything was saved, so its list is
// stale by now. Reload it, then read it.
await storage.reload();
const libraryProbe = (expression) => storage.eval(expression);

check("the library page loads without errors", storage.errors.length === 0, storage.errors.join(" | ").slice(0, 160));
const summary = await libraryProbe(`document.getElementById('summary').textContent`);
check("the library shows a summary", /kelime/.test(summary || ""), summary);
const rows = await libraryProbe(`document.querySelectorAll('#wordList .row-item').length`);
check("the library lists the saved words", Number(rows) >= 3, `${rows} rows`);
const firstWord = await libraryProbe(`document.querySelector('#wordList .row-word')?.textContent || ''`);
check("the list shows a real word", Boolean(firstWord), firstWord);
const firstTranslation = await libraryProbe(`document.querySelector('#wordList .row-translation')?.textContent || ''`);
check("the list shows the translation", Boolean(firstTranslation) && firstTranslation !== "—", firstTranslation);

await libraryProbe(`document.querySelector('[data-tab="review"]').click()`);
await sleep(400);
await libraryProbe(`document.getElementById('reviewAll').checked = true; document.getElementById('startReview').click()`);
await sleep(600);
const front = await libraryProbe(`document.getElementById('flashFront').textContent`);
check("a review card shows the word", Boolean(front) && front !== "—", front);
check("the answer starts hidden", (await libraryProbe(`document.getElementById('flashBack').hidden`)) === true);
await libraryProbe(`document.getElementById('revealCard').click()`);
await sleep(300);
check("revealing shows the answer", (await libraryProbe(`document.getElementById('flashBack').hidden`)) === false);
const shownTranslation = await libraryProbe(`document.getElementById('flashTranslation').textContent`);
check("the revealed answer is the translation", Boolean(shownTranslation) && shownTranslation !== "—", shownTranslation);

await libraryProbe(`document.getElementById('gradeGood').click()`);
await sleep(900);
const ended = await libraryProbe(`document.getElementById('reviewCard').hidden`);
const index = Number(await libraryProbe(`document.getElementById('flashIndex').textContent`));
check("grading moves the review session forward", ended === true || index >= 2, `index=${index}, ended=${ended}`);
const reviewedWord = front;
const reviewed = (await storedWords())?.find((entry) => entry.word === reviewedWord);
check("grading is persisted to the word that was reviewed", Number(reviewed?.streak) >= 1, `${reviewedWord}: streak=${reviewed?.streak}`);

await libraryProbe(`document.querySelector('[data-tab="history"]').click()`);
await sleep(800);
const historyRows = await libraryProbe(`document.querySelectorAll('#historyList .row-item').length`);
check("the history tab lists lookups", Number(historyRows) >= 1, `${historyRows} rows`);

/* ================================================================== */
/* 7. Popup reflects the new state                                    */
/* ================================================================== */

const popup = await openExtensionPage("src/popup/popup.html");
await sleep(1800);
const popupProbe = (expression) => popup.eval(expression);

check("the popup loads without errors", popup.errors.length === 0, popup.errors.join(" | ").slice(0, 160));
const libraryCount = await popupProbe(`document.getElementById('libraryCount').textContent`);
check("the popup shows the library count", /kelime/.test(libraryCount || ""), libraryCount);
check(
  "the popup exposes the grace period control",
  Number(await popupProbe(`document.getElementById('gracePeriod').value`)) >= 0,
  `${await popupProbe(`document.getElementById('gracePeriod').value`)} ms`
);
check("the popup exposes the save-on-click switch", (await popupProbe(`document.getElementById('saveOnClick').checked`)) === true);
check(
  "the popup exposes the multi-select switch",
  (await popupProbe(`document.getElementById('multiSelectOnShift').checked`)) === true
);
check(
  "the popup exposes the whole-line switch",
  (await popupProbe(`document.getElementById('translateWholeLine').checked`)) === true
);

await popup.close();
await storage.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
