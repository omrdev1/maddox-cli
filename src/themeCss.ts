// Pure CSS parsing for ground-truth tokens: no Node built-ins, so it stays
// browser-safe like extract.ts. groundTruth.ts wraps it with the file read.

import { parseColor } from "./color.js";
import type { TokenMap } from "./types.js";

const ROOT_SELECTORS = new Set([":root", "html", ":host"]);
const WRAPPER_AT_RULES = ["@layer", "@supports"];
const MAX_REFERENCE_DEPTH = 10;
const LENGTH_RE = /^-?[\d.]+(px|rem|em)$/;
const VAR_RE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?))?\s*\)/;
const DECLARATION_RE = /(--[\w-]+)\s*:\s*([^;]+);/g;

interface CssBlock {
  prelude: string;
  body: string;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function findClosingBrace(css: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return i;
  }
  return css.length;
}

// A rule's selector is the text after the last `;`, since statements such as
// `@import "tailwindcss";` sit directly in front of the next rule.
function lastStatement(text: string): string {
  return (text.split(";").pop() as string).trim();
}

// Top-level rules, descending into @layer/@supports wrappers (shadcn keeps its
// :root block inside @layer base). Other nested rules, e.g. @media, stay opaque.
function collectBlocks(css: string, out: CssBlock[] = []): CssBlock[] {
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open === -1) break;
    const close = findClosingBrace(css, open);
    const prelude = lastStatement(css.slice(cursor, open));
    const body = css.slice(open + 1, close);
    if (WRAPPER_AT_RULES.some((rule) => prelude.startsWith(rule))) collectBlocks(body, out);
    else out.push({ prelude, body });
    cursor = close + 1;
  }
  return out;
}

function readDeclarations(body: string): TokenMap {
  const declarations: TokenMap = {};
  for (const match of `${body};`.matchAll(DECLARATION_RE)) {
    declarations[match[1]] = match[2].trim();
  }
  return declarations;
}

function isRootRule(prelude: string): boolean {
  return prelude.split(",").some((selector) => ROOT_SELECTORS.has(selector.trim()));
}

function resolveReferences(value: string, lookup: TokenMap, visiting: ReadonlySet<string>): string | null {
  let result = value;
  for (let step = 0; step < MAX_REFERENCE_DEPTH && VAR_RE.test(result); step++) {
    const match = VAR_RE.exec(result) as RegExpExecArray;
    const replacement = resolveVariable(match[1], match[2], lookup, visiting);
    if (replacement === null) return null;
    result = result.replace(match[0], replacement);
  }
  return VAR_RE.test(result) ? null : result;
}

function resolveVariable(
  name: string,
  fallback: string | undefined,
  lookup: TokenMap,
  visiting: ReadonlySet<string>
): string | null {
  const target = lookup[name];
  if (target !== undefined && !visiting.has(name)) {
    const resolved = resolveReferences(target, lookup, new Set([...visiting, name]));
    if (resolved !== null) return resolved;
  }
  return fallback === undefined ? null : resolveReferences(fallback.trim(), lookup, visiting);
}

/**
 * Parses Tailwind v4 theme tokens out of CSS text. Reads every `@theme`
 * block (including `inline`, `static` and friends) and resolves `var()`
 * references against `:root`, so the common shadcn pattern
 * (`--color-background: var(--background)` with the value in `:root`)
 * yields real values. Dark-mode overrides are not read. A token whose
 * reference cannot be resolved is dropped rather than kept as text.
 */
export function parseThemeCss(css: string): TokenMap {
  const rootVars: TokenMap = {};
  const themeVars: TokenMap = {};
  for (const { prelude, body } of collectBlocks(stripComments(css))) {
    if (/^@theme\b/.test(prelude)) Object.assign(themeVars, readDeclarations(body));
    else if (isRootRule(prelude)) Object.assign(rootVars, readDeclarations(body));
  }

  const lookup = { ...rootVars, ...themeVars };
  const tokens: TokenMap = {};
  for (const [name, value] of Object.entries(themeVars)) {
    const resolved = resolveReferences(value, lookup, new Set([name]));
    if (resolved !== null) tokens[name] = resolved;
  }
  return tokens;
}

/** True when at least one token is a color or a length the diff engine can compare. */
export function hasComparableTokens(tokens: TokenMap): boolean {
  return Object.values(tokens).some((value) => parseColor(value) !== null || LENGTH_RE.test(value.trim()));
}
