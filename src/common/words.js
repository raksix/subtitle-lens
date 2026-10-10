/**
 * Word-list logic: normalisation, review scheduling and merge rules.
 *
 * Pure functions, shared by the service worker that owns the storage and by the
 * library page that renders it, so both agree on what "the same word" means and
 * on when it is due.
 */

/** Leitner-style intervals in days, indexed by review streak. */
const REVIEW_INTERVALS_DAYS = [0, 1, 3, 7, 16, 35, 75];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Storage keys, kept in one place so a typo cannot silently split the list. */
export const KEYS = {
  words: "lens:words",
  history: "lens:history",
  update: "lens:update"
};

export const MAX_WORDS = 3000;

/** The identity of a word in the list: case and punctuation insensitive. */
export function wordKey(word) {
  let key = String(word || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/^[\s"'“”‘’([{<«»…\-–—]+/, "")
    .replace(/[\s"'“”‘’)\]}>,;:!?…»]+$/, "")
    .trim();
  // A sentence-ending period is punctuation, not part of the headword. Kept
  // separate from the strip above because "e.g." and "..." are not headwords
  // either, but an internal dot ("u.s.") must survive.
  if (key.length > 1 && key.endsWith(".") && !key.endsWith("..")) {
    key = key.slice(0, -1);
  }
  return key;
}

export function isRecordable(word, { minLength = 2, ignoreCommon = true, common = null } = {}) {
  const key = wordKey(word);
  if (key.length < minLength) return false;
  if (!/\p{L}/u.test(key)) return false;
  if (ignoreCommon && common && common.has(key)) return false;
  return true;
}

/**
 * Create or update an entry. A word met again keeps its review progress but
 * refreshes `lastSeen` and collects the new source, so the list reads as a
 * history of where the word was met rather than a set of duplicates.
 */
export function mergeWordEntry(existing, incoming, now = Date.now()) {
  if (!existing) {
    return {
      key: wordKey(incoming.word),
      word: incoming.word,
      translation: incoming.translation || "",
      phonetic: incoming.phonetic || "",
      sourceLang: incoming.sourceLang || "auto",
      targetLang: incoming.targetLang || "",
      definition: incoming.definition || "",
      site: incoming.site || "",
      cue: incoming.cue || "",
      createdAt: now,
      lastSeen: now,
      timesSeen: 1,
      reviews: 0,
      streak: 0,
      dueAt: now,
      lastReviewedAt: 0
    };
  }

  return {
    ...existing,
    // Keep the first translation but fill in a missing one later.
    translation: existing.translation || incoming.translation || "",
    phonetic: existing.phonetic || incoming.phonetic || "",
    definition: existing.definition || incoming.definition || "",
    site: incoming.site || existing.site,
    cue: incoming.cue || existing.cue,
    lastSeen: now,
    timesSeen: (existing.timesSeen || 1) + 1
  };
}

/**
 * Schedule the next review. `grade` is 0 for "again" and 1 for "knew it":
 * a lapse resets the streak so the word comes back immediately, a success moves
 * it one interval further out.
 */
export function scheduleReview(entry, grade, now = Date.now()) {
  const knew = grade === 1 || grade === "good" || grade === true;
  const streak = knew ? Math.min((entry.streak || 0) + 1, REVIEW_INTERVALS_DAYS.length - 1) : 0;
  const intervalDays = REVIEW_INTERVALS_DAYS[streak];
  return {
    ...entry,
    streak,
    reviews: (entry.reviews || 0) + 1,
    lastReviewedAt: now,
    dueAt: intervalDays === 0 ? now : now + intervalDays * DAY_MS
  };
}

/** Entries that are due, most overdue first. */
export function dueWords(words, now = Date.now(), limit = Infinity) {
  return words
    .filter((entry) => (entry.dueAt || 0) <= now)
    .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0))
    .slice(0, limit);
}

/** Newest first, for the browse list. */
export function byRecency(words) {
  return [...words].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

/** Keep the list bounded without dropping words that are mid-review. */
export function trimWords(words, limit = MAX_WORDS) {
  if (words.length <= limit) return words;
  const sorted = [...words].sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
  const dropCount = words.length - limit;
  const droppable = sorted.filter((entry) => !entry.streak);
  const keep = new Set();
  for (const entry of droppable.slice(0, droppable.length)) {
    if (keep.size >= droppable.length - dropCount) break;
    keep.add(entry.key);
  }
  return words.filter((entry) => !keep.has(entry.key));
}
