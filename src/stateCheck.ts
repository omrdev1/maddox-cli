import type { ScannedFile } from "./extract.js";
import type { Finding, StateContract } from "./types.js";

// Heuristic identifiers that count as "this state is handled" when they
// appear anywhere in a component's file — a prop name, a CSS pseudo-class,
// or a status string used in a conditional. This is string-matching, not
// control-flow analysis: it can't tell whether the branch actually renders
// correctly, only whether the concept is referenced at all.
const STATE_IDENTIFIER_PATTERNS: Record<string, RegExp[]> = {
  disabled: [/\bdisabled\b/i, /:disabled/i],
  loading: [/\bloading\b/i, /\bisLoading\b/i, /\bpending\b/i],
  error: [/\berror\b/i, /\bisError\b/i],
  empty: [/\bempty\b/i, /\bisEmpty\b/i],
  active: [/\bactive\b/i, /:active/i, /\bisActive\b/i],
  hover: [/:hover/i, /\bonHover\b/i, /\bisHovered\b/i],
  focus: [/:focus/i, /\bonFocus\b/i, /\bisFocused\b/i],
};

function hasState(content: string, state: string): boolean {
  const patterns = STATE_IDENTIFIER_PATTERNS[state.toLowerCase()];
  if (patterns) return patterns.some((re) => re.test(content));
  // No built-in heuristic for this state name — fall back to a plain
  // word-boundary match on the state name itself.
  return new RegExp(`\\b${state}\\b`, "i").test(content);
}

function matchesPattern(fileName: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
    return re.test(fileName);
  }
  return fileName.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Checks each scanned file against the state contract: if the file's name
 * matches a contract pattern, every required state for that pattern must
 * have at least one matching identifier somewhere in the file's content.
 * Emits one Finding per missing state; matched states are not reported
 * (kept consistent with diffUsages, which also only ever needs to explain
 * non-matches — matches are implicit by absence of a finding).
 */
export function checkStates(files: ScannedFile[], contract: StateContract): Finding[] {
  const findings: Finding[] = [];

  for (const { file, content } of files) {
    const fileName = file.split("/").pop() ?? file;

    for (const [pattern, requiredStates] of Object.entries(contract)) {
      if (!matchesPattern(fileName, pattern)) continue;

      for (const state of requiredStates) {
        if (hasState(content, state)) continue;
        findings.push({
          file,
          line: 1,
          kind: "state",
          rawValue: state,
          severity: "missing",
          nearestToken: pattern,
        });
      }
    }
  }

  return findings;
}
