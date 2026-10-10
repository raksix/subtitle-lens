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
  el,
  humanizeLineError,
  Overlay,
  renderError,
  renderLoading,
  renderResult,
  section
} from "./overlay.js";

const CHAR_MAP_TTL_MS = 900;
const POINTER_IDLE_MS = 260;

export class HoverController {
  constructor(settings) {
    this.settings = settings;
    this.overlay = new Overlay(settings);
    // The card tells the controller when the pointer is on it, so the grace
    // period can be cancelled and the card can be left open indefinitely.
    this.overlay.onEnter = () => this.setOverlayHover(true);
    this.overlay.onLeave = () => this.setOverlayHover(false);
    this.overlay.onLineClose = () => this.hideLine();
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
    this.stats = { moves: 0, frames: 0, roots: 0, tokens: 0, saves: 0 };
    /** Pending "the pointer left, close soon" timer. */
    this.graceTimer = null;
    /** Pending "the pointer rested, show the hint" timer. */
    this.hintTimer = null;
    /** Set while the pointer is over the card or the hint, so nothing closes. */
    this.hoveringOverlay = false;
    /** Words collected with Shift+click, in the order they were picked. */
    this.selectedWords = [];
    this.selectionTimer = null;
    /** Guards against a stale whole-line answer overwriting a newer one. */
    this.lineRequest = 0;
    this.activeLine = null;
  }

  start() {
    this.onPointerMove = (event) => this.handlePointerMove(event);
    /**
     * Only a pointer that left the document should dismiss.
     *
     * `pointerleave` must NOT be listened for on `document` with capture: the
     * capture phase walks the whole tree, so a leave from any descendant (the
     * `<span>` holding the hovered word, for instance) arrives here too. That
     * closed the card the instant the pointer moved from the word toward it.
     * `pointerout` bubbles, and `relatedTarget === null` means the pointer is
     * over no element at all — the window edge, which is the real case.
     */
    this.onPointerOut = (event) => {
      if (event.relatedTarget) return;
      if (this.hoveringOverlay || this.isPointOverCard(event.clientX, event.clientY)) return;
      this.scheduleDismiss();
    };
    this.onWindowBlur = () => this.dismiss();
    this.onScroll = () => {
      // Scrolling the page moves the word away from the highlight; scrolling
      // inside the card never reaches this document-level listener, because the
      // card lives in a closed shadow root.
      if (this.hoveringOverlay) return;
      this.hideLine();
      this.dismiss();
    };
    this.onResize = () => this.dismiss();
    this.onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (this.selectedWords.length) this.clearSelection();
        this.hideLine();
        this.dismiss();
        return;
      }
      // S saves everything collected with Shift, so the gesture has a finish.
      if (
        (event.key === "s" || event.key === "S") &&
        this.selectedWords.length &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        this.saveSelection();
      }
    };
    // Releasing Shift ends the collection gesture; the overlay stays so the user
    // can still press S or use the card's button.
    this.onKeyUp = (event) => {
      if (event.key === "Shift" && this.selectedWords.length) {
        this.scheduleSelectionCard();
      }
    };
    this.onFullscreenChange = () => this.placeHost();
    this.onPointerDown = (event) => {
      const insideOverlay = event.composedPath().some((node) => node === this.overlay.host);
      if (insideOverlay) return;
      if (event.button !== 0) return;

      // Ctrl/Cmd click translates the whole caption instead of saving one word:
      // the modifier is already the "do it to everything" gesture, and reading a
      // full line is the other thing a viewer wants at a glance.
      if (event.ctrlKey || event.metaKey) {
        if (this.settings.translateWholeLine !== false) {
          event.preventDefault();
          this.translateLineAtPoint(event.clientX, event.clientY);
          return;
        }
      }

      // Shift click collects words into a list without saving each one.
      if (event.shiftKey && this.settings.multiSelectOnShift !== false) {
        event.preventDefault();
        this.toggleSelectionAtPoint(event.clientX, event.clientY);
        return;
      }

      // A click on a caption word saves it, whether or not the card happened to
      // be open at that moment. Anywhere else just closes the card.
      const canSave = this.enabled && this.settings.saveOnClick !== false;
      const saved = canSave && this.saveWordAtPoint(event);
      if (!saved && this.overlay.visible) this.dismiss();
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
    document.addEventListener("pointerout", this.onPointerOut, true);
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("scroll", this.onScroll, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("keyup", this.onKeyUp, true);
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
    document.removeEventListener("pointerout", this.onPointerOut, true);
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("scroll", this.onScroll, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("keyup", this.onKeyUp, true);
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

    // Whether the card should stay open is decided from geometry, not from
    // pointerenter/pointerleave: those events are easy to lose (a synthesized
    // move can skip them) and a stale enter with no matching leave would pin
    // the card open forever. Geometry cannot go stale.
    if (this.overlay.visible && this.isPointInReach(x, y)) {
      this.setOverlayHover(this.isPointOverCard(x, y));
      return;
    }
    if (this.hoveringOverlay) this.setOverlayHover(false);

    const root = this.resolver.rootsAtPoint(x, y);
    if (!root) {
      this.scheduleDismiss();
      return;
    }
    this.stats.roots += 1;

    const map = this.getCharMap(root);
    const index = charIndexAtPoint(map, x, y);
    if (index === -1) {
      this.scheduleDismiss();
      return;
    }

    const token = expandToWord(map.text, index);
    if (!token) {
      this.scheduleDismiss();
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
    this.clearGrace();
    this.scheduleHint();

    const rects = rectsForRange(map, token.start, token.end);
    if (!rects.length) {
      this.scheduleDismiss();
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

  /* ---------------------------------------------------------------- */
  /* Grace period                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * The pointer left a word. Closing immediately makes the card unreachable:
   * the only way to hover it runs through the gap between the word and the card,
   * which is not a word. So the close is delayed long enough to cross that gap.
   *
   * The decision inside the timer is made from geometry, not from a remembered
   * flag: `pointerenter`/`pointerleave` on the card and frame-throttled pointer
   * moves can disagree about where the pointer is, and a stale flag closes a
   * card the user is reading.
   */
  scheduleDismiss() {
    if (!this.overlay.visible) {
      // Nothing to move to; still clear the highlight without ceremony.
      this.dismiss();
      return;
    }
    this.overlay.hideHint();
    clearTimeout(this.pendingTimer);
    clearTimeout(this.graceTimer);
    const delay = Math.max(0, this.settings.gracePeriod ?? 420);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      const point = this.lastPoint;
      if (point && this.isPointInReach(point.x, point.y)) {
        // Still on the card or on the path to it: hold it open.
        this.hoveringOverlay = this.isPointOverCard(point.x, point.y);
        return;
      }
      this.dismiss();
    }, delay);
  }

  clearGrace() {
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  /** True when the point lies inside the card's current box. */
  isPointOverCard(x, y) {
    const card = this.overlay.card;
    if (!card || card.hidden) return false;
    if (typeof x !== "number" || typeof y !== "number") return false;
    const rect = card.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  /**
   * True when the point is on the card or on the straight path from the hovered
   * word to it. The card sits above the subtitle with a gap, and a user crossing
   * that gap must not lose the card: the corridor is the bounding box of the two
   * rects, widened a little. Without it the card is only reachable by a
   * perfectly timed diagonal.
   */
  isPointInReach(x, y) {
    if (this.isPointOverCard(x, y)) return true;
    if (typeof x !== "number" || typeof y !== "number") return false;
    const anchor = this.anchor;
    const card = this.overlay.card;
    if (!anchor || !card || card.hidden || !this.overlay.visible) return false;

    const cardRect = card.getBoundingClientRect();
    if (cardRect.width === 0) return false;
    const pad = 14;
    const left = Math.min(anchor.left, cardRect.left) - pad;
    const right = Math.max(anchor.right ?? anchor.left + anchor.width, cardRect.right) + pad;
    const top = Math.min(anchor.top, cardRect.top) - pad;
    const bottom = Math.max(anchor.bottom ?? anchor.top + anchor.height, cardRect.bottom) + pad;
    return x >= left && x <= right && y >= top && y <= bottom;
  }

  /** The pointer is over the card: nothing may close it while this holds. */
  setOverlayHover(hovering) {
    this.hoveringOverlay = hovering;
    if (hovering) {
      this.clearGrace();
      this.overlay.hideHint();
    } else if (this.overlay.visible) {
      this.scheduleDismiss();
    }
  }

  /**
   * Show what a click will do, but only after the pointer has rested: showing it
   * on every pass over a subtitle would flicker.
   */
  scheduleHint() {
    this.overlay.hideHint();
    clearTimeout(this.hintTimer);
    if (this.settings.saveOnClick === false) return;
    this.hintTimer = setTimeout(() => {
      if (!this.activeWord || !this.anchor || this.hoveringOverlay) return;
      this.overlay.showHint(this.anchor, hintText(this.settings));
    }, Math.max(400, (this.settings.hoverDelay ?? 120) + 380));
  }

  /* ---------------------------------------------------------------- */
  /* Click to save                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Resolve the word under a click and add it to the list.
   * Returns true when something was saved, so the caller can keep the card open.
   */
  saveWordAtPoint(event) {
    const root = this.resolver.rootsAtPoint(event.clientX, event.clientY);
    if (!root) return false;
    const map = this.getCharMap(root);
    const index = charIndexAtPoint(map, event.clientX, event.clientY);
    if (index === -1) return false;
    const token = expandToWord(map.text, index);
    if (!token) return false;

    this.stats.saves += 1;
    const payload = this.buildSavePayload(token.word, map);
    this.sendSave(payload);

    // A click can land on a word whose lookup never opened. Saving it without a
    // translation would make the entry useless later, so ask the service worker
    // and let the merge fill the gap. The first save already happened, so the
    // word is in the list immediately either way.
    if (!payload.translation) this.backfillTranslation(token.word, payload);

    if (this.activeWord?.word === token.word) {
      this.overlay.flashSaved("Sözlüğe eklendi ★");
      this.overlay.setSaveState(true);
    }
    return true;
  }

  /** Look up a word that was saved without a result, then save the result. */
  async backfillTranslation(word, basePayload) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "lens:query",
        payload: {
          word,
          sourceLang: this.settings.sourceLang || "auto",
          targetLang: this.settings.targetLang || "tr",
          url: location.href
        }
      });
      if (!response?.ok) return;
      const data = response.data;
      const translation = data?.translation?.text;
      if (!translation) return;
      await this.sendSave({
        ...basePayload,
        translation,
        phonetic: data.translation.phonetic || "",
        sourceLang: data.sourceLang || basePayload.sourceLang,
        definition:
          basePayload.definition ||
          data?.dictionary?.entries?.[0]?.senses?.[0]?.definition ||
          ""
      });
    } catch {
      /* the entry simply stays without a translation */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Multi-select (Shift+click)                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Add or remove the word under the pointer from the Shift collection.
   *
   * The collection is keyed by word text and remembers the rects it was drawn
   * with, because the caption under it is replaced on every cue change and the
   * boxes cannot be recomputed from a stale character map.
   */
  toggleSelectionAtPoint(x, y) {
    const root = this.resolver.rootsAtPoint(x, y);
    if (!root) return false;
    const map = this.getCharMap(root);
    const index = charIndexAtPoint(map, x, y);
    if (index === -1) return false;
    const token = expandToWord(map.text, index);
    if (!token) return false;

    const key = token.word.toLowerCase();
    const existing = this.selectedWords.findIndex((entry) => entry.key === key);
    if (existing === -1) {
      this.selectedWords.push({
        key,
        word: token.word,
        rects: rectsForRange(map, token.start, token.end)
      });
    } else {
      this.selectedWords.splice(existing, 1);
    }

    this.overlay.renderSelection(this.selectedWords);
    this.overlay.flashSaved(
      this.selectedWords.length
        ? `${this.selectedWords.length} kelime seçildi — kaydetmek için S`
        : "Seçim temizlendi"
    );
    this.scheduleSelectionCard();
    return true;
  }

  /** Show the collected words once the selection settles. */
  scheduleSelectionCard() {
    clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      if (!this.selectedWords.length) {
        this.overlay.hideCard();
        return;
      }
      this.renderSelectionCard();
    }, 320);
  }

  renderSelectionCard() {
    const entries = this.selectedWords;
    const anchor = entries[entries.length - 1]?.rects?.[0] || this.anchor || {
      left: window.innerWidth / 2,
      top: window.innerHeight - 120,
      width: 40,
      height: 18
    };
    anchor.right = anchor.right ?? anchor.left + anchor.width;
    anchor.bottom = anchor.bottom ?? anchor.top + anchor.height;

    const list = el("div", {});
    for (const entry of entries) {
      list.append(
        el(
          "div",
          { class: "lens-def" },
          el(
            "div",
            { class: "lens-def-text" },
            el("span", { class: "lens-def-pos" }, "•"),
            entry.word
          )
        )
      );
    }

    const foot = el("div", { class: "lens-foot" });
    const saveAll = el("button", { type: "button" }, `☆ ${entries.length} kelimeyi kaydet`);
    const clear = el("button", { type: "button" }, "Seçimi temizle");
    saveAll.addEventListener("click", (event) => {
      event.stopPropagation();
      this.saveSelection();
    });
    clear.addEventListener("click", (event) => {
      event.stopPropagation();
      this.clearSelection();
    });
    foot.append(saveAll, clear, el("span", { class: "brand" }, "Shift ile seçildi"));

    this.overlay.card.replaceChildren(
      el("div", { class: "lens-head" }, el("span", { class: "lens-word" }, "Seçilen kelimeler")),
      section("Shift + tıkla ile topla", list),
      foot
    );
    this.overlay.showCard(anchor, () => {});
  }

  /** Write every collected word to the saved list in one go. */
  async saveSelection() {
    const entries = [...this.selectedWords];
    if (!entries.length) return;
    let saved = 0;
    for (const entry of entries) {
      const response = await this.sendSave(
        this.buildSavePayload(entry.word, this.activeMap)
      );
      if (response) saved += 1;
    }
    this.overlay.flashSaved(`${saved} kelime kaydedildi ★`);
    this.clearSelection();
  }

  clearSelection() {
    this.selectedWords = [];
    this.overlay.clearSelection();
    this.overlay.hideCard();
  }

  /* ---------------------------------------------------------------- */
  /* Whole-line translation (Ctrl+click)                               */
  /* ---------------------------------------------------------------- */

  /** The full text of the caption under a point, if the point is on one. */
  lineTextAtPoint(x, y) {
    const root = this.resolver.rootsAtPoint(x, y);
    if (!root) return null;
    const map = this.getCharMap(root);
    const text = (map.text || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const rect = root.getBoundingClientRect();
    return {
      text,
      line: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom
      }
    };
  }

  async translateLineAtPoint(x, y) {
    const found = this.lineTextAtPoint(x, y);
    if (!found) return false;
    // Only act when the click was on the caption, not on empty video area.
    const map = this.getCharMap(this.resolver.rootsAtPoint(x, y));
    if (charIndexAtPoint(map, x, y) === -1) return false;

    this.lineRequest += 1;
    const request = this.lineRequest;
    this.activeLine = found.line;

    this.overlay.showLine(found.line, {
      source: found.text,
      pending: true,
      provider: ""
    });

    let payload;
    try {
      payload = await chrome.runtime.sendMessage({
        type: "lens:translate",
        payload: {
          text: found.text,
          sourceLang: this.settings.sourceLang || "auto",
          targetLang: this.settings.targetLang || "tr"
        }
      });
    } catch (error) {
      payload = { ok: false, error: String(error?.message || error) };
    }
    if (request !== this.lineRequest) return true;

    if (!payload?.ok) {
      this.overlay.showLine(found.line, {
        source: found.text,
        error: humanizeLineError(payload?.error),
        provider: ""
      });
      return true;
    }

    this.overlay.showLine(found.line, {
      source: found.text,
      text: payload.data.text,
      provider: payload.data.cached ? "önbellek" : payload.data.provider || "",
      pending: false
    });
    return true;
  }

  hideLine() {
    this.lineRequest += 1;
    this.activeLine = null;
    this.overlay.hideLine();
  }

  /** The cue text around a word, as the context worth remembering. */
  buildSavePayload(word, map) {
    const text = (map?.text || this.activeMap?.text || "").replace(/\s+/g, " ").trim();
    const data = this.lastData;
    return {
      word,
      translation: data?.translation?.text || "",
      phonetic: data?.translation?.phonetic || "",
      sourceLang: data?.sourceLang || this.settings.sourceLang || "auto",
      targetLang: this.settings.targetLang || "tr",
      definition: data?.dictionary?.entries?.[0]?.senses?.[0]?.definition || "",
      site: location.hostname,
      cue: text.slice(0, 300),
      url: location.href
    };
  }

  async sendSave(payload) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "lens:saveWord", payload });
      if (response?.ok) return response.data;
    } catch (error) {
      console.warn("[SubtitleLens] save failed", error);
    }
    return null;
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
    // The pointer may have moved off the caption; the card is only rendered
    // while it is still wanted.
    if (!this.overlay.visible && !this.overlay.pinned) return;
    // The content script can be orphaned by an extension reload, in which case
    // the service worker never answers.
    if (!this.overlay.card?.isConnected) return;

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

    try {
      renderResult(this.overlay.card, response.data, this.settings);
      this.lastData = response.data;
      this.reposition();
      this.wireCardActions(response.data, word);
      this.refreshSaveState(word);
    } catch (error) {
      // A provider can answer with a shape the renderer does not expect. That
      // is a bug, but it must not leave the card stuck on the spinner.
      console.error("[SubtitleLens] render failed", error);
      renderError(this.overlay.card, word, String(error?.message || error));
      this.reposition();
    }
  }

  /** Reflect whether the hovered word is already in the saved list. */
  async refreshSaveState(word) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "lens:listWords" });
      if (!response?.ok || !this.overlay.card?.isConnected) return;
      const key = String(word || "").toLowerCase();
      const saved = response.data.words.some((entry) => entry.key === key);
      this.overlay.setSaveState(saved);
    } catch {
      /* the card simply keeps its default state */
    }
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
    const save = card.querySelector('[data-action="save"]');
    const history = card.querySelector('[data-action="history"]');

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

    if (save) {
      save.addEventListener("click", async (event) => {
        event.stopPropagation();
        const alreadySaved = save.dataset.saved === "1";
        save.dataset.busy = "1";
        const response = await chrome.runtime
          .sendMessage(
            alreadySaved
              ? { type: "lens:removeWord", payload: { word } }
              : { type: "lens:saveWord", payload: this.buildSavePayload(word, this.activeMap) }
          )
          .catch(() => null);
        delete save.dataset.busy;

        if (!response?.ok) {
          this.overlay.flashSaved("Kaydedilemedi");
          return;
        }
        this.overlay.setSaveState(!alreadySaved);
        this.overlay.flashSaved(alreadySaved ? "Sözlükten çıkarıldı" : "Sözlüğe eklendi ★");
      });
    }

    if (history) {
      history.addEventListener("click", async (event) => {
        event.stopPropagation();
        const response = await chrome.runtime
          .sendMessage({ type: "lens:history", payload: { limit: 200 } })
          .catch(() => null);
        if (!response?.ok) return;
        this.showHistory(response.data.entries, word);
      });
    }
  }

  /**
   * Replace the card body with past encounters of this word, so the card doubles
   * as a small review surface without a trip to the library page.
   */
  showHistory(entries, word) {
    const key = String(word || "").toLowerCase();
    const matches = entries.filter((entry) => String(entry.word || "").toLowerCase() === key);
    const list = matches.length
      ? matches.map((entry) =>
          el(
            "div",
            { class: "lens-def" },
            el(
              "div",
              { class: "lens-def-text" },
              el("span", { class: "lens-def-pos" }, new Date(entry.at).toLocaleString("tr-TR")),
              entry.translation || "(çeviri yok)"
            ),
            entry.url ? el("div", { class: "lens-example" }, entry.url) : ""
          )
        )
      : [el("div", { class: "lens-def lens-muted" }, "Bu kelimeyi geçmişte görmediniz.")];

    this.overlay.card.replaceChildren(
      el("div", { class: "lens-head" }, el("span", { class: "lens-word" }, word)),
      section("Geçmiş", el("div", {}, ...list))
    );
    this.reposition();
  }

  dismiss() {
    this.openToken += 1;
    clearTimeout(this.pendingTimer);
    clearTimeout(this.graceTimer);
    clearTimeout(this.hintTimer);
    clearTimeout(this.selectionTimer);
    this.pendingTimer = null;
    this.graceTimer = null;
    this.hintTimer = null;
    this.lastData = null;
    this.activeWord = null;
    this.activeRoot = null;
    this.activeMap = null;
    this.anchor = null;
    this.overlay.hideHint();
    this.overlay.hideCard();
    this.overlay.hideHighlight();
  }
}

/** What a resting pointer is told it can do, in the order of usefulness. */
function hintText(settings) {
  const parts = [];
  if (settings.saveOnClick !== false) parts.push("tıkla: kaydet");
  if (settings.multiSelectOnShift !== false) parts.push("Shift+tıkla: çoklu seç");
  if (settings.translateWholeLine !== false) parts.push("Ctrl+tıkla: cümleyi çevir");
  return parts.join("  ·  ");
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
