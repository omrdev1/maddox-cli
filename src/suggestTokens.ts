// Suggested new tokens: colours a project uses again and again that its
// theme doesn't name. Adding them is a design decision, so this proposes,
// with a name, a count and the score it would give; it never edits a theme.
import { parseAlpha, parseColor, type Rgb } from "./color.js";
import { healthScore } from "./healthScore.js";
import type { Finding, TokenMap } from "./types.js";

export interface SuggestedToken {
  name: string;
  value: string;
  uses: number;
}

export interface TokenSuggestions {
  tokens: SuggestedToken[];
  currentScore: number;
  projectedScore: number; // if every suggested token were added to the theme
}

const HUES: [number, string][] = [
  [15, "red"], [40, "orange"], [50, "amber"], [65, "yellow"], [85, "lime"], [150, "green"],
  [185, "teal"], [200, "cyan"], [215, "sky"], [245, "blue"], [265, "indigo"], [290, "violet"],
  [315, "purple"], [345, "pink"], [360, "red"],
];
// Lightness (percent) at or above which each step applies: an even 10% per step,
// with finer steps at the dark end, where hardware and dark UIs keep several shades.
const STEPS: [number, number][] = [
  [95, 50], [90, 100], [80, 200], [70, 300], [60, 400], [50, 500], [40, 600], [30, 700], [20, 800], [12, 900], [8, 950],
];

function hsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

/** A readable token name for a colour: hue and a 50 to 950 lightness step, or white/black with an alpha suffix. */
export function nameForColor(value: string): string {
  const rgb = parseColor(value);
  if (!rgb) return "--color-custom";
  const alpha = parseAlpha(value);
  const suffix = alpha < 1 ? `-a${Math.round(alpha * 100)}` : "";
  if (alpha < 1 && rgb.every((c) => c === 255)) return `--color-white${suffix}`;
  if (alpha < 1 && rgb.every((c) => c === 0)) return `--color-black${suffix}`;
  const { h, s, l } = hsl(rgb);
  const hue = s < 0.12 ? "gray" : (HUES.find(([limit]) => h < limit) ?? HUES[0])[1];
  const step = (STEPS.find(([min]) => l * 100 >= min) ?? [0, 975])[1]; // 975: near-black shades
  return `--color-${hue}-${step}${suffix}`;
}

// One key per actual colour, however it's written (spacing, case, hex or rgb).
// Hue-and-step names (--color-red-600) are Tailwind's built-in palette names;
// adding one to a Tailwind theme would redefine every existing use of that
// class. Putting the colour's main role in front avoids that and says what
// the colour is for: --color-bg-red-600, --color-text-teal-400, --color-ui-…
const HUE_STEP_RE = /^--color-([a-z]+-\d+)$/;
const withRole = (name: string, role: string) => name.replace(HUE_STEP_RE, `--color-${role}-$1`);
const mostCommon = (roles: Map<string, number>) => [...roles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "ui";

const normalize = (value: string) => {
  const rgb = parseColor(value);
  return rgb ? `${rgb.join(",")},${Math.round(parseAlpha(value) * 100)}` : value.trim().toLowerCase();
};

// Worth naming: drift with no token close enough, or a near-miss that can't
// safely become its nearest token (translucent, the wrong role for that
// token, or a stop in a deliberate shade-to-shade gradient).
function isCandidate(f: Finding): boolean {
  if (f.kind !== "color") return false;
  if (f.severity === "unrecognized") return true;
  return f.severity === "near-miss" && (!f.suggestion || f.inGradient === true);
}

/**
 * Colours used at least `minUses` times that the theme doesn't name, most used
 * first, each with a proposed token name that doesn't clash with existing ones.
 */
export function suggestTokens(findings: Finding[], existing: TokenMap, { minUses = 5 }: { minUses?: number } = {}): TokenSuggestions {
  const counts = new Map<string, { value: string; uses: number; roles: Map<string, number> }>();
  for (const f of findings) {
    if (!isCandidate(f)) continue;
    const key = normalize(f.rawValue);
    const entry = counts.get(key) ?? { value: f.rawValue, uses: 0, roles: new Map() };
    entry.uses++;
    const role = f.role ?? "ui";
    entry.roles.set(role, (entry.roles.get(role) ?? 0) + 1);
    counts.set(key, entry);
  }

  const taken = new Set(Object.keys(existing));
  const tokens: SuggestedToken[] = [];
  for (const { value, uses, roles } of [...counts.values()].filter((c) => c.uses >= minUses).sort((a, b) => b.uses - a.uses)) {
    const base = withRole(nameForColor(value), mostCommon(roles));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    tokens.push({ name, value, uses });
  }

  const count = (list: Finding[]) => ({
    match: list.filter((f) => f.severity === "match").length,
    "near-miss": list.filter((f) => f.severity === "near-miss").length,
    unrecognized: list.filter((f) => f.severity === "unrecognized").length,
    missing: list.filter((f) => f.severity === "missing").length,
  });
  const adopted = new Set(tokens.map((t) => normalize(t.value)));
  const projected = findings.map((f) => (isCandidate(f) && adopted.has(normalize(f.rawValue)) ? { ...f, severity: "match" as const } : f));
  return { tokens, currentScore: healthScore(count(findings)), projectedScore: healthScore(count(projected)) };
}

/** A ready-to-paste @theme block for the suggested tokens. */
export function themeSnippet(tokens: SuggestedToken[]): string {
  return `@theme {\n${tokens.map((t) => `  ${t.name}: ${t.value}; /* ${t.uses} uses */`).join("\n")}\n}`;
}
