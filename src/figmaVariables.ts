import type { TokenMap } from "./types.js";

// The Variables REST API is an Enterprise-plan-only Figma feature — a
// request against a file on a lower plan returns a real error, not an
// empty result. Surfaced as a specific error rather than a generic fetch
// failure so a caller can tell "you can't use this" apart from "the
// network broke" or "your token is wrong".
export class FigmaVariablesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaVariablesUnavailableError";
  }
}

interface FigmaRGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface FigmaVariableAlias {
  type: "VARIABLE_ALIAS";
  id: string;
}

type FigmaVariableValue = boolean | number | string | FigmaRGBA | FigmaVariableAlias;

function isAlias(value: FigmaVariableValue): value is FigmaVariableAlias {
  return typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS";
}

function isRgba(value: FigmaVariableValue): value is FigmaRGBA {
  return typeof value === "object" && value !== null && "r" in value;
}

interface FigmaVariable {
  id: string;
  name: string;
  variableCollectionId: string;
  resolvedType: "BOOLEAN" | "FLOAT" | "STRING" | "COLOR";
  valuesByMode: Record<string, FigmaVariableValue>;
}

interface FigmaVariableCollection {
  id: string;
  name: string;
  defaultModeId: string;
}

interface FigmaVariablesResponse {
  status: number;
  error: boolean;
  meta?: {
    variables: Record<string, FigmaVariable>;
    variableCollections: Record<string, FigmaVariableCollection>;
  };
}

// 0-1 float channel (Figma's RGBA convention) -> a 2-digit hex pair.
function channelToHex(value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 255).toString(16).padStart(2, "0");
}

function rgbaToHex(rgba: FigmaRGBA): string {
  // Alpha is dropped for a fully-opaque color (the common case, and the
  // same #rrggbb shape the rest of the codebase's TokenMap already
  // expects) — only emit an 8-digit #rrggbbaa when the variable is
  // genuinely translucent, so an opaque color's hex stays comparable
  // against a hand-written 6-digit literal in diff.ts's exact-match path.
  const { r, g, b, a } = rgba;
  const hex = `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
  return a >= 0.999 ? hex : `${hex}${channelToHex(a)}`;
}

// Resolves a variable's default-mode value to a raw CSS-comparable string,
// following VariableAlias references. depth guards against a circular
// alias chain (shouldn't exist in a real Figma file, but a corrupted one
// or an API bug shouldn't infinite-loop this).
function resolveValue(
  variable: FigmaVariable,
  variables: Record<string, FigmaVariable>,
  collections: Record<string, FigmaVariableCollection>,
  depth = 0
): string | undefined {
  if (depth > 10) return undefined;

  const collection = collections[variable.variableCollectionId];
  if (!collection) return undefined;

  const raw = variable.valuesByMode[collection.defaultModeId];
  if (raw === undefined) return undefined;

  if (isAlias(raw)) {
    const target = variables[raw.id];
    if (!target) return undefined;
    return resolveValue(target, variables, collections, depth + 1);
  }

  if (isRgba(raw)) return rgbaToHex(raw);

  if (variable.resolvedType === "FLOAT" && typeof raw === "number") {
    // Figma's Variables API has no unit on a FLOAT value — it's a bare
    // number. Figma's own UI treats spacing/sizing/radius scales as
    // pixel values by default, so this assumes px; a variable that's
    // actually meant as a unitless multiplier or a different unit will
    // be wrong here. Documented, not silently guessed past.
    return `${raw}px`;
  }

  // STRING and BOOLEAN resolvedTypes don't reduce to a single comparable
  // CSS value the way color/spacing do (a string variable might be a
  // font-family name, an ID reference, anything) — skipped rather than
  // misclassified, same policy tokensStudio.ts uses for composite types.
  return undefined;
}

/**
 * Fetches a Figma file's local Variables (Enterprise plan only) and
 * flattens color/spacing-typed variables, resolved to their default
 * mode, into the same TokenMap shape parseThemeTokens/
 * loadTokensStudioFile produce. Each variable's own name becomes its
 * token key, `--`-prefixed and slash/space-normalized to match the
 * existing --token-name convention.
 *
 * Only ever reads the DEFAULT mode of each variable's collection — a
 * collection with light/dark or brand-A/B modes has one value per mode,
 * but Maddox's ground truth is a single flat TokenMap, the same
 * constraint loadTokensStudioFile's multi-set merge already has to work
 * within. Non-default modes are not read at all, not even as a fallback.
 *
 * @param fileKey - the file key from a Figma file's URL
 *   (figma.com/design/:file_key/...)
 * @param token - a Personal Access Token or OAuth2 access token
 * @param authMode - "pat" sends the token via X-Figma-Token (the header
 *   Figma's own PAT documentation specifies); "oauth" sends it via
 *   Authorization: Bearer (the OAuth2 convention). Both are real,
 *   independently-confirmed-working auth mechanisms against the live
 *   Figma API — which one to use depends on how the token was obtained,
 *   not a fixed choice this function can make for the caller.
 */
export async function loadFigmaVariables(
  fileKey: string,
  token: string,
  authMode: "pat" | "oauth" = "pat"
): Promise<TokenMap> {
  const headers: Record<string, string> =
    authMode === "pat" ? { "X-Figma-Token": token } : { Authorization: `Bearer ${token}` };

  const response = await fetch(`https://api.figma.com/v1/files/${fileKey}/variables/local`, { headers });

  if (response.status === 403) {
    throw new FigmaVariablesUnavailableError(
      "Figma Variables API access denied (403) — this endpoint requires an Enterprise Figma plan " +
        "and a token with the file_variables:read scope. Free/Professional/Organization plans cannot use it."
    );
  }
  if (!response.ok) {
    throw new Error(`Figma Variables API request failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as FigmaVariablesResponse;
  if (body.error || !body.meta) {
    throw new Error(`Figma Variables API returned an error response (status ${body.status})`);
  }

  const { variables, variableCollections } = body.meta;
  const tokens: TokenMap = {};

  for (const variable of Object.values(variables)) {
    if (variable.resolvedType !== "COLOR" && variable.resolvedType !== "FLOAT") continue;

    const value = resolveValue(variable, variables, variableCollections);
    if (value === undefined) continue;

    const key = `--${variable.name.replace(/[\s/]+/g, "-").toLowerCase()}`;
    tokens[key] = value;
  }

  return tokens;
}
