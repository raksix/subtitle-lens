/**
 * Provider failure-mode tests.
 *
 * These run the service worker as a plain ES module in Bun with a stubbed
 * `chrome` and a scripted `fetch`, so every failure path is deterministic:
 * no rate limits, no network, no browser. That matters because the failures
 * being tested are the ones a real subtitle session provokes — a burst of
 * lookups that trips a rate limit — and reproducing those against the live
 * providers is neither reliable nor polite.
 *
 * Usage: bun test/providers.test.mjs
 */

import { strict as assert } from "node:assert";

/* ------------------------------------------------------------------ */
/* chrome stub                                                        */
/* ------------------------------------------------------------------ */

const store = new Map();
const messageListeners = [];
let syncSettings = {};

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: () => {} }
  },
  storage: {
    sync: {
      get: async () => ({ ...syncSettings }),
      set: async (patch) => Object.assign(syncSettings, patch)
    },
    local: {
      async get(key) {
        if (key === null || key === undefined) {
          return Object.fromEntries(store);
        }
        return key in Object.fromEntries(store) ? { [key]: store.get(key) } : {};
      },
      async set(object) {
        for (const [key, value] of Object.entries(object)) store.set(key, value);
      },
      async remove(key) {
        for (const single of Array.isArray(key) ? key : [key]) store.delete(single);
      }
    }
  }
};

/* ------------------------------------------------------------------ */
/* fetch stub                                                         */
/* ------------------------------------------------------------------ */

const JSON_OK = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
const STATUS = (code) => new Response("", { status: code, statusText: String(code) });

/** url substring -> (url) => Response */
let routes = {};
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  for (const [needle, handler] of Object.entries(routes)) {
    if (url.includes(needle)) return handler(url);
  }
  return STATUS(404);
};

/** Track which hosts were actually asked, to prove fallback ordering. */
let calls = [];
const record = (needle, handler) => {
  routes[needle] = (url) => {
    calls.push(needle);
    return handler(url);
  };
};

/* ------------------------------------------------------------------ */
/* module under test                                                  */
/* ------------------------------------------------------------------ */

await import("../src/background/service-worker.js");

const query = (word, extra = {}) =>
  new Promise((resolve) => {
    messageListeners[0](
      { type: "lens:query", payload: { word, targetLang: "tr", sourceLang: "en", ...extra } },
      null,
      resolve
    );
  });

function reset({ settings = {}, script = {} } = {}) {
  store.clear();
  calls = [];
  routes = {};
  syncSettings = { targetLang: "tr", ...settings };
  for (const [needle, handler] of Object.entries(script)) record(needle, handler);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const GOOGLE_PRIMARY = "translate.googleapis.com";
const GOOGLE_FALLBACK = "clients5.google.com";
const MYMEMORY = "api.mymemory";
const FREEDICT = "freedictionaryapi.com";
const WIKTIONARY = "wiktionary.org";
const CAMBRIDGE = "dictionary.cambridge.org";

const googleBody = (text) => [[[text, "run", null, null, 10]], null, "en", null, null, null, null, []];

/* ------------------------------------------------------------------ */
/* 1. Primary translation host is rate limited                         */
/* ------------------------------------------------------------------ */

reset({
  script: {
    [GOOGLE_PRIMARY]: () => STATUS(429),
    [GOOGLE_FALLBACK]: () => JSON_OK(googleBody("koşmak")),
    [FREEDICT]: () => STATUS(200),
    [WIKTIONARY]: () => STATUS(200),
    [CAMBRIDGE]: () => STATUS(404)
  }
});
const rateLimited = (await query("rate1")).data;
check("429 on the primary host falls through to the fallback host", rateLimited.translation?.text === "koşmak", JSON.stringify(rateLimited.translation));
check("fallback attempt is visible in call order", calls.indexOf(GOOGLE_FALLBACK) > calls.indexOf(GOOGLE_PRIMARY), calls.join(" → "));
check("no translation error is reported when the fallback succeeded", !rateLimited.errors?.translation, JSON.stringify(rateLimited.errors));

/* ------------------------------------------------------------------ */
/* 2. Every translation provider fails                                 */
/* ------------------------------------------------------------------ */

reset({
  script: {
    [GOOGLE_PRIMARY]: () => STATUS(429),
    [GOOGLE_FALLBACK]: () => STATUS(429),
    [MYMEMORY]: () => STATUS(429),
    [FREEDICT]: () => JSON_OK({ word: "zqxjv", entries: [] }),
    [WIKTIONARY]: () => JSON_OK({}),
    [CAMBRIDGE]: () => STATUS(404)
  }
});
const dead = (await query("zqxjv")).data;
check("a total translation outage yields no translation value", !dead.translation, JSON.stringify(dead.translation));
check("the outage is reported as an error", Boolean(dead.errors?.translation), JSON.stringify(dead.errors));

/* ------------------------------------------------------------------ */
/* 3. MyMemory answers 200 with a service message                      */
/* ------------------------------------------------------------------ */

reset({
  script: {
    [GOOGLE_PRIMARY]: () => STATUS(429),
    [GOOGLE_FALLBACK]: () => STATUS(429),
    [MYMEMORY]: () =>
      JSON_OK({
        responseData: {
          translatedText:
            "'XX' IS AN INVALID TARGET LANGUAGE . EXAMPLE: LANGPAIR=EN|IT USING 2 LETTER ISO OR RFC3066 LIKE ZH-CN."
        },
        responseStatus: "403"
      }),
    [FREEDICT]: () => JSON_OK({ word: "run", entries: [] }),
    [WIKTIONARY]: () => JSON_OK({}),
    [CAMBRIDGE]: () => STATUS(404)
  }
});
const shouted = (await query("shout1")).data;
check(
  "a MyMemory service message is not rendered as a translation",
  !shouted.translation,
  JSON.stringify(shouted.translation)
);
check("the MyMemory refusal is reported", Boolean(shouted.errors?.translation), JSON.stringify(shouted.errors));

/* ------------------------------------------------------------------ */
/* 4. MyMemory with a real answer is used                              */
/* ------------------------------------------------------------------ */

reset({
  script: {
    [GOOGLE_PRIMARY]: () => STATUS(429),
    [GOOGLE_FALLBACK]: () => STATUS(429),
    [MYMEMORY]: () => JSON_OK({ responseData: { translatedText: "koşmak" }, responseStatus: 200 }),
    [FREEDICT]: () => STATUS(403),
    [WIKTIONARY]: () => JSON_OK({}),
    [CAMBRIDGE]: () => STATUS(404)
  }
});
const mymemoryOk = (await query("fallback1")).data;
check("a genuine MyMemory answer is accepted", mymemoryOk.translation?.text === "koşmak", JSON.stringify(mymemoryOk.translation));

/* ------------------------------------------------------------------ */
/* 5. Dictionary sources are independent                                */
/* ------------------------------------------------------------------ */

const wiktionaryBody = {
  en: [
    {
      partOfSpeech: "Verb",
      definitions: [{ definition: "To move <a href='/wiki/quickly'>quickly</a>.", examples: [] }]
    }
  ]
};
reset({
  script: {
    [GOOGLE_PRIMARY]: () => JSON_OK(googleBody("koşmak")),
    [FREEDICT]: () => STATUS(403),
    [WIKTIONARY]: () => JSON_OK(wiktionaryBody),
    [CAMBRIDGE]: () => STATUS(404)
  }
});
const wiki = (await query("wik1")).data;
check(
  "a 403 from the primary dictionary falls through to Wiktionary",
  wiki.dictionary?.source === "wiktionary" && wiki.dictionary.entries.length > 0,
  JSON.stringify(wiki.dictionary?.source)
);
check(
  "Wiktionary HTML is stripped out of the definition",
  !/<[a-z]/i.test(wiki.dictionary?.entries?.[0]?.senses?.[0]?.definition || "<none>"),
  wiki.dictionary?.entries?.[0]?.senses?.[0]?.definition
);

/* ------------------------------------------------------------------ */
/* 6. The caching rule that made an outage sticky                       */
/* ------------------------------------------------------------------ */

reset({
  script: {
    [GOOGLE_PRIMARY]: () => STATUS(429),
    [GOOGLE_FALLBACK]: () => STATUS(429),
    [MYMEMORY]: () => STATUS(429),
    [FREEDICT]: () => JSON_OK({ word: "stick1", entries: [] }),
    [WIKTIONARY]: () => JSON_OK({}),
    [CAMBRIDGE]: () => STATUS(404)
  }
});
await query("stick1");
const cacheKeys = [...store.keys()].filter((key) => key.startsWith("lens:cache:"));
check(
  "a result without a translation is not written to the long-lived cache",
  cacheKeys.length === 0,
  cacheKeys.join(", ") || "no cache entry written"
);

// And a successful lookup does get cached.
reset({
  script: {
    [GOOGLE_PRIMARY]: () => JSON_OK(googleBody("koşmak")),
    [FREEDICT]: () => JSON_OK({ word: "cached1", entries: [] }),
    [WIKTIONARY]: () => JSON_OK({}),
    [CAMBRIDGE]: () => STATUS(404)
  }
});
await query("cached1");
const goodKeys = [...store.keys()].filter((key) => key.startsWith("lens:cache:"));
check("a complete result is written to the cache", goodKeys.length === 1, goodKeys.join(", "));

// Second query must be served from the cache without touching the network.
const callsBefore = calls.length;
const cachedSecond = (await query("cached1")).data;
check(
  "the second lookup is served from cache",
  cachedSecond.cached === true && calls.length === callsBefore,
  `cached=${cachedSecond.cached}, calls=${calls.length - callsBefore}`
);

/* ------------------------------------------------------------------ */
/* 7. Cambridge: 302 on inflected forms, and dedupe                     */
/* ------------------------------------------------------------------ */

const cambridgeHtml = `
<div class="entry-body__el">
  <span class="pos dpos">verb</span>
  <div class="def-block">
    <span class="epp-xref dxref">A1</span>
    <div class="def ddef_d db">to move on your feet</div>
    <div class="def-body ddef_b"><span class="trans dtrans dtrans-se" lang="tr">koşmak</span>
      <div class="examp dexamp"><span class="eg deg">He can <a href="/x">run</a> fast.</span></div>
    </div>
  </div>
</div>`;
reset({
  script: {
    [GOOGLE_PRIMARY]: () => JSON_OK(googleBody("koşmak")),
    [FREEDICT]: () => JSON_OK({ word: "cam1", entries: [] }),
    [WIKTIONARY]: () => JSON_OK({}),
    [CAMBRIDGE]: () =>
      new Response(cambridgeHtml, { status: 200, headers: { "content-type": "text/html" } })
  }
});
const cam = (await query("cam1")).data;
check(
  "Cambridge EN→TR entry is parsed",
  cam.cambridge?.language === "english-turkish" && cam.cambridge.senses[0]?.translation === "koşmak",
  JSON.stringify(cam.cambridge?.senses?.[0]?.translation)
);
check(
  "Cambridge level and example come through",
  cam.cambridge?.senses?.[0]?.level === "A1" && cam.cambridge?.senses?.[0]?.examples?.[0]?.includes("run"),
  JSON.stringify(cam.cambridge?.senses?.[0])
);
check(
  "Cambridge links are stripped from examples",
  !/<a |<\/a>/.test(cam.cambridge?.senses?.[0]?.examples?.[0] || "<none>"),
  cam.cambridge?.senses?.[0]?.examples?.[0]
);

/* ------------------------------------------------------------------ */
/* 8. Input hygiene                                                     */
/* ------------------------------------------------------------------ */

reset({
  script: {
    [GOOGLE_PRIMARY]: () => JSON_OK(googleBody("koşmak")),
    [FREEDICT]: () => STATUS(200),
    [WIKTIONARY]: () => STATUS(200),
    [CAMBRIDGE]: () => STATUS(404)
  }
});
const longWord = await query("x".repeat(120));
check("an over-long token is rejected before any request", longWord.ok === false && /word-too-long/.test(longWord.error), longWord.error);
const nonWord = await query("!!!");
check("punctuation is rejected as not-a-word", nonWord.ok === false && /not-a-word/.test(nonWord.error), nonWord.error);
const trailing = (await query("running.")).data;
check("a trailing sentence period is trimmed", trailing.word === "running", trailing.word);

/* ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
void assert;
