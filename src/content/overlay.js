/**
 * The visual surface: word highlight plus the lookup card.
 *
 * Everything lives in a closed shadow root so host page CSS cannot reach it and
 * so we never mutate the page's own DOM. That matters on streaming sites: their
 * subtitle renderer replaces child nodes on every cue change, so any injected
 * element inside the subtitle subtree is destroyed mid-hover.
 */

const HOST_ATTR = "data-subtitle-lens";

export class Overlay {
  constructor(settings) {
    this.settings = settings;
    this.host = null;
    this.shadow = null;
    this.highlightLayer = null;
    this.card = null;
    this.visible = false;
    this.currentRects = [];
    this.pinned = false;
  }

  applySettings(settings) {
    this.settings = settings;
    if (this.shadow) {
      this.shadow.querySelector(".root").dataset.theme = resolveTheme(settings.theme);
      this.host.style.setProperty("--lens-scale", String(settings.fontScale || 1));
      this.host.style.setProperty("--lens-width", `${settings.cardWidth || 380}px`);
    }
  }

  mount() {
    if (this.host) return;

    this.host = document.createElement("div");
    this.host.setAttribute(HOST_ATTR, "");
    // The host must never intercept events meant for the page; the card opts
    // back in for its own subtree.
    this.host.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483600",
      "pointer-events:none",
      "--lens-scale:1",
      "--lens-width:380px"
    ].join(";");

    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.innerHTML = buildMarkup();

    this.root = this.shadow.querySelector(".root");
    this.root.dataset.theme = resolveTheme(this.settings.theme);
    this.highlightLayer = this.shadow.querySelector(".lens-highlights");
    this.card = this.shadow.querySelector(".lens-card");

    this.card.addEventListener("pointerenter", () => {
      this.card.dataset.hovered = "1";
    });
    this.card.addEventListener("pointerleave", () => {
      delete this.card.dataset.hovered;
    });

    const attach = () => {
      if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    };
    attach();
    // Some SPAs replace <html> children wholesale on navigation.
    this.observer = new MutationObserver(() => {
      if (!this.host.isConnected) attach();
    });
    this.observer.observe(document.documentElement, { childList: true });
  }

  unmount() {
    if (this.observer) this.observer.disconnect();
    if (this.host) this.host.remove();
    this.host = null;
    this.shadow = null;
    this.visible = false;
  }

  /** Draw boxes over `rects` (viewport coordinates, one per text line). */
  showHighlight(rects) {
    this.mount();
    this.currentRects = rects;
    this.highlightLayer.replaceChildren(
      ...rects.map((rect) => {
        const box = document.createElement("div");
        box.className = "lens-highlight";
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        return box;
      })
    );
  }

  hideHighlight() {
    this.currentRects = [];
    if (this.highlightLayer) this.highlightLayer.replaceChildren();
  }

  /** Position and fill the card. `anchor` is the rect of the hovered word. */
  showCard(anchor, render) {
    this.mount();
    this.card.hidden = false;
    this.visible = true;
    render(this.card);
    this.position(anchor);
  }

  position(anchor) {
    const margin = 10;
    const rect = this.card.getBoundingClientRect();
    let left = anchor.left + anchor.width / 2 - rect.width / 2;
    let top = anchor.top - rect.height - margin * 1.6;

    if (top < margin) {
      top = anchor.bottom + margin * 1.2; // no room above: flip below
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
    const maxTop = window.innerHeight - rect.height - margin;
    top = Math.max(margin, Math.min(top, Math.max(margin, maxTop)));

    this.card.style.left = `${Math.round(left)}px`;
    this.card.style.top = `${Math.round(top)}px`;
  }

  hideCard() {
    if (!this.card) return;
    this.card.hidden = true;
    this.visible = false;
    this.card.replaceChildren();
  }

  isPointerOverCard() {
    return Boolean(this.card && this.card.dataset.hovered);
  }
}

function resolveTheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function buildMarkup() {
  return `
<style>
  :host { all: initial; }
  .root {
    --bg: rgba(18, 20, 26, 0.97);
    --bg-soft: rgba(255, 255, 255, 0.06);
    --fg: #eef1f7;
    --muted: #a3adc2;
    --border: rgba(255, 255, 255, 0.14);
    --accent: #6ea8ff;
    --accent-soft: rgba(110, 168, 255, 0.18);
    --hl: rgba(255, 214, 102, 0.30);
    --hl-underline: rgba(255, 214, 102, 0.85);
    --shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: calc(14px * var(--lens-scale));
    line-height: 1.45;
    color: var(--fg);
  }
  .root[data-theme="light"] {
    --bg: rgba(255, 255, 255, 0.98);
    --bg-soft: rgba(0, 0, 0, 0.04);
    --fg: #16181d;
    --muted: #5b6478;
    --border: rgba(0, 0, 0, 0.12);
    --accent: #1f6feb;
    --accent-soft: rgba(31, 111, 235, 0.14);
    --hl: rgba(255, 196, 0, 0.35);
    --hl-underline: rgba(214, 148, 0, 0.9);
    --shadow: 0 16px 40px rgba(15, 23, 42, 0.22);
  }

  .lens-highlights { position: fixed; inset: 0; pointer-events: none; }
  .lens-highlight {
    position: fixed;
    background: var(--hl);
    border-radius: 3px;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06);
    border-bottom: 2px solid var(--hl-underline);
    pointer-events: none;
    animation: lens-in 90ms ease-out;
  }
  @keyframes lens-in { from { opacity: 0; } to { opacity: 1; } }

  .lens-card {
    position: fixed;
    width: var(--lens-width);
    max-width: calc(100vw - 24px);
    max-height: min(58vh, 460px);
    overflow: auto;
    overscroll-behavior: contain;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(14px);
    padding: 12px 14px 10px;
    pointer-events: auto;
    box-sizing: border-box;
    animation: lens-card-in 110ms ease-out;
  }
  @keyframes lens-card-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  .lens-card[hidden] { display: none; }
  .lens-card::-webkit-scrollbar { width: 9px; }
  .lens-card::-webkit-scrollbar-thumb { background: var(--border); border-radius: 9px; }

  .lens-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .lens-word { font-size: 1.28em; font-weight: 650; letter-spacing: -0.01em; }
  .lens-ipa { color: var(--muted); font-size: 0.92em; }
  .lens-pos-chip {
    font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); background: var(--bg-soft); border: 1px solid var(--border);
    border-radius: 999px; padding: 1px 7px;
  }
  .lens-badges { margin-left: auto; display: flex; gap: 5px; align-items: center; }
  .lens-badge {
    font-size: 0.68em; color: var(--muted); border: 1px solid var(--border);
    border-radius: 999px; padding: 1px 6px; white-space: nowrap;
  }
  .lens-badge.level { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }

  .lens-translation {
    margin-top: 9px; font-size: 1.1em; font-weight: 600; color: var(--accent);
    word-break: break-word;
  }
  .lens-translation .lens-provider {
    font-size: 0.66em; font-weight: 500; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 6px;
    margin-left: 7px; vertical-align: middle; white-space: nowrap;
  }

  .lens-section { margin-top: 10px; }
  .lens-section-title {
    font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--muted); margin-bottom: 5px; display: flex; gap: 6px; align-items: center;
  }
  .lens-section-title::after { content: ""; flex: 1; height: 1px; background: var(--border); }
  .lens-def { margin: 0 0 7px; }
  .lens-def-text { word-break: break-word; }
  .lens-example {
    color: var(--muted); font-style: italic; font-size: 0.92em; margin-top: 2px;
    padding-left: 9px; border-left: 2px solid var(--border); word-break: break-word;
  }
  .lens-def-pos { color: var(--accent); font-weight: 600; margin-right: 4px; }
  .lens-alt { display: flex; flex-wrap: wrap; gap: 5px; }
  .lens-alt-chip {
    background: var(--bg-soft); border: 1px solid var(--border); border-radius: 6px;
    padding: 1px 6px; font-size: 0.9em;
  }
  .lens-syn { font-size: 0.92em; color: var(--muted); word-break: break-word; }

  .lens-status { display: flex; align-items: center; gap: 8px; color: var(--muted); }
  .lens-spinner {
    width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid var(--border); border-top-color: var(--accent);
    animation: lens-spin 620ms linear infinite;
  }
  @keyframes lens-spin { to { transform: rotate(360deg); } }
  .lens-error { color: #ff8f8f; }
  .root[data-theme="light"] .lens-error { color: #c02b2b; }

  .lens-foot {
    margin-top: 9px; padding-top: 7px; border-top: 1px solid var(--border);
    display: flex; align-items: center; gap: 6px;
    font-size: 0.74em; color: var(--muted);
  }
  .lens-foot button {
    all: unset; cursor: pointer; color: var(--muted);
    border: 1px solid var(--border); border-radius: 6px; padding: 2px 7px;
  }
  .lens-foot button:hover { color: var(--fg); border-color: var(--accent); }
  .lens-foot .brand { margin-left: auto; opacity: 0.75; }
</style>
<div class="root" data-theme="dark">
  <div class="lens-highlights"></div>
  <div class="lens-card" hidden></div>
</div>`;
}

/* ------------------------------------------------------------------ */
/* Card rendering                                                     */
/* ------------------------------------------------------------------ */

const PROVIDER_LABEL = { google: "Google", mymemory: "MyMemory" };
const SOURCE_LABEL = { freedictionaryapi: "Free Dictionary", wiktionary: "Wiktionary" };

export function renderLoading(card, word) {
  card.replaceChildren(
    el("div", { class: "lens-head" }, el("span", { class: "lens-word" }, word)),
    el(
      "div",
      { class: "lens-status", style: "margin-top:9px" },
      el("div", { class: "lens-spinner" }),
      el("span", {}, "Looking up…")
    )
  );
}

export function renderError(card, word, message) {
  card.replaceChildren(
    el("div", { class: "lens-head" }, el("span", { class: "lens-word" }, word)),
    el(
      "div",
      { class: "lens-section" },
      el("div", { class: "lens-error" }, humanizeError(message))
    )
  );
}

export function renderResult(card, data, settings) {
  const nodes = [];
  const dict = data.dictionary;
  const cambridge = data.cambridge;
  const translation = data.translation;

  const phonetic =
    (dict && dict.entries.find((entry) => entry.pronunciations.length)
      ?.pronunciations[0]?.text) ||
    (cambridge && cambridge.pronunciations[0] ? `/${cambridge.pronunciations[0]}/` : "") ||
    (translation && translation.phonetic ? `/${translation.phonetic}/` : "");

  const head = el("div", { class: "lens-head" }, el("span", { class: "lens-word" }, data.word));
  if (settings.showPhonetic !== false && phonetic) {
    head.append(el("span", { class: "lens-ipa" }, phonetic));
  }

  const badges = el("div", { class: "lens-badges" });
  if (data.sourceLang && data.sourceLang !== settings.targetLang) {
    badges.append(el("span", { class: "lens-badge" }, String(data.sourceLang).toUpperCase()));
  }
  if (data.cached) badges.append(el("span", { class: "lens-badge" }, "cached"));
  if (badges.childElementCount) head.append(badges);
  nodes.push(head);

  if (translation && translation.text) {
    nodes.push(
      el(
        "div",
        { class: "lens-translation", dir: "auto" },
        translation.text,
        el(
          "span",
          { class: "lens-provider" },
          PROVIDER_LABEL[translation.provider] || translation.provider || "auto"
        )
      )
    );
  }

  if (settings.showGoogleAlternatives !== false && translation?.alternatives?.length) {
    const chips = el("div", { class: "lens-alt" });
    for (const group of translation.alternatives.slice(0, 3)) {
      for (const term of group.terms.slice(0, 8)) {
        chips.append(el("span", { class: "lens-alt-chip", dir: "auto" }, term));
      }
    }
    if (chips.childElementCount) {
      nodes.push(section("Eş anlamlı çeviriler", chips));
    }
  }

  if (settings.showDefinitions !== false && dict && dict.entries.length) {
    const body = el("div", {});
    let count = 0;
    for (const entry of dict.entries) {
      for (const sense of entry.senses) {
        if (count >= (settings.maxDefinitions || 4)) break;
        count += 1;
        const item = el(
          "div",
          { class: "lens-def" },
          el(
            "div",
            { class: "lens-def-text" },
            el("span", { class: "lens-def-pos" }, entry.pos || ""),
            sense.definition
          )
        );
        if (settings.showExamples !== false && sense.examples.length) {
          item.append(el("div", { class: "lens-example" }, sense.examples[0]));
        }
        body.append(item);
      }
      if (count >= (settings.maxDefinitions || 4)) break;
    }
    if (body.childElementCount) {
      nodes.push(
        section(`Tanım · ${SOURCE_LABEL[dict.source] || dict.source}`, body)
      );
    }
  }

  if (settings.useCambridge !== false && cambridge && cambridge.senses.length) {
    const body = el("div", {});
    const limit = Math.max(2, Math.min(settings.maxDefinitions || 4, 5));
    for (const sense of cambridge.senses.slice(0, limit)) {
      const item = el("div", { class: "lens-def" });
      if (sense.translation) {
        item.append(
          el(
            "div",
            { class: "lens-def-text", dir: "auto" },
            sense.translation
          )
        );
      }
      if (sense.definition) {
        item.append(
          el(
            "div",
            { class: "lens-def-text", style: "color:var(--muted);font-size:0.93em" },
            sense.pos ? el("span", { class: "lens-def-pos" }, sense.pos) : "",
            sense.definition
          )
        );
      }
      if (settings.showExamples !== false && sense.examples.length) {
        item.append(el("div", { class: "lens-example" }, sense.examples[0]));
      }
      body.append(item);
    }
    const title =
      cambridge.language === "english-turkish" ? "Cambridge (EN→TR)" : "Cambridge";
    nodes.push(section(title, body));
  }

  if (settings.showSynonyms && dict) {
    const synonyms = dict.entries.flatMap((entry) => entry.synonyms).slice(0, 12);
    if (synonyms.length) {
      nodes.push(
        section(
          "Eş anlamlılar",
          el("div", { class: "lens-syn" }, synonyms.join(", "))
        )
      );
    }
  }

  if (!translation?.text && !dict && !cambridge) {
    nodes.push(
      el("div", { class: "lens-section lens-status" }, "Bu kelime için sonuç bulunamadı.")
    );
  }

  const foot = el("div", { class: "lens-foot" });
  foot.append(
    el(
      "button",
      { type: "button", "data-action": "speak", title: "Telaffuzu dinle" },
      "🔊 Dinle"
    ),
    el(
      "button",
      { type: "button", "data-action": "copy", title: "Çeviriyi kopyala" },
      "Kopyala"
    ),
    el("span", { class: "brand" }, "SubtitleLens")
  );
  nodes.push(foot);

  card.replaceChildren(...nodes);
}

function section(title, body) {
  return el(
    "div",
    { class: "lens-section" },
    el("div", { class: "lens-section-title" }, title),
    body
  );
}

function humanizeError(message) {
  const text = String(message || "");
  if (text.includes("not-a-word")) return "Bu bir kelime değil.";
  if (text.includes("word-too-long")) return "Kelime çok uzun.";
  if (text.includes("HTTP 429")) return "Çok fazla istek gönderildi, biraz bekleyin.";
  if (text.includes("Failed to fetch") || text.includes("NetworkError")) {
    return "Ağ hatası: internet bağlantınızı kontrol edin.";
  }
  return `Sonuç alınamadı (${text || "bilinmeyen hata"}).`;
}

export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false || child === "") continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
