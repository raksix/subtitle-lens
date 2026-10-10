/**
 * Content script entry point.
 *
 * Runs in every frame but only takes effect where subtitle-like containers
 * exist, so ordinary pages pay a single cheap scan.
 */

import { DEFAULT_SETTINGS } from "../common/settings.js";
import { HoverController } from "./hover.js";

const STORAGE_KEY = "lens:settings";
const CONTROLLER_FLAG = "__subtitleLensController";

(async function bootstrap() {
  if (window[CONTROLLER_FLAG]) return;

  // Only the top frame or a frame that actually carries captions should work.
  const settings = await loadSettings();
  if (settings.enabled === false) {
    // Still listen for a later enable from the popup.
    const controller = new HoverController(settings);
    window[CONTROLLER_FLAG] = controller;
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "lens:settings" || message?.type === "lens:toggle") {
        controller.applySettings(
          message.settings ||
            { ...controller.settings, enabled: message.enabled }
        );
        if (controller.enabled && !controller.started) {
          controller.start();
          controller.started = true;
        }
      }
    });
    return;
  }

  const controller = new HoverController(settings);
  window[CONTROLLER_FLAG] = controller;
  controller.started = true;
  controller.start();
})();

async function loadSettings() {
  try {
    const sync = await chrome.storage.sync.get(null);
    const local = await chrome.storage.local.get(STORAGE_KEY);
    return {
      ...DEFAULT_SETTINGS,
      ...(local?.[STORAGE_KEY] || {}),
      ...(sync || {})
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
