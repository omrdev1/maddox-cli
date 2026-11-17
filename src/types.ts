export type TokenMap = Record<string, string>;

export interface MotionToken {
  path: string; // e.g. "progress.duration"
  value: number | string;
}

export interface GroundTruth {
  tokens: TokenMap;
  motion: MotionToken[];
}

// Maps a component-name pattern (matched against each scanned file's
// basename) to the list of state names that component kind must cover,
// e.g. { "Button": ["disabled", "loading"], "*Input": ["error", "disabled"] }.
export type StateContract = Record<string, string[]>;

// How a suggestion must be written to stay valid where the literal sits:
// "tailwind" = the literal is a whole arbitrary-value bracket (`bg-[#123]`),
// which needs a type hint (`bg-[color:var(--x)]`) because Tailwind cannot
// infer a var()'s type; "js-number" = a bare JS number (`fontSize: 15`),
// which must become a quoted string (`fontSize: "var(--x)"`).
export type FixStyle = "tailwind" | "js-number";

export type Severity = "match" | "near-miss" | "unrecognized" | "missing";

/** What a colour value is used for, read from the property it sits in. */
export type ColorRole = "bg" | "text" | "border";

export interface Finding {
  file: string;
  line: number;
  kind: "color" | "spacing" | "font-size" | "motion" | "state";
  rawValue: string;
  severity: Severity;
  nearestToken?: string;
  // Exact position and source text of the value (1-based column), so
  // --apply-fixes edits that one spot rather than every equal string on
  // the line. Set by extract.ts; absent on state findings.
  column?: number;
  literal?: string;
  fixStyle?: FixStyle;
  // What the colour is used for, from the property it sits in. Used to
  // avoid suggesting, say, a text token for a background.
  role?: ColorRole;
  // A suggested source replacement for `rawValue`, only ever set for
  // "near-miss" or "match"-adjacent findings with a resolvable
  // nearestToken — see suggestFix.ts. Left undefined (never an empty
  // string) when no safe mechanical suggestion exists, e.g. a "missing"
  // state finding, which needs a human to add real handling, not a
  // value swap.
  suggestion?: string;
}

export interface ScanResult {
  findings: Finding[];
  filesScanned: number;
}
