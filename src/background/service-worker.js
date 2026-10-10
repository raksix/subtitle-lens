/**
 * Service worker: the only context allowed to talk to third-party APIs.
 *
 * Two reasons this exists instead of fetching straight from the content script:
 *  1. Cambridge has no `Access-Control-Allow-Origin`, so the page cannot read it.
 *  2. Every provider has a rate limit; requests must be coalesced across tabs.
 *
 * Requests come over `chrome.runtime.sendMessage` with a `type` of
 * "lens:query" and a `{ word, sourceLang, targetLang, hints }` payload.
 */

import { DEFAULT_SETTINGS } from "../common/settings.js";

/**
 * Google exposes the same response shape from more than one host. The primary
 * one starts answering 429 after a burst of lookups (a normal subtitle session
 * is exactly that burst), so the second is tried before giving up.
 */
const GOOGLE_ENDPOINTS = [
  "https://translate.googleapis.com/translate_a/single",
  "https://clients5.google.com/translate_a/single"
];
const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
const FREEDICT_ENDPOINT = "https://freedictionaryapi.com/api/v1/entries/en/";
const WIKTIONARY_ENDPOINT =
  "https://en.wiktionary.org/api/rest_v1/page/definition/";
const CAMBRIDGE_ENDPOINT = "https://dictionary.cambridge.org/dictionary/";

const CAMBRIDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
/**
 * A result missing its translation is a rate limit or a transient upstream
 * failure, not a property of the word. Caching that for 30 days would leave
 * the word broken until the cache is cleared by hand, so incomplete results
 * expire in a minute and get retried on the next hover.
 */
const PARTIAL_CACHE_TTL_MS = 60 * 1000;
const CACHE_PREFIX = "lens:cache:";
const CACHE_INDEX_KEY = "lens:cacheIndex";
const MAX_CACHE_ENTRIES = 1200;

/** Minimum gap between two outbound requests. */
const THROTTLE = {
  translate: 180,
  dictionary: 260,
  cambridge: 700
};

const MIN_WORD_LENGTH = 1;
const MAX_WORD_LENGTH = 60;
/** Latin letters, digits and the apostrophes/accents dictionaries actually use. */
const WORD_RE = /^[\p{L}\p{N}][\p{L}\p{N}'’\-.]*$/u;

/** In-flight lookups so two tabs asking for "run" share one network round trip. */
const inflight = new Map();
const lastCall = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "lens:query") {
    handleQuery(message.payload)
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String((error && error.message) || error)
        })
      );
    return true; // async response
  }

  if (message.type === "lens:clearCache") {
    clearCache()
      .then((removed) => sendResponse({ ok: true, removed }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "lens:cacheStats") {
    cacheStats()
      .then((stats) => sendResponse({ ok: true, data: stats }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

/* ------------------------------------------------------------------ */
/* Cache                                                              */
/* ------------------------------------------------------------------ */

function cacheKey(word, sourceLang, targetLang, wantsDictionary, wantsCambridge) {
  return [
    CACHE_PREFIX,
    word,
    sourceLang || "auto",
    targetLang,
    wantsDictionary ? "d" : "-",
    wantsCambridge ? "c" : "-"
  ].join("|");
}

async function readCache(key) {
  const store = await chrome.storage.local.get(key);
  const entry = store[key];
  if (!entry) return null;
  const ttl = entry.value?.translation?.text ? CACHE_TTL_MS : PARTIAL_CACHE_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.value;
}

async function writeCache(key, value) {
  await chrome.storage.local.set({ [key]: { at: Date.now(), value } });
  const index = (await chrome.storage.local.get(CACHE_INDEX_KEY))[
    CACHE_INDEX_KEY
  ] || { keys: [] };
  if (!index.keys.includes(key)) {
    index.keys.push(key);
    if (index.keys.length > MAX_CACHE_ENTRIES) {
      const overflow = index.keys.splice(0, index.keys.length - MAX_CACHE_ENTRIES);
      await chrome.storage.local.remove(overflow);
    }
    await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index });
  }
}

async function clearCache() {
  const index = (await chrome.storage.local.get(CACHE_INDEX_KEY))[
    CACHE_INDEX_KEY
  ] || { keys: [] };
  const keys = index.keys.filter((key) => key.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.remove(CACHE_INDEX_KEY);
  return keys.length;
}

async function cacheStats() {
  const index = (await chrome.storage.local.get(CACHE_INDEX_KEY))[
    CACHE_INDEX_KEY
  ] || { keys: [] };
  return { entries: index.keys.length };
}

/* ------------------------------------------------------------------ */
/* Query orchestration                                                */
/* ------------------------------------------------------------------ */

async function handleQuery(payload) {
  const settings = { ...DEFAULT_SETTINGS, ...(await loadSettings()) };
  const word = normalizeWord(payload && payload.word);
  if (!word) throw new Error("not-a-word");
  if (word.length > MAX_WORD_LENGTH) throw new Error("word-too-long");

  const targetLang = payload.targetLang || settings.targetLang;
  const sourceLang = payload.sourceLang || settings.sourceLang || "auto";
  const wantsDictionary = settings.showDefinitions;
  const wantsCambridge = settings.useCambridge;

  const key = cacheKey(word, sourceLang, targetLang, wantsDictionary, wantsCambridge);
  const cached = await readCache(key);
  if (cached) return { ...cached, cached: true };

  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    const [translation, dictionary, cambridge] = await Promise.all([
      attempt(() => translate(word, sourceLang, targetLang, settings)),
      wantsDictionary ? attempt(() => lookupDictionary(word)) : idle(),
      wantsCambridge ? attempt(() => lookupCambridge(word, targetLang, settings)) : idle()
    ]);

    const result = {
      word,
      targetLang,
      sourceLang: translation.value?.sourceLang || sourceLang,
      translation: translation.value,
      dictionary: dictionary.value,
      cambridge: cambridge.value,
      /**
       * Provider failures are reported separately from the data. A dictionary
       * with no entry for "the" is not an error, but a rate limit is, and the
       * card has to be able to say which happened.
       */
      errors: compact({
        translation: translation.error,
        dictionary: dictionary.error,
        cambridge: cambridge.error
      }),
      at: Date.now()
    };

    if (translation.value) {
      // Only a result with a real translation is worth 30 days. Anything less
      // is cached with a short TTL so a transient outage cannot pin a word.
      await writeCache(key, result);
    }
    return result;
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

async function loadSettings() {
  try {
    const store = await chrome.storage.sync.get(null);
    return store && typeof store === "object" ? store : {};
  } catch {
    const store = await chrome.storage.local.get("lens:settings");
    return (store && store["lens:settings"]) || {};
  }
}

function normalizeWord(value) {
  if (typeof value !== "string") return "";
  let word = value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  // Subtitles often wrap a word in punctuation; keep the inner token.
  word = word.replace(/^[\s"'“”‘’([{<«»…\-–—]+/, "");
  word = word.replace(/[\s"'“”‘’)\]}>,;:!?…»]+$/, "");
  if (!word) return "";
  if (word.length < MIN_WORD_LENGTH) return "";
  if (!WORD_RE.test(word)) return "";
  // A trailing sentence dot is punctuation, not part of the word.
  if (word.length > 1 && word.endsWith(".") && !word.endsWith("...")) {
    word = word.slice(0, -1);
  }
  return word;
}

/**
 * Run a provider and keep its failure beside its value instead of replacing it,
 * so the card can show whatever succeeded and name what did not.
 */
async function attempt(fn) {
  try {
    return { value: await fn(), error: null };
  } catch (error) {
    return { value: null, error: String((error && error.message) || error) };
  }
}

function idle() {
  return Promise.resolve({ value: null, error: null });
}

function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value) out[key] = value;
  }
  return out;
}

async function throttle(kind) {
  const gap = THROTTLE[kind] || 200;
  const previous = lastCall.get(kind) || 0;
  const wait = previous + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(kind, Date.now());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, kind, options = {}) {
  await throttle(kind);
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "follow",
    ...options
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchText(url, kind, options = {}) {
  await throttle(kind);
  const response = await fetch(url, {
    credentials: "omit",
    // Cambridge answers 302 for inflected forms ("runs", "walking"); following
    // it is what turns those into a result instead of an error.
    redirect: "follow",
    ...options
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/* ------------------------------------------------------------------ */
/* Translation providers                                              */
/* ------------------------------------------------------------------ */

async function translate(word, sourceLang, targetLang, settings) {
  const order =
    settings.provider === "google"
      ? ["google"]
      : settings.provider === "mymemory"
        ? ["mymemory"]
        : ["google", "mymemory"];

  let lastError = null;
  for (const provider of order) {
    try {
      const result =
        provider === "google"
          ? await translateGoogle(word, sourceLang, targetLang)
          : await translateMyMemory(word, sourceLang, targetLang);
      if (result && result.text) return { ...result, provider };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("translation-failed");
}

async function translateGoogle(word, sourceLang, targetLang) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: sourceLang && sourceLang !== "auto" ? sourceLang : "auto",
    tl: targetLang,
    q: word
  });
  // dt=t main translation, dt=bd dictionary alternatives, dt=rm romanisation.
  const query = `${params.toString()}&dt=t&dt=bd&dt=rm`;

  let lastError = null;
  for (const endpoint of GOOGLE_ENDPOINTS) {
    try {
      return parseGoogleResponse(await fetchJson(`${endpoint}?${query}`, "translate"));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("google-failed");
}

function parseGoogleResponse(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("google-bad-payload");
  }

  const text = data[0]
    .map((chunk) => (Array.isArray(chunk) ? chunk[0] : ""))
    .filter(Boolean)
    .join("")
    .trim();
  if (!text) throw new Error("google-empty");

  const phonetic =
    data[0].map((chunk) => (Array.isArray(chunk) ? chunk[3] : null)).find(Boolean) || null;

  const alternatives = [];
  if (Array.isArray(data[1])) {
    for (const group of data[1]) {
      if (!Array.isArray(group) || !Array.isArray(group[1])) continue;
      const pos = typeof group[0] === "string" ? group[0] : "";
      const terms = group[1].filter((term) => typeof term === "string");
      if (terms.length) alternatives.push({ pos, terms: terms.slice(0, 12) });
    }
  }

  return {
    text,
    phonetic,
    sourceLang: typeof data[2] === "string" ? data[2] : "auto",
    detectedLang: typeof data[2] === "string" ? data[2] : null,
    alternatives
  };
}

/**
 * MyMemory answers `200 OK` even when it refuses the request, with the error
 * text in `responseData.translatedText` (for example
 * `'XX' IS AN INVALID TARGET LANGUAGE`). Without the checks below that string
 * is rendered as if it were a translation.
 */
async function translateMyMemory(word, sourceLang, targetLang) {
  const source = sourceLang && sourceLang !== "auto" ? sourceLang : "en";
  const params = new URLSearchParams({
    q: word,
    langpair: `${source}|${targetLang}`,
    mt: "1"
  });
  const data = await fetchJson(`${MYMEMORY_ENDPOINT}?${params.toString()}`, "translate");

  const status = Number(data?.responseStatus);
  if (Number.isFinite(status) && status >= 400) {
    throw new Error(`mymemory-${status}`);
  }

  const text =
    data && data.responseData && typeof data.responseData.translatedText === "string"
      ? data.responseData.translatedText.trim()
      : "";
  if (!text) throw new Error("mymemory-empty");
  // Service messages are shouted and often wrapped in quotes.
  if (/INVALID|QUOTA|EXAMPLE:|MYMEMORY WARNING|_QUERY LENGTH LIMIT/i.test(text)) {
    throw new Error("mymemory-message");
  }
  if (text.length > 3 && text.startsWith("'") && text.endsWith("'") && /[A-Z]{3}/.test(text)) {
    throw new Error("mymemory-message");
  }

  return { text, phonetic: null, sourceLang: source, alternatives: [] };
}

/* ------------------------------------------------------------------ */
/* Dictionaries                                                       */
/* ------------------------------------------------------------------ */

async function lookupDictionary(word) {
  // Each source is independent: a 403 or a rate limit on the first must not
  // skip the second, and only a total failure is an error worth reporting.
  const primary = await attempt(() => freeDictionaryEntries(word));
  if (primary.value && primary.value.length) {
    return { source: "freedictionaryapi", entries: primary.value };
  }

  const fallback = await attempt(() => wiktionaryEntries(word));
  if (fallback.value && fallback.value.length) {
    return { source: "wiktionary", entries: fallback.value };
  }

  if (primary.error && fallback.error) {
    throw new Error(`${primary.error}; ${fallback.error}`);
  }
  return null; // both sources answered, neither knows the word
}

async function freeDictionaryEntries(word) {
  const data = await fetchJson(
    FREEDICTORY_URL(word),
    "dictionary",
    { headers: { Accept: "application/json" } }
  );
  if (!data || !Array.isArray(data.entries)) return [];

  const seen = new Set();
  const entries = [];
  for (const raw of data.entries) {
    const pos = raw.partOfSpeech || "";
    const pronunciations = (raw.pronunciations || [])
      .filter((p) => p && p.type === "ipa" && p.text && !p.tags?.includes("obsolete"))
      .map((p) => ({ text: p.text, tags: p.tags || [] }));
    const senses = flattenSenses(raw.senses || [], 0)
      .map((sense) => ({
        definition: sense.definition,
        examples: (sense.examples || []).slice(0, 2)
      }))
      .filter((sense) => sense.definition && !seen.has(pos + "|" + sense.definition));

    for (const sense of senses) seen.add(pos + "|" + sense.definition);
    if (!senses.length) continue;

    entries.push({
      pos,
      pronunciations,
      senses: senses.slice(0, 6),
      synonyms: (raw.synonyms || []).slice(0, 8),
      antonyms: (raw.antonyms || []).slice(0, 6)
    });
  }
  return entries;
}

function FREEDICTORY_URL(word) {
  return FREEDICT_ENDPOINT + encodeURIComponent(word);
}

/** Depth-limited flatten; the nested subsenses are what users actually read. */
function flattenSenses(senses, depth, out = []) {
  if (!Array.isArray(senses) || depth > 2) return out;
  for (const sense of senses) {
    if (sense && typeof sense.definition === "string" && sense.definition) {
      out.push({
        definition: sense.definition,
        examples: Array.isArray(sense.examples)
          ? sense.examples.filter((e) => typeof e === "string")
          : []
      });
    }
    if (sense && Array.isArray(sense.subsenses) && sense.subsenses.length) {
      flattenSenses(sense.subsenses, depth + 1, out);
    }
  }
  return out;
}

async function wiktionaryEntries(word) {
  const data = await fetchJson(
    WIKTIONARY_ENDPOINT + encodeURIComponent(word),
    "dictionary",
    { headers: { Accept: "application/json" } }
  );
  const english = data && data.en;
  if (!Array.isArray(english)) return [];

  const entries = [];
  for (const block of english) {
    const pos = normalizeWiktionaryPos(block.partOfSpeech);
    if (!pos) continue;
    const senses = (block.definitions || [])
      .map((definition) => ({
        definition: stripHtml(definition.definition || ""),
        examples: (definition.examples || [])
          .map((example) => stripHtml(example))
          .filter(Boolean)
          .slice(0, 2)
      }))
      .filter((sense) => sense.definition)
      .slice(0, 6);
    if (!senses.length) continue;
    entries.push({ pos, pronunciations: [], senses, synonyms: [], antonyms: [] });
  }
  return entries;
}

const POS_WHITELIST = new Set([
  "noun",
  "verb",
  "adjective",
  "adverb",
  "pronoun",
  "preposition",
  "conjunction",
  "interjection",
  "determiner",
  "numeral",
  "particle",
  "proper noun"
]);

function normalizeWiktionaryPos(value) {
  if (typeof value !== "string") return "";
  const pos = value.toLowerCase();
  if (!POS_WHITELIST.has(pos)) return "";
  return pos.replace(/\b\w/g, (character) => character.toUpperCase());
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Cambridge                                                          */
/* ------------------------------------------------------------------ */

async function lookupCambridge(word, targetLang, settings) {
  const mode = chooseCambridgeMode(settings, targetLang);
  const langs = mode === "en-tr" ? ["english-turkish", "english"] : ["english"];

  for (const lang of langs) {
    try {
      const html = await fetchText(
        `${CAMBRIDGE_ENDPOINT}${lang}/${encodeURIComponent(word)}`,
        "cambridge",
        {
          headers: {
            "User-Agent": CAMBRIDGE_UA,
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9"
          }
        }
      );
      const parsed = parseCambridgeHtml(html, lang === "english-turkish");
      if (parsed && parsed.senses.length) {
        return { ...parsed, language: lang };
      }
    } catch {
      /* try the next language variant */
    }
  }
  return null;
}

function chooseCambridgeMode(settings, targetLang) {
  if (settings.cambridgeLangMode === "en-tr") return "en-tr";
  if (settings.cambridgeLangMode === "en") return "en";
  return targetLang === "tr" ? "en-tr" : "en";
}

/**
 * Cambridge has no `Access-Control-Allow-Origin`, so this runs on the raw HTML
 * string rather than a parsed document: `DOMParser` does not exist in a
 * service worker. Only stable class tokens are matched, and attributes are
 * allowed before or after `class` since Cambridge renders both.
 */
const CAM_IPA_RE = /<span class="ipa[^"]*">([^<]*)<\/span>/g;
const CAM_POS_RE = /<span[^>]*class="[^"]*\bpos dpos\b[^"]*"[^>]*>([^<]*)</;
const CAM_XREF_RE = /<span[^>]*class="[^"]*\bepp-xref\b[^"]*"[^>]*>([^<]*)</;
const CAM_TRANS_RE = /<span[^>]*class="[^"]*\btrans dtrans\b[^"]*"[^>]*>([\s\S]*?)<\/span>/;
const CAM_DEF_RE = /<div[^>]*class="[^"]*\bddef_d\b[^"]*"[^>]*>([\s\S]*?)(?:<div|<\/div>)/;
const CAM_EG_RE = /<span[^>]*class="[^"]*\bdeg\b[^"]*"[^>]*>([\s\S]*?)<\/span>/g;

function splitByClassToken(html, token) {
  const parts = html.split(new RegExp(`<div[^>]*class="[^"]*\\b${token}\\b[^"]*"[^>]*>`));
  return parts.slice(1);
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCambridgeHtml(html, hasTranslation) {
  const pronunciations = [];
  for (const match of html.matchAll(CAM_IPA_RE)) {
    const text = decodeEntities(match[1]);
    if (text && !pronunciations.includes(text)) pronunciations.push(text);
  }

  const scopes = splitByClassToken(html, "entry-body__el");
  const roots = scopes.length ? scopes : [html];
  const senses = [];

  for (const scope of roots) {
    const posMatch = scope.match(CAM_POS_RE);
    const pos = posMatch ? decodeEntities(posMatch[1]) : "";

    for (const block of splitByClassToken(scope, "def-block")) {
      const transMatch = block.match(CAM_TRANS_RE);
      const translation = transMatch ? decodeEntities(transMatch[1]) : "";
      const defMatch = block.match(CAM_DEF_RE);
      const definition = defMatch ? decodeEntities(defMatch[1]) : "";
      const levelMatch = block.match(CAM_XREF_RE);

      const examples = [];
      for (const eg of block.matchAll(CAM_EG_RE)) {
        const text = decodeEntities(eg[1]);
        if (text && examples.length < 2) examples.push(text);
      }

      if (!translation && !definition) continue;
      senses.push({
        translation,
        definition,
        examples,
        level: levelMatch ? decodeEntities(levelMatch[1]) : "",
        pos
      });
    }
  }

  return {
    hasTranslation,
    pronunciations,
    senses: senses.slice(0, 8)
  };
}

/* Keep the service worker warm for the first hover of a session. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get("targetLang").then((store) => {
    if (!store || !store.targetLang) {
      chrome.storage.sync.set({ targetLang: DEFAULT_SETTINGS.targetLang });
    }
  });
});
