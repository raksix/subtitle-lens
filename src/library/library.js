/**
 * Sözlüğüm: the saved-word list, the review session and the lookup history.
 *
 * All state lives in `chrome.storage.local` and is reached through the service
 * worker's message API, so this page and the content script can never disagree
 * about the list.
 */

import { dueWords } from "../common/words.js";

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Messaging                                                          */
/* ------------------------------------------------------------------ */

async function ask(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) throw new Error(response?.error || `${type} failed`);
  return response.data;
}

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

const state = {
  words: [],
  history: [],
  filter: "",
  sort: "recent",
  historyFilter: "",
  session: null
};

/* ------------------------------------------------------------------ */
/* Tabs                                                               */
/* ------------------------------------------------------------------ */

function showTab(name) {
  for (const button of document.querySelectorAll(".tabs button")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== name;
  }
  if (name === "history") refreshHistory();
  if (name === "review") refreshReviewSetup();
}

/* ------------------------------------------------------------------ */
/* Words                                                              */
/* ------------------------------------------------------------------ */

async function refreshWords() {
  const data = await ask("lens:listWords");
  state.words = data.words;
  const due = dueWords(state.words).length;
  $("summary").textContent = `${data.total} kayıtlı kelime · ${due} tekrar bekliyor`;
  renderWords();
}

function visibleWords() {
  const needle = state.filter.trim().toLowerCase();
  let words = state.words;
  if (needle) {
    words = words.filter(
      (entry) =>
        entry.word.toLowerCase().includes(needle) ||
        String(entry.translation || "").toLowerCase().includes(needle) ||
        String(entry.definition || "").toLowerCase().includes(needle)
    );
  }
  const sorters = {
    recent: (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0),
    oldest: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    seen: (a, b) => (b.timesSeen || 1) - (a.timesSeen || 1),
    alpha: (a, b) => a.word.localeCompare(b.word, "tr"),
    due: (a, b) => (a.dueAt || 0) - (b.dueAt || 0)
  };
  return [...words].sort(sorters[state.sort] || sorters.recent);
}

function renderWords() {
  const list = $("wordList");
  const words = visibleWords();
  if (!words.length) {
    list.replaceChildren(
      empty(
        state.words.length
          ? "Aramaya uyan kelime yok."
          : "Henüz kelime kaydetmedin. Altyazıda bir kelimeye tıklayınca buraya düşer."
      )
    );
    return;
  }

  const template = $("wordRow");
  const now = Date.now();
  list.replaceChildren(
    ...words.map((entry) => {
      const node = template.content.firstElementChild.cloneNode(true);
      node.querySelector(".row-word").textContent = entry.word;
      const phonetic = node.querySelector(".row-phonetic");
      phonetic.textContent = entry.phonetic ? `/${entry.phonetic}/` : "";
      const translation = node.querySelector(".row-translation");
      translation.textContent = entry.translation || "—";
      const definition = node.querySelector(".row-definition");
      definition.textContent = entry.definition || "";

      const badge = node.querySelector(".row-badge");
      if ((entry.dueAt || 0) <= now) {
        badge.textContent = "tekrar";
        badge.classList.add("due");
      } else if (entry.site) {
        badge.textContent = entry.site;
      } else {
        badge.remove();
      }

      node.querySelector(".row-count").textContent = `${entry.timesSeen || 1}×`;
      node.querySelector(".row-remove").addEventListener("click", async () => {
        await ask("lens:removeWord", { key: entry.key });
        await refreshWords();
      });
      return node;
    })
  );
}

function empty(text) {
  const node = document.createElement("div");
  node.className = "empty";
  node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ */
/* Review                                                             */
/* ------------------------------------------------------------------ */

async function refreshReviewSetup() {
  const now = Date.now();
  const due = dueWords(state.words, now);
  $("reviewCount").textContent = due.length
    ? `${due.length} kelime tekrar için hazır.`
    : "Şu an tekrar zamanı gelen kelime yok.";
  $("startReview").disabled = state.words.length === 0 && !$("reviewAll").checked;
}

function startReview() {
  const now = Date.now();
  const due = dueWords(state.words, now);
  const pool = $("reviewAll").checked ? state.words : due;
  const words = pool.length ? [...pool].sort(() => Math.random() - 0.5) : [];
  if (!words.length) return;

  state.session = { queue: words, index: 0, revealed: false };
  $("reviewSetup").hidden = true;
  $("reviewCard").hidden = false;
  renderReviewCard();
}

function renderReviewCard() {
  const session = state.session;
  if (!session) return;
  const entry = session.queue[session.index];
  if (!entry) return endReview();

  session.revealed = false;
  $("flashIndex").textContent = String(session.index + 1);
  $("flashTotal").textContent = String(session.queue.length);
  $("flashFront").textContent = entry.word;
  $("flashPhonetic").textContent = entry.phonetic ? `/${entry.phonetic}/` : "";
  $("flashSite").textContent = entry.site || "";
  $("flashSite").hidden = !entry.site;
  $("flashTranslation").textContent = entry.translation || "(çeviri kaydedilmemiş)";
  $("flashDefinition").textContent = entry.definition || "";
  $("flashCue").textContent = entry.cue || "";
  $("flashCue").hidden = !entry.cue;
  $("flashBack").hidden = true;
  $("gradeActions").hidden = true;
  $("revealCard").hidden = false;
}

function revealCard() {
  const session = state.session;
  if (!session) return;
  session.revealed = true;
  $("flashBack").hidden = false;
  $("revealCard").hidden = true;
  $("gradeActions").hidden = false;
}

async function grade(score) {
  const session = state.session;
  if (!session) return;
  const entry = session.queue[session.index];
  // An ungraded card is a lapse: it goes back into the queue rather than
  // advancing, so a session cannot be "passed" by clicking through.
  const response = await ask("lens:reviewWord", { key: entry.key, grade: score }).catch(() => null);
  if (response?.entry) {
    const index = state.words.findIndex((item) => item.key === entry.key);
    if (index !== -1) state.words[index] = response.entry;
  }

  if (score === 1) {
    session.index += 1;
  } else {
    // Reinsert a few cards later so a miss comes back within the session.
    const position = Math.min(session.index + 3, session.queue.length);
    session.queue.splice(position, 0, entry);
    session.index += 1;
  }
  if (session.index >= session.queue.length) return endReview();
  renderReviewCard();
}

function endReview() {
  state.session = null;
  $("reviewSetup").hidden = false;
  $("reviewCard").hidden = true;
  refreshWords();
  refreshReviewSetup();
}

/* ------------------------------------------------------------------ */
/* History                                                            */
/* ------------------------------------------------------------------ */

async function refreshHistory() {
  const data = await ask("lens:history", { limit: 400, query: state.historyFilter });
  state.history = data.entries;
  const list = $("historyList");
  if (!data.entries.length) {
    list.replaceChildren(
      empty(
        state.historyFilter
          ? "Geçmişte eşleşen kayıt yok."
          : "Geçmiş boş. Bir altyazı kelimesinin üzerine gelince buraya kaydedilir."
      )
    );
    return;
  }

  list.replaceChildren(
    ...data.entries.map((entry) => {
      const node = document.createElement("div");
      node.className = "row-item";

      const main = document.createElement("div");
      main.className = "row-main";
      const head = document.createElement("div");
      head.className = "row-head";
      const word = document.createElement("span");
      word.className = "row-word";
      word.textContent = entry.word;
      head.append(word);
      if (entry.phonetic) {
        const phonetic = document.createElement("span");
        phonetic.className = "row-phonetic muted";
        phonetic.textContent = `/${entry.phonetic}/`;
        head.append(phonetic);
      }
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = new Date(entry.at).toLocaleString("tr-TR");
      head.append(badge);

      const translation = document.createElement("div");
      translation.className = "row-translation";
      translation.textContent = entry.translation || "—";
      main.append(head, translation);

      const side = document.createElement("div");
      side.className = "row-side";
      const count = document.createElement("span");
      count.className = "row-count muted";
      count.textContent = `${entry.count || 1}×`;
      const save = document.createElement("button");
      save.className = "row-remove";
      save.type = "button";
      save.title = "Sözlüğe ekle";
      save.textContent = "★";
      save.addEventListener("click", async () => {
        await ask("lens:saveWord", {
          word: entry.word,
          translation: entry.translation,
          phonetic: entry.phonetic,
          targetLang: entry.targetLang
        });
        save.textContent = "✓";
        save.disabled = true;
        await refreshWords();
      });
      side.append(count, save);

      node.append(main, side);
      return node;
    })
  );
}

/* ------------------------------------------------------------------ */
/* Export                                                             */
/* ------------------------------------------------------------------ */

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportJson() {
  download(
    `subtitlelens-kelimeler-${stamp()}.json`,
    JSON.stringify(state.words, null, 2),
    "application/json"
  );
}

function exportCsv() {
  const columns = ["word", "translation", "phonetic", "definition", "site", "timesSeen", "streak", "createdAt", "lastSeen"];
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [columns.join(",")];
  for (const entry of state.words) {
    rows.push(columns.map((column) => escape(entry[column])).join(","));
  }
  // The BOM keeps Excel from mangling Turkish characters.
  download(
    `subtitlelens-kelimeler-${stamp()}.csv`,
    `\uFEFF${rows.join("\r\n")}`,
    "text/csv;charset=utf-8"
  );
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* Update banner                                                      */
/* ------------------------------------------------------------------ */

async function refreshUpdateBanner() {
  const state_ = await ask("lens:updateState").catch(() => null);
  if (!state_?.available) return;
  const banner = $("panel-update");
  banner.hidden = false;
  banner.replaceChildren();

  const text = document.createElement("div");
  text.innerHTML = `<strong>SubtitleLens ${state_.latest}</strong> hazır — şu an ${state_.current} kullanıyorsun.`;
  banner.append(text);

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  banner.append(spacer);

  if (state_.assetUrl) {
    const link = document.createElement("button");
    link.className = "primary";
    link.type = "button";
    link.textContent = "İndir";
    link.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "lens:checkUpdate", force: true }).catch(() => {});
      const refreshed = await ask("lens:updateState").catch(() => null);
      const url = refreshed?.assetUrl || state_.assetUrl;
      chrome.tabs.create({ url });
    });
    banner.append(link);
  }

  const notes = document.createElement("button");
  notes.className = "link";
  notes.type = "button";
  notes.textContent = "Sürüm notları";
  notes.addEventListener("click", () => chrome.tabs.create({ url: state_.releaseUrl }));
  banner.append(notes);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

function bind() {
  for (const button of document.querySelectorAll(".tabs button")) {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  }

  $("filter").addEventListener("input", (event) => {
    state.filter = event.target.value;
    renderWords();
  });
  $("sort").addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderWords();
  });
  $("exportJson").addEventListener("click", exportJson);
  $("exportCsv").addEventListener("click", exportCsv);

  $("startReview").addEventListener("click", startReview);
  $("revealCard").addEventListener("click", revealCard);
  $("gradeAgain").addEventListener("click", () => grade(0));
  $("gradeGood").addEventListener("click", () => grade(1));
  $("stopReview").addEventListener("click", endReview);
  $("speakCard").addEventListener("click", () => {
    const entry = state.session?.queue[state.session.index];
    if (!entry) return;
    const utterance = new SpeechSynthesisUtterance(entry.word);
    if (entry.sourceLang && entry.sourceLang !== "auto") utterance.lang = entry.sourceLang;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });

  // Space reveals, arrows grade: the keyboard path through a review session.
  document.addEventListener("keydown", (event) => {
    if (!state.session) return;
    if (event.key === " ") {
      event.preventDefault();
      if (!state.session.revealed) revealCard();
      else grade(1);
    } else if (state.session.revealed && (event.key === "1" || event.key === "ArrowLeft")) {
      grade(0);
    } else if (state.session.revealed && (event.key === "2" || event.key === "ArrowRight")) {
      grade(1);
    } else if (event.key === "Escape") {
      endReview();
    }
  });

  $("historyFilter").addEventListener("input", (event) => {
    state.historyFilter = event.target.value;
    refreshHistory();
  });
  $("clearHistory").addEventListener("click", async () => {
    await ask("lens:clearHistory");
    await refreshHistory();
  });
}

async function init() {
  bind();
  await refreshWords();
  await refreshReviewSetup();
  await refreshUpdateBanner();
  await refreshHistory();
}

init();
