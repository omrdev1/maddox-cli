import { parseColor, type Rgb } from "./color.js";
import type { RawUsage } from "./extract.js";
import type { Finding, GroundTruth } from "./types.js";

const NEAR_MISS_RGB_THRESHOLD = 25;
const NEAR_MISS_NUMERIC_THRESHOLD = 0.05; // motion durations/delay/stagger, e.g. seconds
const NEAR_MISS_FONT_SIZE_PX_THRESHOLD = 2;
// Spring params run on a much larger, param-specific scale than a duration
// in seconds (stiffness commonly ~50-500, mass ~0.5-5, damping ~5-50) — a
// single shared absolute threshold would be meaningless across all three,
// so this is a relative tolerance (5% of the token's own value) instead.
const NEAR_MISS_SPRING_RELATIVE_THRESHOLD = 0.05;

function colorDistance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function diffColor(usage: RawUsage, tokens: GroundTruth["tokens"]): Finding {
  const usageRgb = parseColor(usage.rawValue);
  if (!usageRgb) {
    return { ...usage, severity: "unrecognized" };
  }

  let nearestToken: string | undefined;
  let nearestDistance = Infinity;

  for (const [name, value] of Object.entries(tokens)) {
    const tokenRgb = parseColor(value);
    if (!tokenRgb) continue;
    const distance = colorDistance(usageRgb, tokenRgb);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestToken = name;
    }
  }

  if (nearestDistance === 0) {
    return { ...usage, severity: "match", nearestToken };
  }
  if (nearestDistance <= NEAR_MISS_RGB_THRESHOLD) {
    return { ...usage, severity: "near-miss", nearestToken };
  }
  return { ...usage, severity: "unrecognized", nearestToken };
}

// Only these leaf names represent a duration in seconds — comparing a
// scanned `duration: 0.8` against unrelated numeric leaves like `opacity`,
// `stiffness`, or `damping` produces a nonsensical "nearest" match purely
// by numeric proximity, since those are different units entirely.
const DURATION_LEAF_NAMES = new Set(["duration", "delay", "stagger"]);
const EASE_LEAF_NAMES = new Set(["ease", "easing"]);
const SPRING_LEAF_NAMES = new Set(["mass", "stiffness", "damping"]);

function isDurationLeaf(path: string): boolean {
  return DURATION_LEAF_NAMES.has(path.split(".").pop() ?? "");
}
function isEaseLeaf(path: string): boolean {
  return EASE_LEAF_NAMES.has(path.split(".").pop() ?? "");
}
function isSpringLeaf(path: string, leafHint: string): boolean {
  return path.split(".").pop() === leafHint;
}

function diffMotion(usage: RawUsage, motion: GroundTruth["motion"]): Finding {
  const usageNum = Number(usage.rawValue);
  const isNumeric = !Number.isNaN(usageNum);

  // A spring param (mass/stiffness/damping) is tagged with leafHint by
  // extract.ts and needs its own matching path entirely — it must only
  // ever compare against the same-named leaf, never against durations or
  // each other, since the three params share no common scale.
  if (usage.leafHint && SPRING_LEAF_NAMES.has(usage.leafHint)) {
    const candidates = motion.filter((t) => isSpringLeaf(t.path, usage.leafHint!));
    let nearestToken: string | undefined;
    let nearestDistance = Infinity;
    let exact = false;

    for (const token of candidates) {
      if (typeof token.value !== "number") continue;
      const distance = Math.abs(usageNum - token.value);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestToken = token.path;
        exact = distance === 0;
      }
    }

    if (exact) return { ...usage, severity: "match", nearestToken };
    const nearestTokenValue = candidates.find((t) => t.path === nearestToken)?.value;
    const relativeThreshold =
      typeof nearestTokenValue === "number"
        ? Math.abs(nearestTokenValue) * NEAR_MISS_SPRING_RELATIVE_THRESHOLD
        : 0;
    if (nearestDistance <= relativeThreshold) {
      return { ...usage, severity: "near-miss", nearestToken };
    }
    return { ...usage, severity: "unrecognized", nearestToken };
  }

  const candidates = motion.filter((t) => (isNumeric ? isDurationLeaf(t.path) : isEaseLeaf(t.path)));

  let nearestToken: string | undefined;
  let nearestDistance = Infinity;
  let exact = false;

  for (const token of candidates) {
    if (isNumeric && typeof token.value === "number") {
      const distance = Math.abs(usageNum - token.value);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestToken = token.path;
        exact = distance === 0;
      }
    } else if (!isNumeric && String(token.value) === usage.rawValue) {
      nearestToken = token.path;
      nearestDistance = 0;
      exact = true;
      break;
    }
  }

  if (exact) return { ...usage, severity: "match", nearestToken };
  if (isNumeric && nearestDistance <= NEAR_MISS_NUMERIC_THRESHOLD) {
    return { ...usage, severity: "near-miss", nearestToken };
  }
  return { ...usage, severity: "unrecognized", nearestToken };
}

// Root font-size assumption for converting rem/em to px — the standard
// browser default. Good enough for near-miss comparison purposes; this
// isn't trying to resolve a page's actual computed root size.
const ROOT_PX = 16;

function toPx(value: string): number | null {
  const m = /^([\d.]+)(px|rem|em)$/.exec(value.trim());
  if (!m) return null;
  const num = Number(m[1]);
  if (m[2] === "px") return num;
  return num * ROOT_PX;
}

function diffFontSize(usage: RawUsage, tokens: GroundTruth["tokens"]): Finding {
  const exactMatch = Object.entries(tokens).find(([, value]) => value === usage.rawValue);
  if (exactMatch) {
    return { ...usage, severity: "match", nearestToken: exactMatch[0] };
  }

  const usagePx = toPx(usage.rawValue);
  if (usagePx === null) {
    return { ...usage, severity: "unrecognized" };
  }

  let nearestToken: string | undefined;
  let nearestDistance = Infinity;

  for (const [name, value] of Object.entries(tokens)) {
    const tokenPx = toPx(value);
    if (tokenPx === null) continue;
    const distance = Math.abs(usagePx - tokenPx);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestToken = name;
    }
  }

  // 0.875rem and 14px are the same size, so an exact pixel match is a match.
  if (nearestDistance === 0) {
    return { ...usage, severity: "match", nearestToken };
  }
  if (nearestDistance <= NEAR_MISS_FONT_SIZE_PX_THRESHOLD) {
    return { ...usage, severity: "near-miss", nearestToken };
  }
  return { ...usage, severity: "unrecognized", nearestToken };
}

// A usage can only drift from a token that exists: with no color tokens, every
// color would be "unrecognized", which is noise, not a finding.
function hasTokensFor(kind: RawUsage["kind"], groundTruth: GroundTruth): boolean {
  if (kind === "motion") return groundTruth.motion.length > 0;
  const values = Object.values(groundTruth.tokens);
  if (kind === "color") return values.some((value) => parseColor(value) !== null);
  return values.some((value) => toPx(value) !== null);
}

export function diffUsages(usages: RawUsage[], groundTruth: GroundTruth): Finding[] {
  const comparableKinds = new Set(
    (["color", "font-size", "spacing", "motion"] as const).filter((kind) => hasTokensFor(kind, groundTruth))
  );
  return usages.filter((usage) => comparableKinds.has(usage.kind)).map((usage) => {
    if (usage.kind === "color") return diffColor(usage, groundTruth.tokens);
    if (usage.kind === "motion") return diffMotion(usage, groundTruth.motion);
    if (usage.kind === "font-size") return diffFontSize(usage, groundTruth.tokens);
    // spacing: exact-string match against token values for now
    const match = Object.entries(groundTruth.tokens).find(
      ([, value]) => value === usage.rawValue
    );
    return {
      ...usage,
      severity: match ? "match" : "unrecognized",
      nearestToken: match?.[0],
    } satisfies Finding;
  });
}
