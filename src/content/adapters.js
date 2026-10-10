/**
 * Site knowledge: where does this page put its subtitles?
 *
 * Every streaming player renders captions differently, and two of them
 * (Netflix, Prime Video) replace the cue's DOM nodes on each cue change. So the
 * resolver is cheap to re-run and never caches element identity for long: it
 * caches *selectors*, re-querying on a short TTL.
 */

const HOST_SELECTOR = "[data-subtitle-lens]";

export const ADAPTERS = {
  netflix: {
    label: "Netflix",
    container: [".player-timedtext"],
    text: [".player-timedtext-text-container"]
  },
  youtube: {
    label: "YouTube",
    container: [".ytp-caption-window-container"],
    text: [".ytp-caption-segment", ".caption-visual-line"]
  },
  primevideo: {
    label: "Prime Video",
    container: [
      ".atvwebplayersdk-captions-overlay",
      ".atvwebplayersdk-captions-text"
    ],
    text: [".atvwebplayersdk-captions-text", ".atvwebplayersdk-captions-line"]
  },
  disneyplus: {
    label: "Disney+",
    container: [
      ".dss-subtitle-renderer-cue",
      ".dss-subtitle-renderer",
      '[data-testid="subtitle_region"]',
      '[class*="SubtitleRenderer"]'
    ],
    text: ['[class*="SubtitleCue"]', ".dss-subtitle-renderer-cue"]
  },
  hbomax: {
    label: "HBO Max",
    container: [
      '[class*="SubtitleCue"]',
      '[class*="subtitle-cue"]',
      '[data-testid*="subtitle"]'
    ],
    text: []
  },
  mubi: {
    label: "MUBI",
    container: ['[class*="subtitle"]', '[class*="Subtitle"]'],
    text: []
  },
  appletv: {
    label: "Apple TV+",
    container: ['[class*="SubtitleRenderer"]', '[class*="caption"]'],
    text: []
  },
  generic: {
    label: "Generic",
    container: [],
    text: []
  }
};

const HOSTNAME_ADAPTERS = [
  [/^(www\.)?netflix\.com$/i, "netflix"],
  [/^(www\.|m\.|music\.)?youtube(-nocookie)?\.com$/i, "youtube"],
  [/(primevideo\.com|amazon\.[a-z.]+)$/i, "primevideo"],
  [/disneyplus\.com$/i, "disneyplus"],
  [/(hbomax\.com|max\.com)$/i, "hbomax"],
  [/mubi\.com$/i, "mubi"],
  [/tv\.apple\.com$/i, "appletv"]
];

export function detectSite(hostname = location.hostname) {
  for (const [pattern, id] of HOSTNAME_ADAPTERS) {
    if (pattern.test(hostname)) return id;
  }
  return "generic";
}

/** Selector used when the user has not configured one for this host. */
export function defaultSelectorFor(siteId) {
  const adapter = ADAPTERS[siteId] || ADAPTERS.generic;
  return adapter.container[0] || "";
}

/* ------------------------------------------------------------------ */
/* Root resolution                                                    */
/* ------------------------------------------------------------------ */

const GENERIC_HEURISTIC_SELECTOR = [
  '[class*="caption" i]',
  '[class*="subtitle" i]',
  '[class*="timedtext" i]',
  '[class*="cue" i]',
  "[role='caption']",
  "[data-testid*='caption' i]",
  "[data-testid*='subtitle' i]"
].join(",");

const SCAN_TTL_MS = 600;
const MAX_ROOTS = 12;
const MIN_ROOT_WIDTH = 40;
const MIN_ROOT_HEIGHT = 8;

export class RootResolver {
  constructor(settings) {
    this.settings = settings;
    this.siteId = detectSite();
    this.cache = [];
    this.cacheAt = 0;
    this.lastSignature = "";
  }

  update(settings) {
    this.settings = settings;
    this.siteId = detectSite();
    this.invalidate();
  }

  invalidate() {
    this.cacheAt = 0;
    this.lastSignature = "";
  }

  /** Force a re-query on the next access (called from a MutationObserver). */
  rootsAtPoint(x, y, now = Date.now()) {
    const roots = this.getRoots(now);
    for (const root of roots) {
      const rect = rectCacheGet(root);
      if (
        rect &&
        x >= rect.left - 2 &&
        x <= rect.right + 2 &&
        y >= rect.top - 4 &&
        y <= rect.bottom + 4
      ) {
        return root;
      }
    }
    return null;
  }

  getRoots(now = Date.now()) {
    if (now - this.cacheAt < SCAN_TTL_MS && this.cache.length) return this.cache;

    const siteConfig = this.settings.sites?.[location.hostname] || {};
    const selector = this.resolvedSelector(siteConfig);
    const found = selector
      ? querySelectorAllDeep(selector)
      : this.resolveByAdapter();

    const roots = dedupeRoots(found)
      .filter((element) => !element.closest(HOST_SELECTOR))
      .filter(isUsableRoot)
      .slice(0, MAX_ROOTS);

    const signature = roots.map((element) => `${element.tagName}.${element.className}`).join("|");
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      charMapCache.clear();
    }

    this.cache = roots;
    this.cacheAt = now;
    return roots;
  }

  resolvedSelector(siteConfig) {
    const custom = siteConfig.selector || this.settings.customSelector;
    if (custom && (this.settings.globalSelectorOverride || siteConfig.selector)) {
      return custom;
    }
    if (custom && this.siteId === "generic") return custom;
    return "";
  }

  resolveByAdapter() {
    const adapter = ADAPTERS[this.siteId] || ADAPTERS.generic;
    const results = [];

    for (const selector of adapter.container) {
      results.push(...querySelectorAllDeep(selector));
    }
    if (this.siteId !== "generic" && results.length) return results;

    // The heuristic only runs for unknown sites, so it can afford to be broad.
    if (adapter === ADAPTERS.generic || !results.length) {
      results.push(...this.heuristicRoots());
    }
    return results;
  }

  heuristicRoots() {
    const candidates = querySelectorAllDeep(GENERIC_HEURISTIC_SELECTOR);
    const out = [];
    for (const element of candidates) {
      if (out.length >= MAX_ROOTS) break;
      const text = element.textContent || "";
      if (text.length < 1 || text.length > 400) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < MIN_ROOT_WIDTH || rect.height < MIN_ROOT_HEIGHT) continue;
      // Subtitles sit in the lower half; a "caption" higher up is chrome/UI.
      if (rect.top < window.innerHeight * 0.35) continue;
      if (out.some((other) => other.contains(element))) continue;
      out.push(element);
    }
    return out;
  }
}

function isUsableRoot(element) {
  if (!element || element.nodeType !== 1) return false;
  if (typeof element.checkVisibility === "function" && !element.checkVisibility()) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width < MIN_ROOT_WIDTH || rect.height < MIN_ROOT_HEIGHT) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (Number(style.opacity) === 0) return false;
  if (!(element.textContent || "").trim()) return false;
  return true;
}

function dedupeRoots(elements) {
  const out = [];
  for (const element of elements) {
    if (!element || element.nodeType !== 1) continue;
    if (out.includes(element)) continue;
    if (out.some((other) => other.contains(element))) continue;
    out.push(element);
  }
  return out;
}

/** querySelectorAll across open shadow roots, breadth limited. */
export function querySelectorAllDeep(selector, root = document, depth = 0) {
  const out = [];
  if (depth > 4) return out;

  try {
    out.push(...root.querySelectorAll(selector));
  } catch {
    return out;
  }

  const all = root.querySelectorAll("*");
  let inspected = 0;
  for (const element of all) {
    if (inspected > 1500) break;
    inspected += 1;
    if (element.shadowRoot) {
      out.push(...querySelectorAllDeep(selector, element.shadowRoot, depth + 1));
    }
  }
  return out;
}

/* Weak geometry cache: a root's rect is read on every pointermove otherwise. */
const rectCache = new WeakMap();
const RECT_TTL_MS = 250;

export function rectCacheGet(element) {
  const now = Date.now();
  const hit = rectCache.get(element);
  if (hit && now - hit.at < RECT_TTL_MS) return hit.rect;
  const rect = element.getBoundingClientRect();
  rectCache.set(element, { at: now, rect });
  return rect;
}

export function rectCacheInvalidate() {
  // WeakMap cannot be cleared; rely on the short TTL plus explicit reset below.
}

/* ------------------------------------------------------------------ */

export const charMapCache = new Map();
