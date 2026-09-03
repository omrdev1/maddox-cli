import type { RawUsage } from "./extract.js";
import type { Finding, GroundTruth } from "./types.js";

const NEAR_MISS_RGB_THRESHOLD = 25;
const NEAR_MISS_NUMERIC_THRESHOLD = 0.05; // motion durations, e.g. seconds
const NEAR_MISS_FONT_SIZE_PX_THRESHOLD = 2;

function hexToRgb(hex: string): [number, number, number] | null {
  // Only ever treat an actual "#..." literal as a color — a bare 3/6-digit
  // string without the leading # (e.g. a z-index value like "999") is not
  // a color and must not be matched against the color token pool.
  if (!hex.startsWith("#")) return null;

  const normalized = hex.replace(
    /^#([a-f\d])([a-f\d])([a-f\d])$/i,
    (_m, r, g, b) => `#${r}${r}${g}${g}${b}${b}`
  );
  const result = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized);
  if (!result) return null;
  return [
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16),
  ];
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function diffColor(usage: RawUsage, tokens: GroundTruth["tokens"]): Finding {
  const usageRgb = hexToRgb(usage.rawValue);
  if (!usageRgb) {
    return { ...usage, severity: "unrecognized" };
  }

  let nearestToken: string | undefined;
  let nearestDistance = Infinity;

  for (const [name, value] of Object.entries(tokens)) {
    const tokenRgb = hexToRgb(value);
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
const DURATION_LEAF_NAMES = new Set(["duration", "delay"]);
const EASE_LEAF_NAMES = new Set(["ease", "easing"]);

function isDurationLeaf(path: string): boolean {
  return DURATION_LEAF_NAMES.has(path.split(".").pop() ?? "");
}
function isEaseLeaf(path: string): boolean {
  return EASE_LEAF_NAMES.has(path.split(".").pop() ?? "");
}

function diffMotion(usage: RawUsage, motion: GroundTruth["motion"]): Finding {
  const usageNum = Number(usage.rawValue);
  const isNumeric = !Number.isNaN(usageNum);
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

  if (nearestDistance <= NEAR_MISS_FONT_SIZE_PX_THRESHOLD) {
    return { ...usage, severity: "near-miss", nearestToken };
  }
  return { ...usage, severity: "unrecognized", nearestToken };
}

export function diffUsages(usages: RawUsage[], groundTruth: GroundTruth): Finding[] {
  return usages.map((usage) => {
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
