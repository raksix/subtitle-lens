import { DEFAULT_SETTINGS, LANGUAGES } from "../common/settings.js";

const SITE_LABELS = {
  netflix: "Netflix",
  youtube: "YouTube",
  primevideo: "Prime Video",
  disneyplus: "Disney+",
  hbomax: "HBO Max",
  mubi: "MUBI",
  appletv: "Apple TV+",
  generic: "Bilinmeyen site"
};

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let hostname = "";
let siteId = "generic";

init();

async function init() {
  settings = await readSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    hostname = tab?.url ? new URL(tab.url).hostname : "";
  } catch {
    hostname = "";
  }
  siteId = detectSite(hostname);

  fillLanguages();
  bind();
  render();
  await refreshLibraryCount();
  await refreshUpdateBadge();
}

/** Rough count so the shortcut reads as a live thing, not a dead link. */
async function refreshLibraryCount() {
  const response = await chrome.runtime.sendMessage({ type: "lens:listWords" }).catch(() => null);
  if (!response?.ok) return;
  const { total, due } = response.data;
  $("libraryCount").textContent = due
    ? `${total} kelime · ${due} tekrar`
    : `${total} kelime`;
}

async function refreshUpdateBadge() {
  const state = await chrome.runtime.sendMessage({ type: "lens:updateState" }).catch(() => null);
  if (!state?.ok || !state.data.available) return;
  const badge = $("updateBadge");
  badge.hidden = false;
  badge.textContent = `⬆ ${state.data.latest}`;
  badge.title = `SubtitleLens ${state.data.latest} hazır — tıkla ve indir`;
}

function fillLanguages() {
  const target = $("targetLang");
  target.replaceChildren(
    ...LANGUAGES.map(
      (language) =>
        new Option(language.label, language.code, false, language.code === settings.targetLang)
    )
  );
  const values = [["auto", "Otomatik algıla"], ...LANGUAGES.map((l) => [l.code, l.label])];
  $("sourceLang").replaceChildren(
    ...values.map(
      ([value, label]) =>
        new Option(label, value, false, value === (settings.sourceLang || "auto"))
    )
  );
}

function siteConfig() {
  return { ...(settings.sites?.[hostname] || {}) };
}

function render() {
  $("enabled").checked = settings.enabled !== false;
  $("site-line").textContent = hostname
    ? `${SITE_LABELS[siteId]} · ${hostname}`
    : "Bu sayfada çalışmaz";
  $("hoverDelay").value = String(settings.hoverDelay ?? 120);
  $("hoverDelayOut").textContent = `${settings.hoverDelay ?? 120} ms`;
  $("gracePeriod").value = String(settings.gracePeriod ?? 420);
  $("gracePeriodOut").textContent = `${settings.gracePeriod ?? 420} ms`;
  $("saveOnClick").checked = settings.saveOnClick !== false;
  $("recordHistory").checked = settings.recordHistory !== false;
  $("multiSelectOnShift").checked = settings.multiSelectOnShift !== false;
  $("translateWholeLine").checked = settings.translateWholeLine !== false;
  $("showPhonetic").checked = settings.showPhonetic !== false;
  $("showDefinitions").checked = settings.showDefinitions !== false;
  $("showExamples").checked = settings.showExamples !== false;
  $("useCambridge").checked = settings.useCambridge !== false;

  const config = siteConfig();
  $("siteSelector").value = config.selector || "";
  $("siteDisabled").checked = config.disabled === true;
  $("site-hint").textContent = hostname
    ? `Boş bırakırsan ${SITE_LABELS[siteId]} için yerleşik seçici kullanılır.`
    : "Bu sekmede bir web sayfası yok.";
  $("siteSelector").disabled = !hostname;
  $("siteDisabled").disabled = !hostname;
}

function bind() {
  $("enabled").addEventListener("change", (event) => {
    save({ enabled: event.target.checked });
  });

  $("targetLang").addEventListener("change", (event) => {
    save({ targetLang: event.target.value });
  });

  $("sourceLang").addEventListener("change", (event) => {
    save({ sourceLang: event.target.value });
  });

  $("hoverDelay").addEventListener("input", (event) => {
    $("hoverDelayOut").textContent = `${event.target.value} ms`;
  });
  $("hoverDelay").addEventListener("change", (event) => {
    save({ hoverDelay: Number(event.target.value) });
  });

  for (const [id, key] of [
    ["showPhonetic", "showPhonetic"],
    ["showDefinitions", "showDefinitions"],
    ["showExamples", "showExamples"],
    ["useCambridge", "useCambridge"]
  ]) {
    $(id).addEventListener("change", (event) => save({ [key]: event.target.checked }));
  }

  $("siteSelector").addEventListener("change", (event) => {
    if (!hostname) return;
    const sites = { ...(settings.sites || {}) };
    const config = { ...(sites[hostname] || {}), selector: event.target.value.trim() };
    if (!config.selector) delete config.selector;
    if (!Object.keys(config).length) delete sites[hostname];
    else sites[hostname] = config;
    save({ sites });
  });

  $("siteDisabled").addEventListener("change", (event) => {
    if (!hostname) return;
    const sites = { ...(settings.sites || {}) };
    const config = { ...(sites[hostname] || {}), disabled: event.target.checked };
    if (!config.disabled) delete config.disabled;
    if (!Object.keys(config).length) delete sites[hostname];
    else sites[hostname] = config;
    save({ sites });
  });

  $("gracePeriod").addEventListener("input", (event) => {
    $("gracePeriodOut").textContent = `${event.target.value} ms`;
  });
  $("gracePeriod").addEventListener("change", (event) => {
    save({ gracePeriod: Number(event.target.value) });
  });

  for (const id of ["saveOnClick", "recordHistory", "multiSelectOnShift", "translateWholeLine"]) {
    $(id).addEventListener("change", (event) => save({ [id]: event.target.checked }));
  }

  $("openLibrary").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/library/library.html") });
    window.close();
  });

  $("updateBadge").addEventListener("click", async () => {
    const state = await chrome.runtime.sendMessage({ type: "lens:updateState" }).catch(() => null);
    const url = state?.data?.releaseUrl || "https://github.com/raksix/subtitle-lens/releases";
    chrome.tabs.create({ url });
  });

  $("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  $("testWord").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "lens:test",
        payload: {
          word: "run",
          anchor: { left: 120, top: 120, width: 40, height: 18, right: 160, bottom: 138 }
        }
      });
      window.close();
    } catch {
      $("testWord").textContent = "Sayfa hazır değil";
    }
  });
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set(patch);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "lens:settings", settings });
    } catch {
      /* the tab may not have the content script (chrome:// pages, PDFs) */
    }
  }
}

async function readSettings() {
  const store = await chrome.storage.sync.get(null);
  return { ...DEFAULT_SETTINGS, ...(store || {}) };
}

function detectSite(host) {
  if (!host) return "generic";
  if (/^(www\.)?netflix\.com$/i.test(host)) return "netflix";
  if (/^(www\.|m\.|music\.)?youtube(-nocookie)?\.com$/i.test(host)) return "youtube";
  if (/primevideo\.com$/i.test(host) || /^amazon\./i.test(host)) return "primevideo";
  if (/disneyplus\.com$/i.test(host)) return "disneyplus";
  if (/(hbomax|max)\.com$/i.test(host)) return "hbomax";
  if (/mubi\.com$/i.test(host)) return "mubi";
  if (/tv\.apple\.com$/i.test(host)) return "appletv";
  return "generic";
}
