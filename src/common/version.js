/**
 * Version comparison for the update check.
 *
 * Kept separate from the service worker because it is pure logic and the only
 * part of the update path that is worth testing on its own: getting it wrong
 * means either a permanent "update available" badge or a missed release.
 */

/**
 * Parse a tag or version into comparable numbers.
 * Accepts `1.2.3`, `v1.2.3`, `1.2`, `1.2.3.4` and a `-beta.1` suffix, which is
 * carried separately so a prerelease sorts below its final release.
 */
export function parseVersion(value) {
  const text = String(value || "").trim().replace(/^v/i, "");
  const [core, ...suffixParts] = text.split("-");
  const numbers = core.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  while (numbers.length < 3) numbers.push(0);
  return { numbers, prerelease: suffixParts.join("-") };
}

/**
 * Compare two versions. Returns 1 when `a` is newer, -1 when `b` is newer and
 * 0 when they are equivalent. A prerelease sorts below the same release number.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.numbers[index] || 0;
    const y = right.numbers[index] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }

  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && right.prerelease) {
    return left.prerelease === right.prerelease
      ? 0
      : left.prerelease > right.prerelease
        ? 1
        : -1;
  }
  return 0;
}

/** True when `candidate` is a strictly newer version than `current`. */
export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

/**
 * Pick the best release asset for a manual install. The release carries both a
 * source archive and the packed extension, and the names are not guaranteed to
 * keep their prefix, so match on shape rather than exact name.
 */
export function pickExtensionAsset(assets, fallbackPattern = /extension/i) {
  if (!Array.isArray(assets)) return null;
  const preferred = assets.find((asset) => fallbackPattern.test(asset.name || ""));
  if (preferred) return preferred;
  return (
    assets.find((asset) => /\.crx$/i.test(asset.name || "")) ||
    assets.find((asset) => /\.zip$/i.test(asset.name || "")) ||
    null
  );
}
