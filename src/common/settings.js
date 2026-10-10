/**
 * Shared settings defaults. Loaded by the service worker and by every UI
 * surface through `chrome.storage.sync` (falling back to these values).
 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  targetLang: "tr",
  sourceLang: "auto",
  provider: "auto", // auto | google | mymemory
  trigger: "meta", // meta | ctrl | shift | always
  hoverDelay: 120, // ms before the card opens
  theme: "dark", // dark | light | auto
  fontScale: 1,
  showPhonetic: true,
  showDefinitions: true,
  showExamples: true,
  showSynonyms: false,
  showGoogleAlternatives: true,
  useCambridge: true,
  cambridgeLangMode: "auto", // auto | en-tr | en
  maxDefinitions: 4,
  cardWidth: 380,
  sites: {}, // { "netflix.com": { disabled: false, selector: "", adapters: true } }
  customSelector: "",
  globalSelectorOverride: false
};

export const LANGUAGES = [
  { code: "tr", label: "Türkçe" },
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "ar", label: "العربية" },
  { code: "nl", label: "Nederlands" },
  { code: "pl", label: "Polski" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "zh-CN", label: "中文 (简体)" },
  { code: "hi", label: "हिन्दी" },
  { code: "az", label: "Azərbaycanca" }
];

export const SITE_ADAPTER_LABELS = {
  netflix: "Netflix",
  youtube: "YouTube",
  primevideo: "Prime Video",
  disneyplus: "Disney+",
  hbomax: "HBO Max",
  mubi: "MUBI",
  generic: "Generic subtitle container"
};
