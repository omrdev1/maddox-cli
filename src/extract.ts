// Browser-safe extraction — no Node built-ins (fs/path), so this module
// (and anything that only imports from it) can be bundled into a "use
// client" component without breaking a webpack/browser build. Keep it
// that way: this file must never gain a `node:` import. Filesystem
// walking (scanSource/scanFiles) lives in scan.ts instead, which does
// import Node built-ins and is meant only for server-side/CLI use.

export interface RawUsage {
  file: string;
  line: number;
  kind: "color" | "spacing" | "font-size" | "motion";
  rawValue: string;
  // Only set for spring params (mass/stiffness/damping) — these share no
  // common numeric range (stiffness commonly ~50-500, mass ~0.5-5, damping
  // ~5-50), so pure numeric-proximity matching across all motion tokens
  // would produce a nonsensical "nearest" match. This tells diffMotion
  // which specific leaf pool to compare against, the same way isNumeric
  // already separates duration/delay/stagger from ease.
  leafHint?: "mass" | "stiffness" | "damping";
}

// A single scanned file's relative path + raw content — produced by
// scan.ts's filesystem walk, but the shape itself has no Node dependency
// so it lives here where anything (including a client component) can
// reference the type.
export interface ScannedFile {
  file: string; // relative to rootDir
  content: string;
}

const HEX_RE = /#([a-f0-9]{3}|[a-f0-9]{6})\b/gi;
const FONT_SIZE_RE = /font-size:\s*([\d.]+(?:px|rem|em))/gi;
const MOTION_DURATION_RE = /duration:\s*([\d.]+)(ms|s)?/gi;
const MOTION_EASE_RE = /ease:\s*['"]([\w-]+)['"]/gi;
const MOTION_DELAY_RE = /delay:\s*([\d.]+)(ms|s)?/gi;
const MOTION_STAGGER_RE = /stagger:\s*([\d.]+)(ms|s)?/gi;
const MOTION_SPRING_RE = /\b(mass|stiffness|damping):\s*([\d.]+)/gi;

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:'"\\])\/\/[^\n]*/gm;
const CUSTOM_PROPERTY_DECLARATION_RE = /--[\w-]+\s*:[^;{}\n]*;?/g;
// A zero or one-millisecond duration is the "disable motion" idiom (reduced
// motion rules, `duration: 0`), not a motion decision to compare to a token.
const NO_OP_MOTION_SECONDS = 0.001;

// Blanking with spaces keeps every index and line number valid.
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

// Comments and custom-property declarations are not usages: the first is
// prose, the second is where a token's own value is defined.
function maskNonUsage(content: string): string {
  return content
    .replace(BLOCK_COMMENT_RE, blank)
    .replace(LINE_COMMENT_RE, (match, lead: string) => lead + blank(match.slice(lead.length)))
    .replace(CUSTOM_PROPERTY_DECLARATION_RE, blank);
}

// Returns the value in seconds as a string, or null for a no-op or unreadable value.
function motionSeconds(raw: string, unit: string | undefined): string | null {
  const number = Number(raw);
  if (Number.isNaN(number)) return null;
  const inMilliseconds = unit?.toLowerCase() === "ms";
  const seconds = inMilliseconds ? number / 1000 : number;
  if (seconds <= NO_OP_MOTION_SECONDS) return null;
  return inMilliseconds ? String(seconds) : raw;
}

function collectMotionTimings(file: string, content: string, re: RegExp, usages: RawUsage[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const rawValue = motionSeconds(m[1], m[2]);
    if (rawValue === null) continue;
    usages.push({ file, line: lineNumberAt(content, m.index), kind: "motion", rawValue });
  }
}

/**
 * Extracts raw color/font-size/motion literals from a single blob of
 * content. Used both by scan.ts's filesystem walk and by crawl.ts's
 * fetched-HTML/CSS path — the same extraction either way, source doesn't
 * matter.
 */
export function extractFromContent(file: string, rawContent: string): RawUsage[] {
  const content = maskNonUsage(rawContent);
  const usages: RawUsage[] = [];

  for (const re of [HEX_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      usages.push({
        file,
        line: lineNumberAt(content, m.index),
        kind: "color",
        rawValue: m[0].toLowerCase(),
      });
    }
  }

  FONT_SIZE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FONT_SIZE_RE.exec(content)) !== null) {
    usages.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "font-size",
      rawValue: m[1],
    });
  }

  for (const re of [MOTION_DURATION_RE, MOTION_DELAY_RE, MOTION_STAGGER_RE]) {
    collectMotionTimings(file, content, re, usages);
  }

  MOTION_EASE_RE.lastIndex = 0;
  while ((m = MOTION_EASE_RE.exec(content)) !== null) {
    usages.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "motion",
      rawValue: m[1],
    });
  }

  MOTION_SPRING_RE.lastIndex = 0;
  while ((m = MOTION_SPRING_RE.exec(content)) !== null) {
    usages.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "motion",
      rawValue: m[2],
      leafHint: m[1].toLowerCase() as "mass" | "stiffness" | "damping",
    });
  }

  return usages;
}
