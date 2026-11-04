import { readFileSync } from "node:fs";
import { loadTokensStudioFile } from "./tokensStudio.js";
import { loadFigmaVariables } from "./figmaVariables.js";
import { hasComparableTokens, parseThemeCss } from "./themeCss.js";
import type { GroundTruth, MotionToken, StateContract, TokenMap } from "./types.js";

export { parseThemeCss, hasComparableTokens } from "./themeCss.js";

/** True when there is something to compare against: comparable tokens or motion tokens. */
export function hasUsableGroundTruth(groundTruth: GroundTruth): boolean {
  return hasComparableTokens(groundTruth.tokens) || groundTruth.motion.length > 0;
}

/** Reads a CSS file and parses its Tailwind v4 theme tokens (see parseThemeCss). */
export function parseThemeTokens(cssFilePath: string): TokenMap {
  return parseThemeCss(readFileSync(cssFilePath, "utf-8"));
}

/**
 * Flattens a nested motion tokens object (e.g. @grafikui/motion's
 * `motionTokens` export) into dotted-path leaf values.
 */
export function flattenMotionTokens(
  obj: Record<string, unknown>,
  prefix = ""
): MotionToken[] {
  const out: MotionToken[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenMotionTokens(value as Record<string, unknown>, path));
    } else if (typeof value === "number" || typeof value === "string") {
      out.push({ path, value });
    }
  }
  return out;
}

/**
 * Loads a user-authored state contract: a JSON file mapping a component-name
 * pattern to the state names that component kind must cover. There is no
 * built-in inference of which states a component needs — the contract is
 * the ground truth, same as the @theme block is for tokens.
 */
export function loadStateContract(path: string): StateContract {
  return JSON.parse(readFileSync(path, "utf-8")) as StateContract;
}

export function loadGroundTruth(
  themeCssPath: string,
  motionTokensObj: Record<string, unknown>,
  tokensStudioPath?: string
): GroundTruth {
  // When both a @theme CSS file and a Tokens Studio export are given, the
  // Tokens Studio export (the design tool's source of truth) wins on any
  // path both define — the CSS file is usually the codegen'd output of
  // the same tokens, so a conflict means the CSS is stale, not that the
  // design tokens are wrong.
  const tokens = {
    ...parseThemeTokens(themeCssPath),
    ...(tokensStudioPath ? loadTokensStudioFile(tokensStudioPath) : {}),
  };

  return {
    tokens,
    motion: flattenMotionTokens(motionTokensObj),
  };
}

export interface FigmaVariablesSource {
  fileKey: string;
  token: string;
  authMode?: "pat" | "oauth";
}

/**
 * Same as loadGroundTruth, but with a fourth, optional live Figma
 * Variables source — necessarily async, since it's a real network call,
 * unlike the CSS/Tokens Studio file reads loadGroundTruth wraps. Kept as
 * a separate function rather than making loadGroundTruth itself async,
 * so every existing synchronous call site stays unaffected.
 *
 * Precedence when more than one source defines the same token path:
 * Figma Variables wins over Tokens Studio, which wins over @theme CSS —
 * Figma is the earliest point in a real design-to-code pipeline, and
 * each step after it is more likely to be stale than the one before.
 */
export async function loadGroundTruthWithFigma(
  themeCssPath: string,
  motionTokensObj: Record<string, unknown>,
  tokensStudioPath?: string,
  figma?: FigmaVariablesSource
): Promise<GroundTruth> {
  const tokens = {
    ...parseThemeTokens(themeCssPath),
    ...(tokensStudioPath ? loadTokensStudioFile(tokensStudioPath) : {}),
    ...(figma ? await loadFigmaVariables(figma.fileKey, figma.token, figma.authMode) : {}),
  };

  return {
    tokens,
    motion: flattenMotionTokens(motionTokensObj),
  };
}
