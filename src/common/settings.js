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
  gracePeriod: 420, // ms the card survives after the pointer leaves a word
  theme: "dark", // dark | light | auto
  fontScale: 1,
  cardWidth: 380,
  /** 1 = opaque. Lower values let the video show through the card. */
  cardOpacity: 0.94,
  cardBlur: 16, // backdrop blur in px
  showPhonetic: true,
  showDefinitions: true,
  showExamples: true,
  showSynonyms: false,
  showGoogleAlternatives: true,
  useCambridge: true,
  cambridgeLangMode: "auto", // auto | en-tr | en
  maxDefinitions: 4,
  /** Clicking a word adds it to the saved list. */
  saveOnClick: true,
  /** Shift+click collects words; Ctrl+click translates the whole subtitle. */
  multiSelectOnShift: true,
  translateWholeLine: true,
  recordHistory: true,
  historyLimit: 400,
  historyMinLength: 2,
  historyIgnoreCommon: true,
  autoUpdateCheck: true,
  sites: {}, // { "netflix.com": { disabled: false, selector: "", adapters: true } }
  customSelector: "",
  globalSelectorOverride: false
};

/**
 * Recorded history skips words that carry no meaning to review. Without this a
 * single film fills the list with "the", "a" and "of".
 */
export const COMMON_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "at", "by", "for", "with",
  "about", "to", "from", "in", "on", "into", "over", "under", "is", "am", "are",
  "was", "were", "be", "been", "being", "do", "does", "did", "have", "has", "had",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "this", "that", "these", "those",
  "not", "no", "yes", "so", "as", "than", "then", "there", "here", "when", "where",
  "what", "which", "who", "whom", "how", "why", "will", "would", "can", "could",
  "should", "may", "might", "must", "s", "t", "re", "ve", "ll", "d", "m"
]);

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
