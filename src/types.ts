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

export type Severity = "match" | "near-miss" | "unrecognized" | "missing";

export interface Finding {
  file: string;
  line: number;
  kind: "color" | "spacing" | "font-size" | "motion" | "state";
  rawValue: string;
  severity: Severity;
  nearestToken?: string;
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
