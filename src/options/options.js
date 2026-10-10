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
  "globalSelectorOverride"
];

const RANGES = [
  ["hoverDelay", (value) => `${value} ms`],
  ["cardWidth", (value) => `${value} px`],
  ["fontScale", (value) => `${Number(value).toFixed(2)}×`]
];

let settings = { ...DEFAULT_SETTINGS };

init();

async function init() {
  settings = await readSettings();
  fillSelects();
  render();
  bind();
  await refreshCacheStats();
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

  $("maxDefinitions").addEventListener("change", (event) => {
    const value = Math.min(8, Math.max(1, Number(event.target.value) || 4));
    event.target.value = String(value);
    save({ maxDefinitions: value });
  });

  for (const [id, format] of RANGES) {
    $(id).addEventListener("input", (event) => {
      $(`${id}Out`).textContent = format(event.target.value);
    });
    $(id).addEventListener("change", (event) => {
      const value = Number(event.target.value);
      save({ [id]: id === "fontScale" ? value : Math.round(value) });
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
