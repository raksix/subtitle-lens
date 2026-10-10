/**
 * Unit tests for the word list, the review scheduler and the update check.
 *
 * The storage layer is exercised through the service worker with a stubbed
 * `chrome`, the same harness `providers.test.mjs` uses, because the merge and
 * scheduling rules only matter in combination with persistence.
 *
 * Usage: bun test/words.test.mjs
 */

/* ------------------------------------------------------------------ */
/* chrome stub                                                        */
/* ------------------------------------------------------------------ */

const store = new Map();
const messageListeners = [];
let syncSettings = { targetLang: "tr" };

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    getManifest: () => ({ version: "1.0.1" })
  },
  alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: async () => true },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {}
  },
  storage: {
    sync: { get: async () => ({ ...syncSettings }), set: async (p) => Object.assign(syncSettings, p) },
    local: {
      async get(key) {
        if (key === null || key === undefined) return Object.fromEntries(store);
        const all = Object.fromEntries(store);
        return key in all ? { [key]: all[key] } : {};
      },
      async set(object) {
        for (const [k, v] of Object.entries(object)) store.set(k, v);
      },
      async remove(key) {
        for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
      }
    }
  }
};

/* ------------------------------------------------------------------ */
/* fetch stub, so the update check is deterministic                    */
/* ------------------------------------------------------------------ */

let releasesResponse = null;

/** The GitHub path, used by the update-check tests. */
const releaseFetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("api.github.com")) {
    if (!releasesResponse) return new Response("", { status: 500 });
    return new Response(JSON.stringify(releasesResponse), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  return new Response("", { status: 404 });
};

/** A translation-only stub, used by the history tests. */
const providerFetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("translate.googleapis.com") || url.includes("clients5.google.com")) {
    const raw = /q=([^&]+)/.exec(url)?.[1] || "w";
    const word = decodeURIComponent(raw).replace(/\+/g, " ");
    return new Response(
      JSON.stringify([[[`çeviri:${word}`, word, null, null, 10]], null, "en", null, null, null, null, []]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (url.includes("freedictionaryapi") || url.includes("wiktionary")) {
    return new Response(JSON.stringify({ entries: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  return new Response("", { status: 404 });
};

/** Swapped per section; reset() always restores the release one. */
let fetchImpl = releaseFetch;
globalThis.fetch = (input, init) => fetchImpl(input, init);

/* ------------------------------------------------------------------ */

const { compareVersions, isNewer, parseVersion } = await import("../src/common/version.js");
await import("../src/background/service-worker.js");

const ask = (type, payload) =>
  new Promise((resolve) => messageListeners[0]({ type, payload }, null, resolve));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function reset() {
  store.clear();
  syncSettings = { targetLang: "tr" };
  releasesResponse = null;
  // Restore the default stub: a previous section may have swapped it out.
  fetchImpl = releaseFetch;
}

/* ================================================================== */
/* 1. Version comparison                                              */
/* ================================================================== */

check("plain versions compare numerically", compareVersions("1.10.0", "1.9.0") === 1);
check("a missing segment counts as zero", compareVersions("1.2", "1.2.0") === 0);
check("a leading v is ignored", compareVersions("v2.0.0", "1.9.9") === 1);
check("a prerelease sorts below its release", compareVersions("1.2.0-beta.1", "1.2.0") === -1);
check("a release sorts above its prerelease", compareVersions("1.2.0", "1.2.0-beta.1") === 1);
check("isNewer is strict", isNewer("1.0.1", "1.0.1") === false && isNewer("1.0.2", "1.0.1") === true);
check("four-part versions work", compareVersions("1.0.0.1", "1.0.0") === 1);
check("garbage parses to zeros", parseVersion("nonsense").numbers.every((n) => n === 0));

/* ================================================================== */
/* 2. Saving a word                                                   */
/* ================================================================== */

reset();
const saved = await ask("lens:saveWord", {
  word: "Run",
  translation: "koşmak",
  phonetic: "rʌn",
  definition: "To move swiftly.",
  site: "netflix.com",
  cue: "The children had to run to the station."
});
check("saving returns the stored entry", saved.ok === true && saved.data.entry.word === "Run");
check("a new word is reported as added", saved.data.added === true);

const list1 = await ask("lens:listWords");
check("the word appears in the list", list1.data.total === 1, `${list1.data.total} entries`);
check("the cue is kept as context", /children had to run/.test(list1.data.words[0].cue || ""));

/* Case and punctuation must not create a second entry. */
await ask("lens:saveWord", { word: "run.", translation: "koşmak" });
await ask("lens:saveWord", { word: "RUN", translation: "koşmak" });
const list2 = await ask("lens:listWords");
check(
  "case and trailing punctuation fold into one entry",
  list2.data.total === 1,
  `${list2.data.total} entries`
);
check("repeat encounters are counted", list2.data.words[0].timesSeen === 3, `${list2.data.words[0].timesSeen}×`);
check("the original capitalisation is kept", list2.data.words[0].word === "Run", list2.data.words[0].word);

/* A later lookup can fill in a translation that the first one lacked. */
reset();
await ask("lens:saveWord", { word: "harbour" });
await ask("lens:saveWord", { word: "harbour", translation: "liman" });
const filled = await ask("lens:listWords");
check(
  "a missing translation is filled in later",
  filled.data.words[0].translation === "liman",
  filled.data.words[0].translation
);

/* ================================================================== */
/* 3. Review scheduling                                               */
/* ================================================================== */

reset();
await ask("lens:saveWord", { word: "harbour", translation: "liman" });
const before = (await ask("lens:listWords")).data.words[0];
check("a new word is immediately due", before.dueAt <= Date.now(), `dueAt ${before.dueAt}`);

const good = await ask("lens:reviewWord", { word: "harbour", grade: 1 });
check("a correct answer advances the streak", good.data.entry.streak === 1, `streak ${good.data.entry.streak}`);
check(
  "a correct answer pushes the word into the future",
  good.data.entry.dueAt > Date.now(),
  new Date(good.data.entry.dueAt).toISOString()
);
check("the review count is tracked", good.data.entry.reviews === 1);

const good2 = await ask("lens:reviewWord", { word: "harbour", grade: 1 });
check("the interval grows with each success", good2.data.entry.streak === 2, `streak ${good2.data.entry.streak}`);

const again = await ask("lens:reviewWord", { word: "harbour", grade: 0 });
check("a miss resets the streak", again.data.entry.streak === 0, `streak ${again.data.entry.streak}`);
check("a miss makes the word due again", again.data.entry.dueAt <= Date.now());
check("reviews accumulate through a lapse", again.data.entry.reviews === 3, `${again.data.entry.reviews}`);

const dueNow = (await ask("lens:listWords")).data.due;
check("the due count reflects the lapse", dueNow === 1, `${dueNow} due`);

/* ================================================================== */
/* 4. Removing                                                        */
/* ================================================================== */

const removed = await ask("lens:removeWord", { word: "HARBOUR" });
check("removal is case insensitive", removed.data.removed === 1, `${removed.data.removed} removed`);
check("the list is empty after removal", (await ask("lens:listWords")).data.total === 0);

/* ================================================================== */
/* 5. History                                                         */
/* ================================================================== */

reset();
syncSettings = { targetLang: "tr", showDefinitions: true, useCambridge: true };
fetchImpl = providerFetch;

await ask("lens:query", { word: "harbour", targetLang: "tr", sourceLang: "en" });
await ask("lens:query", { word: "the", targetLang: "tr", sourceLang: "en" });
await ask("lens:query", { word: "lighthouse", targetLang: "tr", sourceLang: "en" });

const history = (await ask("lens:history", { limit: 50 })).data;
check(
  "content words are recorded in history",
  history.entries.some((e) => e.word === "harbour") &&
    history.entries.some((e) => e.word === "lighthouse"),
  history.entries.map((e) => e.word).join(", ")
);
check(
  "common words are filtered out by default",
  !history.entries.some((e) => e.word === "the"),
  history.entries.map((e) => e.word).join(", ")
);

/* Hovering the same word twice in a row is one event (Netflix re-renders the
   same cue); navigating away and back is not, which the interleaved queries
   above already prove. */
const harbourBefore = (await ask("lens:history", { limit: 50 })).data.entries.filter(
  (entry) => entry.word === "harbour"
).length;
await ask("lens:query", { word: "harbour", targetLang: "tr", sourceLang: "en" });
await ask("lens:query", { word: "harbour", targetLang: "tr", sourceLang: "en" });
const harbourAfter = (await ask("lens:history", { limit: 50 })).data.entries.filter(
  (entry) => entry.word === "harbour"
);
check(
  "two adjacent repeats add exactly one row",
  harbourAfter.length === harbourBefore + 1,
  `${harbourBefore} → ${harbourAfter.length} rows`
);
check("the repeat bumps a counter instead", (harbourAfter[0]?.count || 0) === 2, `${harbourAfter[0]?.count}×`);

const searched = (await ask("lens:history", { limit: 50, query: "light" })).data;
check("history search matches on the word", searched.entries.length === 1, `${searched.entries.length} rows`);

const forgotten = await ask("lens:forgetWord", { word: "lighthouse" });
check("a single history row can be forgotten", forgotten.data.removed === 1, `${forgotten.data.removed}`);

const cleared = await ask("lens:clearHistory");
check("clearing history reports how many rows went", cleared.data.cleared >= 1, `${cleared.data.cleared}`);
check("history is empty after clearing", (await ask("lens:history", {})).data.total === 0);

/* ================================================================== */
/* 6. Update check                                                    */
/* ================================================================== */

reset();
releasesResponse = {
  tag_name: "v9.9.9",
  name: "Big release",
  html_url: "https://github.com/raksix/subtitle-lens/releases/tag/v9.9.9",
  body: "notes",
  assets: [
    { name: "source.zip", browser_download_url: "https://example.com/source.zip" },
    { name: "SubtitleLens-extension.zip", browser_download_url: "https://example.com/ext.zip" }
  ]
};
const update = await ask("lens:checkUpdate", undefined);
check("a newer release is detected", update.data.available === true, `${update.data.current} → ${update.data.latest}`);
check("the version is normalised without the v", update.data.latest === "9.9.9", update.data.latest);
check("the extension asset is preferred over the source archive", /ext\.zip$/.test(update.data.assetUrl), update.data.assetUrl);
check("the release notes are kept", update.data.notes === "notes");

/* A release that is not newer must not raise the flag. */
reset();
releasesResponse = { tag_name: "v0.0.1", html_url: "https://example.com", assets: [] };
const older = await ask("lens:checkUpdate", undefined);
check("an older release is not an update", older.data.available === false, `${older.data.current} vs ${older.data.latest}`);

/* A network failure keeps the previous answer rather than wiping it. */
releasesResponse = { tag_name: "v9.9.9", html_url: "https://example.com/r", assets: [] };
const seeded = await ask("lens:checkUpdate", { force: true });
check("a forced check seeds the state", seeded.data.latest === "9.9.9", seeded.data.latest);

fetchImpl = async () => {
  throw new Error("offline");
};
const afterFailure = await ask("lens:checkUpdate", { force: true });
check(
  "a failed check does not erase the last known release",
  afterFailure.data.latest === "9.9.9" && Boolean(afterFailure.data.error),
  `latest=${afterFailure.data.latest} error=${afterFailure.data.error}`
);

/* ================================================================== */

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
