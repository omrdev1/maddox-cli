import type { GitContext } from "./gitContext.js";
import type { ScanComparison } from "./format.js";

/** Workspace-wide CI rules a Scale owner sets once in the dashboard. */
export interface CentralRules {
  failBelow: number | null;
  failOnNewDrift: boolean;
  exceptions: string[];
}

export const EMPTY_CENTRAL_RULES: CentralRules = { failBelow: null, failOnNewDrift: false, exceptions: [] };

export function normalizeExceptionValue(value: string): string {
  return value.trim().toLowerCase();
}

/** Drops drift findings whose value the workspace has approved. Matches are always kept. */
export function applyExceptions<T extends { rawValue: string; severity: string }>(
  findings: T[],
  exceptions: string[]
): { findings: T[]; exceptedCount: number } {
  const allowed = new Set(exceptions.map(normalizeExceptionValue).filter(Boolean));
  if (allowed.size === 0) return { findings, exceptedCount: 0 };
  const kept = findings.filter((f) => f.severity === "match" || !allowed.has(normalizeExceptionValue(f.rawValue)));
  return { findings: kept, exceptedCount: findings.length - kept.length };
}

/** Reads the /api/rules response; anything malformed falls back to no rules. */
export function parseCentralRules(body: unknown): CentralRules {
  if (!body || typeof body !== "object") return EMPTY_CENTRAL_RULES;
  const b = body as Record<string, unknown>;
  const failBelow = typeof b.failBelow === "number" && Number.isInteger(b.failBelow) && b.failBelow >= 0 && b.failBelow <= 100 ? b.failBelow : null;
  return {
    failBelow,
    failOnNewDrift: b.failOnNewDrift === true,
    exceptions: Array.isArray(b.exceptions) ? b.exceptions.filter((v): v is string => typeof v === "string") : [],
  };
}

/**
 * The "fail on new drift" rule. Applies to pull requests only (a push to
 * main has nothing to be compared with), and never fails when there is no
 * baseline to compare against.
 */
export function newDriftVerdict(
  rules: CentralRules,
  git: GitContext,
  comparison: ScanComparison | null | undefined
): { fail: boolean; message?: string } {
  if (!rules.failOnNewDrift || !(git.baseBranch || git.pullRequest)) return { fail: false };
  if (!comparison?.available) {
    return { fail: false, message: "Central rule 'fail on new drift' skipped: comparison unavailable for this scan." };
  }
  if (!comparison.baseline) {
    return { fail: false, message: `Central rule 'fail on new drift' skipped: no earlier scan of ${comparison.baselineBranch} to compare with.` };
  }
  if (comparison.added === 0) return { fail: false };
  const n = comparison.added;
  return { fail: true, message: `Maddox: ${n} new drift${n === 1 ? "" : "s"} compared with ${comparison.baselineBranch} (central rule: fail on new drift) — failing build.` };
}
