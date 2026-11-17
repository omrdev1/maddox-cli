import { parseAlpha, parseColor, type Rgb } from "./color.js";
import { roleConflicts } from "./tokenRoles.js";
import type { RawUsage } from "./extract.js";
import type { Finding, GroundTruth } from "./types.js";

// A literal value found in source (not a var() reference), with its real kind.
type LiteralUsage = Omit<RawUsage, "kind" | "tokenRef"> & { kind: Exclude<RawUsage["kind"], "token"> };
const isLiteral = (usage: RawUsage): usage is RawUsage & LiteralUsage => usage.kind !== "token" && !usage.tokenRef;

const NEAR_MISS_RGB_THRESHOLD = 25;
const NEAR_MISS_NUMERIC_THRESHOLD = 0.05; // motion durations/delay/stagger, e.g. seconds
const NEAR_MISS_LENGTH_PX_THRESHOLD = 2; // font sizes and spacing
// Spring params run on a much larger, param-specific scale than a duration
// in seconds (stiffness commonly ~50-500, mass ~0.5-5, damping ~5-50) — a
// single shared absolute threshold would be meaningless across all three,
// so this is a relative tolerance (5% of the token's own value) instead.
const NEAR_MISS_SPRING_RELATIVE_THRESHOLD = 0.05;

function colorDistance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

// Opaque and translucent colours are different decisions: #ffffff is not
// rgba(255,255,255,0.06), however close the RGB channels are.
const ALPHA_TOLERANCE = 0.02;

function diffColor(usage: LiteralUsage, tokens: GroundTruth["tokens"]): Finding {
  const usageRgb = parseColor(usage.rawValue);
  if (!usageRgb) {
    return { ...usage, severity: "unrecognized" };
  }
  const usageAlpha = parseAlpha(usage.rawValue);

  // Nearest overall, and nearest whose name fits the colour's role (a
  // background shouldn't be pointed at a text token).
  let nearest: { name: string; distance: number } | undefined;
  let nearestFitting: { name: string; distance: number } | undefined;
  for (const [name, value] of Object.entries(tokens)) {
    const tokenRgb = parseColor(value);
    if (!tokenRgb || Math.abs(parseAlpha(value) - usageAlpha) > ALPHA_TOLERANCE) continue;
    const distance = colorDistance(usageRgb, tokenRgb);
    if (!nearest || distance < nearest.distance) nearest = { name, distance };
    if (!roleConflicts(usage.role, name) && (!nearestFitting || distance < nearestFitting.distance)) {
      nearestFitting = { name, distance };
    }
  }
  if (!nearest) return { ...usage, severity: "unrecognized" };

  const best = nearestFitting && nearestFitting.distance <= NEAR_MISS_RGB_THRESHOLD ? nearestFitting : nearest;
  if (best.distance === 0) return { ...usage, severity: "match", nearestToken: best.name };
  if (best.distance <= NEAR_MISS_RGB_THRESHOLD) return { ...usage, severity: "near-miss", nearestToken: best.name };
  return { ...usage, severity: "unrecognized", nearestToken: best.name };
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

function diffMotion(usage: LiteralUsage, motion: GroundTruth["motion"]): Finding {
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

// Tailwind's `--text-*` namespace, or any name that says "font size"
// (`--font-size-md`, Tokens Studio's `--fontSizes-base`).
const FONT_SIZE_NAME_RE = /^--text-|font-?sizes?/i;
// Non-typography length namespaces (e.g. shadcn's `--radius: 0.5rem`) must
// never be compared against `font-size` even in the fallback pool.
const NON_FONT_SIZE_NAME_RE =
  /(?:^|[-_])(radius|rounded|spacing|space|gap|padding|margin|border|width|height|blur|breakpoint|container)(?:[-_]|$)/i;

type TokenEntry = [name: string, value: string];

// A font size should only drift from font-size tokens, not from a radius or a
// spacing step that happens to share a length. When the theme names no
// font-size tokens at all, non-excluded length tokens (e.g. `--size-body`)
// are still compared.
function fontSizeCandidates(tokens: GroundTruth["tokens"]): TokenEntry[] {
  const lengths = Object.entries(tokens).filter(([, value]) => toPx(value) !== null);
  const named = lengths.filter(([name]) => FONT_SIZE_NAME_RE.test(name));
  if (named.length > 0) return named;
  return lengths.filter(([name]) => !NON_FONT_SIZE_NAME_RE.test(name));
}

// Named spacing steps only (`--spacing-4`, `--space-md`, `--gap-sm`). Tailwind
// v4's bare `--spacing` is a multiplier base, not a step, so it is left out.
const SPACING_NAME_RE = /^--(?:spacing|space|gap|padding|margin)[-_]./i;

function spacingCandidates(tokens: GroundTruth["tokens"]): TokenEntry[] {
  return Object.entries(tokens).filter(([name, value]) => SPACING_NAME_RE.test(name) && toPx(value) !== null);
}

function diffLength(usage: LiteralUsage, candidates: TokenEntry[]): Finding {
  const exactMatch = candidates.find(([, value]) => value === usage.rawValue);
  if (exactMatch) {
    return { ...usage, severity: "match", nearestToken: exactMatch[0] };
  }

  const usagePx = toPx(usage.rawValue);
  if (usagePx === null) {
    return { ...usage, severity: "unrecognized" };
  }

  let nearestToken: string | undefined;
  let nearestDistance = Infinity;

  for (const [name, value] of candidates) {
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
  if (nearestDistance <= NEAR_MISS_LENGTH_PX_THRESHOLD) {
    return { ...usage, severity: "near-miss", nearestToken };
  }
  return { ...usage, severity: "unrecognized", nearestToken };
}

// A usage can only drift from a token that exists: with no color tokens, every
// color would be "unrecognized", which is noise, not a finding.
function hasTokensFor(kind: LiteralUsage["kind"], groundTruth: GroundTruth): boolean {
  if (kind === "motion") return groundTruth.motion.length > 0;
  if (kind === "color") return Object.values(groundTruth.tokens).some((value) => parseColor(value) !== null);
  if (kind === "spacing") return spacingCandidates(groundTruth.tokens).length > 0;
  return fontSizeCandidates(groundTruth.tokens).length > 0;
}

// A `var(--name)` usage of a real token is a match, of the kind the token's
// value says. References to anything that isn't a design token are dropped.
function diffTokenRef(usage: RawUsage, groundTruth: GroundTruth): Finding | null {
  const name = usage.tokenRef as string;
  const value = groundTruth.tokens[name];
  if (value === undefined) return null;
  let kind: Finding["kind"] | null = null;
  if (parseColor(value) !== null) kind = "color";
  else if (fontSizeCandidates(groundTruth.tokens).some(([n]) => n === name)) kind = "font-size";
  else if (spacingCandidates(groundTruth.tokens).some(([n]) => n === name)) kind = "spacing";
  if (kind === null) return null;
  const { tokenRef: _ref, ...rest } = usage;
  void _ref;
  return { ...rest, kind, severity: "match", nearestToken: name };
}

export function diffUsages(usages: RawUsage[], groundTruth: GroundTruth): Finding[] {
  const comparableKinds = new Set(
    (["color", "font-size", "spacing", "motion"] as const).filter((kind) => hasTokensFor(kind, groundTruth))
  );
  const refs = usages.filter((usage) => usage.tokenRef).map((usage) => diffTokenRef(usage, groundTruth));
  const literals = usages.filter(isLiteral).filter((usage) => comparableKinds.has(usage.kind)).map((usage) => {
    if (usage.kind === "color") return diffColor(usage, groundTruth.tokens);
    if (usage.kind === "motion") return diffMotion(usage, groundTruth.motion);
    if (usage.kind === "font-size") return diffLength(usage, fontSizeCandidates(groundTruth.tokens));
    return diffLength(usage, spacingCandidates(groundTruth.tokens));
  });
  return [...literals, ...refs.filter((f): f is Finding => f !== null)];
}
