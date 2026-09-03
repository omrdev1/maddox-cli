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
}

export interface ScanResult {
  findings: Finding[];
  filesScanned: number;
}
