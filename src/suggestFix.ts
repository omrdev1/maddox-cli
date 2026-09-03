import type { Finding } from "./types.js";

/**
 * Builds the suggested source replacement for a single Finding's raw
 * value, given the token/motion-path name diff.ts already matched it
 * against (`nearestToken`). Returns undefined when no safe mechanical
 * suggestion exists — either there's no nearestToken to point at, or the
 * finding kind isn't a value swap at all (state completeness).
 *
 * Deliberately conservative: this only ever proposes replacing the exact
 * literal Maddox found with a reference to the token it's closest to. It
 * never tries to rewrite surrounding code, infer intent for an
 * "unrecognized" value with no near match, or auto-apply anything — the
 * suggestion is text for a human (or a future codemod) to review, not an
 * automatic edit.
 */
export function suggestFix(finding: Finding): string | undefined {
  if (!finding.nearestToken) return undefined;
  if (finding.severity !== "near-miss" && finding.severity !== "match") return undefined;

  switch (finding.kind) {
    case "color":
    case "font-size":
    case "spacing":
      // nearestToken is a "--token-name" CSS custom property name — the
      // replacement is how that token is actually consumed in Tailwind
      // v4 / plain CSS: var(--token-name).
      return `var(${finding.nearestToken})`;

    case "motion": {
      // nearestToken is a dotted motion-token path, e.g.
      // "transition.duration" — how it's actually referenced depends on
      // the project's own motion tokens object import, which Maddox has
      // no fixed name for, so this suggests the access path relative to
      // a generic `motionTokens` import rather than guessing a project's
      // real variable name.
      return `motionTokens.${finding.nearestToken}`;
    }

    case "state":
      // No mechanical value swap exists for a missing state — this needs
      // a human to add real handling.
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Applies suggestFix to every finding in place, populating `.suggestion`
 * where a safe suggestion exists. Mutates and returns the same array —
 * matches diffUsages' existing per-finding transform style rather than
 * introducing a different pattern for one more derived field.
 */
export function attachSuggestions(findings: Finding[]): Finding[] {
  for (const finding of findings) {
    finding.suggestion = suggestFix(finding);
  }
  return findings;
}
