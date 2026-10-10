import { DEFAULT_SETTINGS, LANGUAGES } from "../common/settings.js";

const $ = (id) => document.getElementById(id);

const FIELDS = [
  "enabled",
  "showPhonetic",
  "showDefinitions",
  "showExamples",
  "showGoogleAlternatives",
  "showSynonyms",
  "useCambridge",
  "globalSelectorOverride",
  "saveOnClick",
  "recordHistory",
  "multiSelectOnShift",
  "translateWholeLine",
  "historyIgnoreCommon",
  "autoUpdateCheck"
];

const RANGES = [
  ["hoverDelay", (value) => `${value} ms`],
  ["gracePeriod", (value) => `${value} ms`],
  ["cardWidth", (value) => `${value} px`],
  ["cardOpacity", (value) => `${Number(value).toFixed(2)}`],
  ["cardBlur", (value) => `${value} px`],
  ["fontScale", (value) => `${Number(value).toFixed(2)}×`]
];

const NUMBERS = [
  ["maxDefinitions", 1, 8],
  ["historyLimit", 20, 5000],
  ["historyMinLength", 1, 10]
];

let settings = { ...DEFAULT_SETTINGS };

init();

async function init() {
  settings = await readSettings();
  fillSelects();
  render();
  bind();
  await refreshCacheStats();
  await refreshLibraryStats();
  await refreshUpdateState();
}

async function refreshLibraryStats() {
  const response = await chrome.runtime.sendMessage({ type: "lens:listWords" }).catch(() => null);
  if (!response?.ok) {
    $("libraryStats").textContent = "Sözlük okunamadı";
    return;
  }
  const { total, due } = response.data;
  $("libraryStats").textContent = `${total} kelime · ${due} tekrar bekliyor`;
}

async function refreshUpdateState() {
  const response = await chrome.runtime.sendMessage({ type: "lens:updateState" }).catch(() => null);
  if (!response?.ok) {
    $("updateState").textContent = "Durum okunamadı";
    return;
  }
  const state = response.data;
  const when = state.checkedAt ? new Date(state.checkedAt).toLocaleString("tr-TR") : "hiç";
  const release = $("openRelease");
  release.hidden = !state.releaseUrl;

  if (state.error && !state.latest) {
    $("updateState").textContent = `Kontrol başarısız: ${state.error}`;
    return;
  }
  $("updateState").textContent = state.available
    ? `Yeni sürüm hazır: ${state.latest} (kurulu: ${state.current})`
    : `Güncel — sürüm ${state.current}. Son kontrol: ${when}`;
}

function fillSelects() {
  $("targetLang").replaceChildren(
    ...LANGUAGES.map((l) => new Option(l.label, l.code))
  );
  $("sourceLang").replaceChildren(
    new Option("Otomatik algıla", "auto"),
    ...LANGUAGES.map((l) => new Option(l.label, l.code))
  );
}

function render() {
  for (const id of FIELDS) $(id).checked = settings[id] !== false;
  $("targetLang").value = settings.targetLang;
  $("sourceLang").value = settings.sourceLang || "auto";
  $("provider").value = settings.provider || "auto";
  $("cambridgeLangMode").value = settings.cambridgeLangMode || "auto";
  $("theme").value = settings.theme || "dark";
  $("customSelector").value = settings.customSelector || "";
  $("maxDefinitions").value = settings.maxDefinitions ?? 4;

  for (const [id, format] of RANGES) {
    $(id).value = String(settings[id]);
    $(`${id}Out`).textContent = format(settings[id]);
  }
  for (const [id] of NUMBERS) {
    $(id).value = String(settings[id]);
  }
}

function bind() {
  for (const id of FIELDS) {
    $(id).addEventListener("change", (event) => save({ [id]: event.target.checked }));
  }

  for (const id of [
    "targetLang",
    "sourceLang",
    "provider",
    "cambridgeLangMode",
    "theme",
    "customSelector"
  ]) {
    $(id).addEventListener("change", (event) => save({ [id]: event.target.value }));
  }

  for (const [id, min, max] of NUMBERS) {
    $(id).addEventListener("change", (event) => {
      const fallback = settings[id];
      const value = Math.min(max, Math.max(min, Number(event.target.value) || fallback));
      event.target.value = String(value);
      save({ [id]: value });
    });
  }

  $("openLibrary").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/library/library.html") });
  });

  $("checkUpdate").addEventListener("click", async () => {
    $("updateState").textContent = "Kontrol ediliyor…";
    await chrome.runtime.sendMessage({ type: "lens:checkUpdate", force: true }).catch(() => null);
    await refreshUpdateState();
  });

  $("openRelease").addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: "lens:updateState" }).catch(() => null);
    const url =
      response?.data?.releaseUrl || "https://github.com/raksix/subtitle-lens/releases";
    chrome.tabs.create({ url });
  });

  for (const [id, format] of RANGES) {
    $(id).addEventListener("input", (event) => {
      $(`${id}Out`).textContent = format(event.target.value);
    });
    $(id).addEventListener("change", (event) => {
      const raw = Number(event.target.value);
      // Keep the scale-style settings fractional and snap the pixel ones.
      const value = id === "fontScale" || id === "cardOpacity" ? raw : Math.round(raw);
      save({ [id]: value });
    });
  }

  $("clearCache").addEventListener("click", async () => {
    $("cacheStatus").textContent = "Temizleniyor…";
    const response = await chrome.runtime.sendMessage({ type: "lens:clearCache" });
    $("cacheStatus").textContent = response?.ok
      ? `${response.removed} kayıt silindi`
      : "Temizlenemedi";
    await refreshCacheStats();
  });
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set(patch);
}

async function refreshCacheStats() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "lens:cacheStats" });
    $("cacheCount").textContent = response?.ok
      ? `Önbellekte ${response.data.entries} kayıt`
      : "Önbellek durumu okunamadı";
  } catch {
    $("cacheCount").textContent = "Servis çalışmıyor";
  }
}

async function readSettings() {
  const store = await chrome.storage.sync.get(null);
  return { ...DEFAULT_SETTINGS, ...(store || {}) };
}
