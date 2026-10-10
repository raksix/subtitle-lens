/**
 * Hover controller: point -> word -> highlight -> lookup.
 *
 * Design notes that matter for video players:
 *  - The listener is capture-phase and passive, so a player that stops
 *    propagation on `pointermove` cannot starve us.
 *  - The page DOM is never mutated. The page cannot tell we are here, and
 *    video sites that rewrite their cue nodes cannot break the highlight.
 *  - All geometry work is throttled to one frame; a lookup is only sent after
 *    the pointer rests on the same word for `hoverDelay`.
 */

import { buildCharMap, charIndexAtPoint, expandToWord, rectsForRange } from "./dom-utils.js";
import { charMapCache, rectCacheGet, RootResolver } from "./adapters.js";
import {
  Overlay,
  renderError,
  renderLoading,
  renderResult
} from "./overlay.js";

const CHAR_MAP_TTL_MS = 900;
const POINTER_IDLE_MS = 260;

export class HoverController {
  constructor(settings) {
    this.settings = settings;
    this.overlay = new Overlay(settings);
    this.resolver = new RootResolver(settings);
    this.enabled = settings.enabled !== false;

    this.activeWord = null;
    this.activeRoot = null;
    this.activeMap = null;
    this.openToken = 0;
    this.pendingTimer = null;
    this.frame = null;
    this.lastPoint = null;
    this.pointerDownOutside = false;
    this.requestSeq = 0;
    /** Counters exposed to `describePoint` consumers for end-to-end tracing. */
    this.stats = { moves: 0, frames: 0, roots: 0, tokens: 0 };
  }

  start() {
    this.onPointerMove = (event) => this.handlePointerMove(event);
    this.onPointerLeave = () => this.dismiss();
    this.onScroll = () => this.dismiss();
    this.onResize = () => this.dismiss();
    this.onKeyDown = (event) => {
      if (event.key === "Escape") this.dismiss();
    };
    this.onFullscreenChange = () => this.placeHost();
    this.onPointerDown = (event) => {
      if (!this.overlay.visible) return;
      if (event.composedPath().some((node) => node === this.overlay.host)) return;
      this.dismiss();
    };
    this.onSettingsMessage = (message) => {
      if (message?.type === "lens:settings") {
        this.applySettings(message.settings);
      } else if (message?.type === "lens:toggle") {
        this.applySettings({ ...this.settings, enabled: message.enabled });
      } else if (message?.type === "lens:test") {
        this.runTest(message.payload || {});
      }
    };

    document.addEventListener("pointermove", this.onPointerMove, {
      capture: true,
      passive: true
    });
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("pointerleave", this.onPointerLeave, true);
    document.addEventListener("scroll", this.onScroll, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("resize", this.onResize, true);
    document.addEventListener("fullscreenchange", this.onFullscreenChange, true);
    document.addEventListener("webkitfullscreenchange", this.onFullscreenChange, true);
    chrome.runtime.onMessage.addListener(this.onSettingsMessage);

    this.observeMutations();
    if (this.enabled) this.warmUp();
  }

  stop() {
    document.removeEventListener("pointermove", this.onPointerMove, true);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("pointerleave", this.onPointerLeave, true);
    document.removeEventListener("scroll", this.onScroll, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("resize", this.onResize, true);
    document.removeEventListener("fullscreenchange", this.onFullscreenChange, true);
    document.removeEventListener("webkitfullscreenchange", this.onFullscreenChange, true);
    chrome.runtime.onMessage.removeListener(this.onSettingsMessage);
    if (this.observer) this.observer.disconnect();
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.overlay.unmount();
  }

  applySettings(settings) {
    const wasEnabled = this.enabled;
    this.settings = { ...this.settings, ...settings };
    this.enabled = this.settings.enabled !== false;
    this.resolver.update(this.settings);
    this.overlay.applySettings(this.settings);
    if (this.enabled && !wasEnabled) this.warmUp();
    if (!this.enabled) this.dismiss();
  }

  placeHost() {
    if (!this.overlay.host) return;
    const fullscreen =
      document.fullscreenElement || document.webkitFullscreenElement || null;
    const target = fullscreen || document.documentElement;
    if (this.overlay.host.parentElement !== target) {
      target.appendChild(this.overlay.host);
    }
  }

  observeMutations() {
    if (this.observer) return;
    this.observer = new MutationObserver(() => {
      this.resolver.invalidate();
    });
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  /** Build the first char map during idle time so the first hover is instant. */
  warmUp() {
    const run = () => {
      for (const root of this.resolver.getRoots()) this.getCharMap(root);
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 2000 });
    } else {
      setTimeout(run, 600);
    }
  }

  getCharMap(root) {
    const now = Date.now();
    const cached = charMapCache.get(root);
    const text = root.textContent || "";
    if (cached && now - cached.at < CHAR_MAP_TTL_MS && cached.signature === text) {
      return cached;
    }
    const map = buildCharMap(root);
    map.signature = text;
    charMapCache.set(root, map);
    if (charMapCache.size > 24) {
      const oldest = charMapCache.keys().next().value;
      charMapCache.delete(oldest);
    }
    return map;
  }

  handlePointerMove(event) {
    this.stats.moves += 1;
    this.lastPoint = { x: event.clientX, y: event.clientY };
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.stats.frames += 1;
      if (this.lastPoint) this.process(this.lastPoint.x, this.lastPoint.y);
    });
  }

  process(x, y) {
    if (!this.enabled) return;
    if (this.overlay.isPointerOverCard()) return;

    const root = this.resolver.rootsAtPoint(x, y);
    if (!root) {
      this.dismiss();
      return;
    }
    this.stats.roots += 1;

    const map = this.getCharMap(root);
    const index = charIndexAtPoint(map, x, y);
    if (index === -1) {
      this.dismiss();
      return;
    }

    const token = expandToWord(map.text, index);
    if (!token) {
      this.dismiss();
      return;
    }

    const isSame =
      this.activeWord &&
      this.activeWord.word === token.word &&
      this.activeRoot === root;
    if (isSame) return;
    this.stats.tokens += 1;

    this.activeWord = token;
    this.activeRoot = root;
    this.activeMap = map;

    const rects = rectsForRange(map, token.start, token.end);
    if (!rects.length) {
      this.dismiss();
      return;
    }
    this.overlay.mount();
    this.placeHost();
    this.overlay.showHighlight(rects);
    this.anchor = rects[rects.length - 1];

    this.overlay.hideCard();
    clearTimeout(this.pendingTimer);
    const seq = ++this.openToken;
    this.pendingTimer = setTimeout(
      () => this.openCard(token.word, seq),
      Math.max(0, this.settings.hoverDelay ?? 120)
    );
  }

  async openCard(word, seq) {
    if (seq !== this.openToken || !this.anchor) return;

    renderLoading(this.overlay.card, word);
    this.overlay.showCard(this.anchor, () => {});

    const requestId = ++this.requestSeq;
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "lens:query",
        payload: {
          word,
          sourceLang: this.settings.sourceLang || "auto",
          targetLang: this.settings.targetLang || "tr",
          url: location.href
        }
      });
    } catch (error) {
      response = { ok: false, error: String(error?.message || error) };
    }

    // A newer word took over while this lookup was in flight.
    if (seq !== this.openToken || requestId !== this.requestSeq) return;
    if (!this.overlay.visible && !this.overlay.pinned) return;
    if (!response) {
      renderError(this.overlay.card, word, "no-response");
      this.reposition();
      return;
    }
    if (!response.ok) {
      renderError(this.overlay.card, word, response.error);
      this.reposition();
      return;
    }

    renderResult(this.overlay.card, response.data, this.settings);
    this.reposition();
    this.wireCardActions(response.data, word);
  }

  reposition() {
    if (this.anchor) this.overlay.position(this.anchor);
  }

  /**
   * Diagnostic used by `test/verify.mjs`: explains what the resolver sees at a
   * viewport point, so a failing hover can be traced to the resolver, the
   * character map, or the token expansion.
   */
  describePoint(x, y) {
    const root = this.resolver.rootsAtPoint(x, y);
    const out = { point: { x, y }, stats: { ...this.stats }, root: null, map: null, token: null, rects: 0 };
    if (!root) return out;

    const rect = root.getBoundingClientRect();
    out.root = {
      className: root.className,
      box: { l: rect.left, t: rect.top, w: rect.width, h: rect.height },
      text: (root.textContent || "").slice(0, 120)
    };

    const map = this.getCharMap(root);
    out.map = { chars: map.chars.length, text: map.text.slice(0, 120), truncated: map.truncated };

    const index = charIndexAtPoint(map, x, y);
    out.index = index;
    if (index === -1) return out;

    const token = expandToWord(map.text, index);
    out.token = token;
    if (token) out.rects = rectsForRange(map, token.start, token.end).length;
    return out;
  }

  /** Popup "Test et" path: render a card without a real pointer hover. */
  runTest(payload) {
    if (!this.enabled) return;
    const word = payload.word || "run";
    const anchor =
      payload.anchor ||
      {
        left: Math.round(window.innerWidth / 2),
        top: Math.round(window.innerHeight / 2),
        width: 42,
        height: 18
      };
    anchor.right = anchor.right ?? anchor.left + anchor.width;
    anchor.bottom = anchor.bottom ?? anchor.top + anchor.height;

    this.overlay.mount();
    this.placeHost();
    this.overlay.showHighlight([anchor]);
    this.anchor = anchor;
    this.openCard(word, ++this.openToken);
  }

  wireCardActions(data, word) {
    const card = this.overlay.card;
    const speak = card.querySelector('[data-action="speak"]');
    const copy = card.querySelector('[data-action="copy"]');

    if (speak) {
      speak.addEventListener("click", (event) => {
        event.stopPropagation();
        speakWord(word, data?.sourceLang);
      });
    }
    if (copy) {
      copy.addEventListener("click", async (event) => {
        event.stopPropagation();
        const text = data?.translation?.text || "";
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = "Kopyalandı ✓";
          setTimeout(() => {
            copy.textContent = "Kopyala";
          }, 1200);
        } catch {
          copy.textContent = "Kopyalanamadı";
        }
      });
    }
  }

  dismiss() {
    this.openToken += 1;
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.activeWord = null;
    this.activeRoot = null;
    this.activeMap = null;
    this.anchor = null;
    this.overlay.hideCard();
    this.overlay.hideHighlight();
  }
}

function speakWord(word, lang) {
  try {
    const utterance = new SpeechSynthesisUtterance(word);
    if (lang && lang !== "auto") utterance.lang = lang;
    utterance.rate = 0.92;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  } catch {
    /* speech synthesis is optional */
  }
}
