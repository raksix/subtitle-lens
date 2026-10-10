/**
 * DOM helpers shared by the hover controller and the overlay.
 *
 * The important piece here is `buildCharMap`. Subtitle layers on streaming
 * sites are `pointer-events: none`, so `caretRangeFromPoint` returns nothing
 * useful: it is defined in terms of hit testing, and hit testing skips
 * `pointer-events: none` subtrees. Range geometry is not affected by pointer
 * events, so the character map is built from `Range.getClientRects()` instead.
 */

/** A character that can appear inside a dictionary headword. */
export const WORD_CHAR = /[\p{L}\p{N}]/u;
const INNER_JOINER = /['’\-]/;

const MAX_CHARS_PER_ROOT = 400;

export function isVisible(element) {
  if (!element || element.nodeType !== 1) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (Number(style.opacity) === 0) return false;
  return true;
}

export function rectSignature(rect) {
  return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(
    rect.width
  )},${Math.round(rect.height)}`;
}

/**
 * Ordered text runs under a root. Inline elements are walked in document
 * order; block-level children start a new "line group" so that multi-line
 * subtitles stay separable.
 */
export function collectTextRuns(root) {
  const runs = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(node.parentElement || root);
      if (style.visibility === "hidden" || style.display === "none") {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node;
  while ((node = walker.nextNode())) {
    runs.push(node);
    if (runs.length > 40) break;
  }
  return runs;
}

/**
 * Map every visible character in `root` to the rect it occupies.
 *
 * Cost is one `getBoundingClientRect` per character, so the result is cached
 * by the caller and only rebuilt when the text or the geometry changes.
 */
export function buildCharMap(root) {
  const runs = collectTextRuns(root);
  const chars = [];
  let text = "";
  let truncated = false;

  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const node = runs[runIndex];
    const data = node.data;
    const range = document.createRange();

    for (let index = 0; index < data.length; index += 1) {
      if (chars.length >= MAX_CHARS_PER_ROOT) {
        truncated = true;
        break;
      }
      const character = data[index];
      if (character === "\n") {
        chars.push({ ch: " ", rect: null, runIndex, index, lineBreak: true });
        text += " ";
        continue;
      }
      if (!character.trim()) {
        const box = rectForRange(range, node, index, index + 1);
        chars.push({ ch: " ", rect: box, runIndex, index });
        text += " ";
        continue;
      }
      const box = rectForRange(range, node, index, index + 1);
      chars.push({ ch: character, rect: box, runIndex, index });
      text += character;
    }

    if (truncated) break;
    // Preserve a single separating space between runs (e.g. Netflix word spans).
    if (runIndex < runs.length - 1) {
      chars.push({ ch: " ", rect: null, runIndex, index: data.length, virtual: true });
      text += " ";
    }
  }

  return { root, chars, text, truncated, at: Date.now(), signature: "" };
}

function rectForRange(range, node, start, end) {
  try {
    range.setStart(node, start);
    range.setEnd(node, end);
    const rects = range.getClientRects();
    if (rects.length) return rects[0];
    return range.getBoundingClientRect();
  } catch {
    return null;
  }
}

/** Index of the nearest character whose rect contains the point. */
export function charIndexAtPoint(map, x, y) {
  const { chars } = map;
  let bestIndex = -1;
  let bestDistance = Infinity;

  for (let index = 0; index < chars.length; index += 1) {
    const rect = chars[index].rect;
    if (!rect || (rect.width === 0 && rect.height === 0)) continue;

    const insideY = y >= rect.top - 2 && y <= rect.bottom + 2;
    const insideX = x >= rect.left - 1 && x <= rect.right + 1;
    if (insideY && insideX) return index;

    if (insideY) {
      const distance = x < rect.left ? rect.left - x : x - rect.right;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
  }

  // Allow a small vertical overshoot so the very edge of a glyph still hits.
  if (bestIndex === -1) {
    for (let index = 0; index < chars.length; index += 1) {
      const rect = chars[index].rect;
      if (!rect) continue;
      if (x >= rect.left - 1 && x <= rect.right + 1) {
        const distance = y < rect.top ? rect.top - y : y - rect.bottom;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
    }
  }

  return bestDistance <= 24 ? bestIndex : -1;
}

/** Grow a character index to the surrounding token and validate it. */
export function expandToWord(text, index) {
  if (index < 0 || index >= text.length) return null;
  if (!WORD_CHAR.test(text[index])) {
    // Allow hovering the apostrophe of "don't".
    if (!INNER_JOINER.test(text[index])) return null;
  }

  let start = index;
  let end = index;

  while (start > 0 && isWordInterior(text, start - 1, start)) start -= 1;
  while (end + 1 < text.length && isWordInterior(text, end + 1, end)) end += 1;

  let word = text.slice(start, end + 1);
  // Trim joiners that ended up on a boundary: "'hello'", "well-".
  while (word && INNER_JOINER.test(word[0])) {
    word = word.slice(1);
    start += 1;
  }
  while (word && INNER_JOINER.test(word[word.length - 1])) {
    word = word.slice(0, -1);
    end -= 1;
  }
  if (!word || !WORD_CHAR.test(word[0])) return null;

  return { word, start, end };
}

function isWordInterior(text, candidate, neighbour) {
  const character = text[candidate];
  if (WORD_CHAR.test(character)) return true;
  if (!INNER_JOINER.test(character)) return false;
  // A joiner only counts when letters sit on both sides of it.
  const before = text[candidate - 1];
  const after = text[candidate + 1];
  void neighbour;
  return Boolean(before && after && WORD_CHAR.test(before) && WORD_CHAR.test(after));
}

/** Viewport rects covering `text[start..end]` in the given map. */
export function rectsForRange(map, start, end) {
  const rects = [];
  for (let index = start; index <= end; index += 1) {
    const item = map.chars[index];
    if (!item || !item.rect || !item.ch) continue;
    if (!item.ch.trim()) continue;
    rects.push({ rect: item.rect, ch: item.ch });
  }
  return mergeLineRects(rects);
}

/** Merge adjacent characters into per-line boxes so the highlight looks solid. */
function mergeLineRects(entries) {
  const lines = [];
  for (const entry of entries) {
    const { rect } = entry;
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate.top - rect.top) < Math.max(2, rect.height * 0.5) &&
        rect.left <= candidate.right + Math.max(2, rect.width * 0.6)
    );
    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      });
    }
  }
  return lines.map((line) => ({
    left: line.left,
    top: line.top,
    width: line.right - line.left,
    height: line.bottom - line.top
  }));
}

export function normalizeRect(rect) {
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };
}
