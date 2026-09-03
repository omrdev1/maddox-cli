import { readFileSync } from "node:fs";
import type { GroundTruth, MotionToken, StateContract, TokenMap } from "./types.js";

/**
 * Parses a Tailwind v4 `@theme { ... }` block into a flat token map.
 * Only reads inside the @theme block, not the rest of the CSS file.
 */
export function parseThemeTokens(cssFilePath: string): TokenMap {
  const css = readFileSync(cssFilePath, "utf-8");
  const themeMatch = css.match(/@theme\s*{([\s\S]*?)}/);
  if (!themeMatch) return {};

  const themeBlock = themeMatch[1];
  const tokens: TokenMap = {};
  const varRegex = /(--[\w-]+):\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = varRegex.exec(themeBlock)) !== null) {
    tokens[match[1].trim()] = match[2].trim();
  }
  return tokens;
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
  motionTokensObj: Record<string, unknown>
): GroundTruth {
  return {
    tokens: parseThemeTokens(themeCssPath),
    motion: flattenMotionTokens(motionTokensObj),
  };
}
