import { parseAlpha } from "./color.js";
import type { FixStyle, ColorRole } from "./types.js";

// Browser-safe extraction — no Node built-ins (fs/path), so this module
// (and anything that only imports from it) can be bundled into a "use
// client" component without breaking a webpack/browser build. Keep it
// that way: this file must never gain a `node:` import. Filesystem
// walking (scanSource/scanFiles) lives in scan.ts instead, which does
// import Node built-ins and is meant only for server-side/CLI use.

export interface RawUsage {
  file: string;
  line: number;
  kind: "color" | "spacing" | "font-size" | "motion" | "token"; // "token": a var() reference, kind decided at diff time
  rawValue: string;
  // Set when the usage is a reference to a design token by name
  // (`var(--color-paper)`): scored as a match of that token's kind if the
  // name is a real token, ignored otherwise. Its `kind` is "token" until
  // diffUsages sets the real one from the token's value.
  tokenRef?: string;
  // 1-based column and exact source text of the value (rawValue may be
  // normalized: lowercased hex, px for a bare JS number, seconds for ms).
  column?: number;
  literal?: string;
  fixStyle?: FixStyle;
  role?: ColorRole;
  inGradient?: boolean;
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

// Not after `&` (HTML entities like `&#8217;`) or a letter/digit. `_` is
// allowed: Tailwind writes spaces as `_` (`shadow-[0_0_1px_#123]`).
const HEX_RE = /(?<![&A-Za-z0-9])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;
// Numeric arguments only: `hsl(var(--primary))` and Tailwind's compiled
// `rgb(0 0 0 / var(--tw-bg-opacity))` are token references, not literals.
const COLOR_FUNCTION_RE = /(?<![\w-])(?:rgba?|hsla?|oklch)\(\s*[-+.\d][^()]*\)/gi;
const FONT_SIZE_RE = /font-size:\s*([\d.]+(?:px|rem|em))/gi;
const NUMBER = "\\d*\\.?\\d+";
const LENGTH = `${NUMBER}(?:px|rem|em)`;
const JSX_FONT_SIZE_RE = new RegExp(
  `(?<![\\w-])fontSize\\s*:\\s*(?:(['"\`])(${LENGTH})\\1|(${NUMBER})(?=\\s*[,}\\n]))`,
  "g"
);
const TAILWIND_FONT_SIZE_RE = new RegExp(`(?<![\\w-])text-\\[(${LENGTH})\\]`, "g");
// padding/margin/gap and their sides, in CSS (`margin-top`) or JS (`marginTop`) case.
const SPACING_PROPERTY_RE =
  /(?<![\w-])(?:padding|margin|row-?gap|column-?gap|gap)(?:-?(?:top|right|bottom|left|inline|block|horizontal|vertical)(?:-?(?:start|end))?)?\s*:\s*([^;,{}\n]+)/gi;
// A length inside a property value; not after `-` (negatives can't take a token), `.`, `#` or a word.
const VALUE_LENGTH_RE = new RegExp(`(?<![\\w.#-])(${LENGTH})\\b`, "g");
const TAILWIND_SPACING_RE = new RegExp(
  `(?<![\\w-])(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-\\[(${LENGTH})\\]`,
  "g"
);
const BARE_NUMBER_RE = new RegExp(`^${NUMBER}$`);
// `[stroke='#fff']` is an attribute selector matching what a library renders
// (shadcn's chart.tsx targets Recharts this way). Rewriting it to a token
// would stop the selector matching, so it is not a usage.
const BEFORE_ATTRIBUTE_VALUE_RE = /=\s*['"]?$/;
const AFTER_ATTRIBUTE_VALUE_RE = /^['"]?\s*\]/;

function isAttributeSelectorValue(content: string, index: number, length: number): boolean {
  return (
    BEFORE_ATTRIBUTE_VALUE_RE.test(content.slice(Math.max(0, index - 4), index)) &&
    AFTER_ATTRIBUTE_VALUE_RE.test(content.slice(index + length, index + length + 4))
  );
}
// A bare number is a px length only in JS/TS (React style objects), never in CSS.
const JS_FILE_RE = /\.[cm]?[jt]sx?$/i;
const MOTION_DURATION_RE = /duration:\s*([\d.]+)(ms|s)?/gi;
const MOTION_EASE_RE = /ease:\s*['"]([\w-]+)['"]/gi;
const MOTION_DELAY_RE = /delay:\s*([\d.]+)(ms|s)?/gi;
const MOTION_STAGGER_RE = /stagger:\s*([\d.]+)(ms|s)?/gi;
const MOTION_SPRING_RE = /\b(mass|stiffness|damping):\s*([\d.]+)/gi;

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

// A usage at an exact position. A literal that fills a whole `[...]` is a
// Tailwind arbitrary value and needs a type-hinted fix (see FixStyle).
function usageAt(
  file: string,
  content: string,
  index: number,
  kind: RawUsage["kind"],
  literal: string,
  rawValue: string,
  fixStyle?: FixStyle
): RawUsage {
  const wholeBracket = content[index - 1] === "[" && content[index + literal.length] === "]";
  const style = fixStyle ?? (wholeBracket ? "tailwind" : undefined);
  return {
    file,
    line: lineNumberAt(content, index),
    column: index - (content.lastIndexOf("\n", index - 1) + 1) + 1,
    literal,
    kind,
    rawValue,
    ...(style ? { fixStyle: style } : {}),
  };
}

function isZero(value: string): boolean {
  return parseFloat(value) === 0;
}

// The last property name before a colour on its line says what it's for:
// `background: linear-gradient(#111, ...)`, `bg-[#111]`, `color: #111`,
// `text-[#111]`, `borderColor: "#111"`. Shadows and others give no role.
const ROLE_KEYWORD_RE = /(background(?:-color|Color)?|\bbg-|\bfill\b|border(?:-(?:top|right|bottom|left))?(?:-color|Color)?|\bstroke\b|outline(?:-color|Color)?|\bcolor\b|\btext-)/gi;

/** True when the position sits inside an unclosed `*-gradient(` on its line. */
export function insideGradient(content: string, index: number): boolean {
  const prefix = content.slice(content.lastIndexOf("\n", index - 1) + 1, index);
  const start = prefix.search(/(?:linear|radial|conic)-gradient\((?![^]*(?:linear|radial|conic)-gradient\()/);
  if (start === -1) return false;
  let depth = 0;
  for (const ch of prefix.slice(start)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth > 0;
}

export function colorRoleAt(content: string, index: number): ColorRole | undefined {
  const prefix = content.slice(content.lastIndexOf("\n", index - 1) + 1, index);
  let last: string | undefined;
  for (const m of prefix.matchAll(ROLE_KEYWORD_RE)) last = m[1].toLowerCase();
  if (!last) return undefined;
  if (last.startsWith("background") || last === "bg-" || last === "fill") return "bg";
  if (last.startsWith("border") || last === "stroke" || last.startsWith("outline")) return "border";
  return "text";
}

function collectColors(file: string, content: string, usages: RawUsage[]): void {
  for (const re of [HEX_RE, COLOR_FUNCTION_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (parseAlpha(m[0]) === 0) continue; // fully transparent: the `transparent` idiom
      if (isAttributeSelectorValue(content, m.index, m[0].length)) continue;
      const rawValue = m[0].startsWith("#") ? m[0].toLowerCase() : m[0];
      const role = colorRoleAt(content, m.index);
      usages.push({
        ...usageAt(file, content, m.index, "color", m[0], rawValue),
        ...(role ? { role } : {}),
        ...(insideGradient(content, m.index) ? { inGradient: true } : {}),
      });
    }
  }
}

function collectFontSizes(file: string, content: string, usages: RawUsage[]): void {
  let m: RegExpExecArray | null;
  for (const re of [FONT_SIZE_RE, TAILWIND_FONT_SIZE_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const index = m.index + m[0].lastIndexOf(m[1]);
      usages.push(usageAt(file, content, index, "font-size", m[1], m[1]));
    }
  }
  JSX_FONT_SIZE_RE.lastIndex = 0;
  while ((m = JSX_FONT_SIZE_RE.exec(content)) !== null) {
    if (m[2]) {
      usages.push(usageAt(file, content, m.index + m[0].lastIndexOf(m[2]), "font-size", m[2], m[2]));
    } else if (JS_FILE_RE.test(file) && !isZero(m[3])) {
      const index = m.index + m[0].lastIndexOf(m[3]);
      usages.push(usageAt(file, content, index, "font-size", m[3], `${m[3]}px`, "js-number"));
    }
  }
}

function collectSpacing(file: string, content: string, usages: RawUsage[]): void {
  let m: RegExpExecArray | null;
  SPACING_PROPERTY_RE.lastIndex = 0;
  while ((m = SPACING_PROPERTY_RE.exec(content)) !== null) {
    const value = m[1];
    const valueStart = m.index + m[0].length - value.length;
    const trimmed = value.trim();
    if (BARE_NUMBER_RE.test(trimmed)) {
      if (JS_FILE_RE.test(file) && !isZero(trimmed)) {
        const index = valueStart + value.indexOf(trimmed);
        usages.push(usageAt(file, content, index, "spacing", trimmed, `${trimmed}px`, "js-number"));
      }
      continue;
    }
    VALUE_LENGTH_RE.lastIndex = 0;
    let length: RegExpExecArray | null;
    while ((length = VALUE_LENGTH_RE.exec(value)) !== null) {
      if (isZero(length[1])) continue;
      usages.push(usageAt(file, content, valueStart + length.index, "spacing", length[1], length[1]));
    }
  }
  TAILWIND_SPACING_RE.lastIndex = 0;
  while ((m = TAILWIND_SPACING_RE.exec(content)) !== null) {
    if (isZero(m[1])) continue;
    const index = m.index + m[0].lastIndexOf(m[1]);
    usages.push(usageAt(file, content, index, "spacing", m[1], m[1]));
  }
}

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:'"\\])\/\/[^\n]*/gm;
const CUSTOM_PROPERTY_DECLARATION_RE = /--[\w-]+\s*:[^;{}\n]*;?/g;
// A zero or one-millisecond duration is the "disable motion" idiom (reduced
// motion rules, `duration: 0`), not a motion decision to compare to a token.
const NO_OP_MOTION_SECONDS = 0.001;

const IGNORE_DIRECTIVE_RE = /maddox-ignore(-next-line|-start|-end)?\b/;

/**
 * Line numbers an author has opted out of with a comment directive:
 * `maddox-ignore` (this line), `maddox-ignore-next-line`, or a
 * `maddox-ignore-start` / `maddox-ignore-end` region (open to end of file if
 * never closed). For intentional values such as a chart palette or theme preset.
 */
export function findIgnoredLines(content: string): Set<number> {
  const ignored = new Set<number>();
  let inRegion = false;
  content.split("\n").forEach((text, index) => {
    const line = index + 1;
    const kind = IGNORE_DIRECTIVE_RE.exec(text)?.[1];
    if (inRegion) ignored.add(line);
    if (kind === "-start") {
      inRegion = true;
      ignored.add(line);
    } else if (kind === "-end") {
      inRegion = false;
    } else if (kind === "-next-line") {
      ignored.add(line + 1);
    } else if (IGNORE_DIRECTIVE_RE.test(text)) {
      ignored.add(line);
    }
  });
  return ignored;
}

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
 * Extracts raw color/font-size/spacing/motion literals from a single blob of
 * content. Used both by scan.ts's filesystem walk and by crawl.ts's
 * fetched-HTML/CSS path — the same extraction either way, source doesn't
 * matter.
 */
const TOKEN_REF_RE = /var\(\s*(--[\w-]+)/g;
// A custom property definition (`--surface: var(--paper)`) defines a token;
// it isn't a usage of one.
const CUSTOM_PROPERTY_DEFINITION_RE = /--[\w-]+\s*:\s*[^;{}]*$/;

function collectTokenRefs(file: string, content: string, usages: RawUsage[]): void {
  TOKEN_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_REF_RE.exec(content)) !== null) {
    const lineStart = content.lastIndexOf("\n", m.index - 1) + 1;
    if (CUSTOM_PROPERTY_DEFINITION_RE.test(content.slice(lineStart, m.index))) continue;
    usages.push({
      file,
      line: lineNumberAt(content, m.index),
      column: m.index - lineStart + 1,
      kind: "token",
      rawValue: `var(${m[1]})`,
      tokenRef: m[1],
    });
  }
}

export function extractFromContent(file: string, rawContent: string): RawUsage[] {
  const content = maskNonUsage(rawContent);
  const usages: RawUsage[] = [];

  collectColors(file, content, usages);
  collectFontSizes(file, content, usages);
  collectSpacing(file, content, usages);
  collectTokenRefs(file, content, usages);

  let m: RegExpExecArray | null;
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

  const ignoredLines = findIgnoredLines(rawContent);
  return usages.filter((usage) => !ignoredLines.has(usage.line));
}
