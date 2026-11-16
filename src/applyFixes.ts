import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./types.js";

// Only these kinds get a self-contained, always-valid replacement
// expression (var(--token-name), which needs no import and can't break
// compilation in any file it lands in). "motion" suggestions read
// motionTokens.path.to.value — text that assumes an import named
// motionTokens exists in scope, which suggestFix.ts has no way to verify
// per-file, so applying it mechanically could silently break the build.
// "state" findings never get a suggestion at all (see suggestFix.ts).
const AUTO_APPLIABLE_KINDS = new Set<Finding["kind"]>(["color", "font-size", "spacing"]);

export interface AppliedFix {
  file: string;
  line: number;
  rawValue: string;
  suggestion: string;
  occurrences: number;
}

export interface ApplyFixesResult {
  applied: AppliedFix[];
  // Findings that had a suggestion but were skipped — motion (unsafe
  // import assumption) or a line whose current content no longer
  // contains rawValue (the file changed since the scan ran; applying
  // blind here risks touching the wrong text).
  skipped: Finding[];
}

/**
 * Writes suggestFix's suggestions back into source files, for findings
 * whose kind has a self-contained replacement expression. Never touches
 * "motion" or "state" findings — see AUTO_APPLIABLE_KINDS.
 *
 * Applies per-file: reads once, replaces every exact-value occurrence
 * on each finding's reported line (same literal repeated on one line —
 * e.g. `color: #0d0d0d; border-color: #0d0d0d;` — is the same drift
 * twice, both get fixed), writes once. A finding whose line no longer
 * contains its rawValue (file changed since the scan that produced this
 * Finding) is skipped rather than guessed at.
 *
 * rootDir is the same directory audit() was called with — Finding.file
 * is relative to it, matching how scanSource reports paths.
 */
export function applyFixes(rootDir: string, findings: Finding[]): ApplyFixesResult {
  const applied: AppliedFix[] = [];
  const skipped: Finding[] = [];

  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (!finding.suggestion || !AUTO_APPLIABLE_KINDS.has(finding.kind)) {
      if (finding.suggestion) skipped.push(finding);
      continue;
    }
    const existing = byFile.get(finding.file) ?? [];
    existing.push(finding);
    byFile.set(finding.file, existing);
  }

  for (const [file, fileFindings] of byFile) {
    const fullPath = join(rootDir, file);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      skipped.push(...fileFindings);
      continue;
    }

    const lines = content.split("\n");
    let changed = false;

    // Dedupe by (line, rawValue): the replace below already handles every
    // occurrence of a value on its line in one pass, so if the scan
    // reported the same value on the same line more than once (e.g. two
    // separate regex matches for one literal repeated in a line), only
    // the first needs to actually run the replacement — without this, a
    // second finding for an already-fixed line would find nothing left to
    // replace and land in `skipped`, misreporting an applied fix as one
    // that failed.
    const seen = new Set<string>();
    const uniqueFindings = fileFindings.filter((f) => {
      const key = `${f.line}:${f.column ?? ""}:${f.rawValue}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Right to left within a line, so an edit never shifts the column of
    // a finding still to be applied on the same line.
    uniqueFindings.sort((a, b) => a.line - b.line || (b.column ?? 0) - (a.column ?? 0));

    for (const finding of uniqueFindings) {
      const lineIndex = finding.line - 1;
      const line = lines[lineIndex];
      if (line === undefined) {
        skipped.push(finding);
        continue;
      }

      // Position-exact path (every finding from extract.ts): replace only the
      // literal at its own column, so equal text elsewhere on the line, even
      // the same value as a different kind, is never touched.
      if (finding.column !== undefined && finding.literal !== undefined) {
        const start = finding.column - 1;
        if (line.slice(start, start + finding.literal.length) !== finding.literal) {
          skipped.push(finding);
          continue;
        }
        lines[lineIndex] = line.slice(0, start) + finding.suggestion! + line.slice(start + finding.literal.length);
        changed = true;
        applied.push({ file, line: finding.line, rawValue: finding.rawValue, suggestion: finding.suggestion!, occurrences: 1 });
        continue;
      }

      // Findings without a position (built by hand by an API caller) fall
      // back to replacing the value wherever it appears on its line.

      // Hex values are normalized to lowercase during extraction, so match
      // hex literals case-insensitively while guarding against prefix hits
      // (e.g. `#fff` must not match inside `#ffffff`).
      let occurrences = 0;
      if (/^#[0-9a-f]+$/i.test(finding.rawValue)) {
        const escaped = finding.rawValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`${escaped}(?![0-9a-f])`, "gi");
        const matches = line.match(re);
        if (!matches || matches.length === 0) {
          skipped.push(finding);
          continue;
        }
        occurrences = matches.length;
        lines[lineIndex] = line.replace(re, finding.suggestion!);
      } else {
        if (!line.includes(finding.rawValue)) {
          skipped.push(finding);
          continue;
        }
        occurrences = line.split(finding.rawValue).length - 1;
        lines[lineIndex] = line.split(finding.rawValue).join(finding.suggestion!);
      }

      changed = true;
      applied.push({
        file,
        line: finding.line,
        rawValue: finding.rawValue,
        suggestion: finding.suggestion!,
        occurrences,
      });
    }

    if (changed) {
      writeFileSync(fullPath, lines.join("\n"));
    }
  }

  return { applied, skipped };
}
