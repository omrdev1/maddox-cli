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

export type HoldReason = "animation" | "gradient" | "email";

export interface HeldFix {
  finding: Finding;
  // animation: inside a Framer Motion prop or GSAP tween, which can't animate var().
  // gradient: the fix would make two neighbouring gradient stops identical.
  // email: an email or HTML template, where clients don't support CSS variables.
  reason: HoldReason;
}

// Framer Motion animation props and GSAP tweens interpolate literal colours;
// a var() there makes the animation jump instead of fade.
const ANIMATION_RE = /\b(?:animate|initial|exit|whileHover|whileTap|whileInView|whileFocus|whileDrag)\s*=\s*\{|\.(?:to|from|fromTo|set)\s*\(|\bgsap\b|\buseSpring\s*\(|\bkeyframes\s*:/;
// Email clients don't support CSS variables.
const EMAIL_TEMPLATE_RE = /<(?:html|table|tbody)\b|from\s+["'](?:resend|nodemailer|@react-email\/[^"']*)["']/;
const GRADIENT_RE = /(?:repeating-)?(?:linear|radial|conic)-gradient\(/g;

function gradientSpans(line: string): [number, number][] {
  const spans: [number, number][] = [];
  GRADIENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GRADIENT_RE.exec(line)) !== null) {
    let depth = 0;
    let end = line.length;
    for (let i = m.index + m[0].length - 1; i < line.length; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    spans.push([m.index, end]);
  }
  return spans;
}

const tokenOf = (text: string) => /var\((--[\w-]+)\)/.exec(text)?.[1] ?? text.toLowerCase();

/**
 * Fixable findings on a line whose fixes would make two neighbouring stops of
 * one gradient identical (a deliberate shade-to-shade gradient flattened into
 * one colour). `all` is every colour finding on the line, fixable or not.
 */
function collapsingGradientFixes(line: string, all: Finding[], fixable: Set<Finding>): Finding[] {
  const held: Finding[] = [];
  for (const [start, end] of gradientSpans(line)) {
    const stops = all
      .filter((f) => f.kind === "color" && f.column !== undefined && f.column - 1 >= start && f.column - 1 < end)
      .sort((a, b) => (a.column ?? 0) - (b.column ?? 0));
    const before = stops.map((f) => tokenOf(f.rawValue));
    const after = stops.map((f, i) => (fixable.has(f) && f.suggestion ? tokenOf(f.suggestion) : before[i]));
    const collapses = after.some((v, i) => i > 0 && v === after[i - 1] && before[i] !== before[i - 1]);
    if (collapses) held.push(...stops.filter((f) => fixable.has(f)));
  }
  return held;
}

export interface ApplyFixesResult {
  applied: AppliedFix[];
  // Findings that had a suggestion but were skipped — motion (unsafe
  // import assumption) or a line whose current content no longer
  // contains rawValue (the file changed since the scan ran; applying
  // blind here risks touching the wrong text).
  skipped: Finding[];
  // Fixes deliberately not applied, with the reason, for a person to decide.
  held: HeldFix[];
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
  const held: HeldFix[] = [];
  const allByFile = new Map<string, Finding[]>();
  for (const finding of findings) allByFile.set(finding.file, [...(allByFile.get(finding.file) ?? []), finding]);

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

    if (EMAIL_TEMPLATE_RE.test(content)) {
      held.push(...fileFindings.map((finding) => ({ finding, reason: "email" as const })));
      continue;
    }

    const lines = content.split("\n");
    let changed = false;

    // Hold fixes in animations and in gradients they would flatten.
    const heldHere = new Set<Finding>();
    const fixableSet = new Set(fileFindings);
    for (const finding of fileFindings) {
      const text = lines[finding.line - 1];
      if (text !== undefined && ANIMATION_RE.test(text)) {
        held.push({ finding, reason: "animation" });
        heldHere.add(finding);
      }
    }
    const lineNumbers = new Set(fileFindings.map((f) => f.line));
    for (const n of lineNumbers) {
      const text = lines[n - 1];
      if (text === undefined) continue;
      const onLine = (allByFile.get(file) ?? []).filter((f) => f.line === n);
      for (const finding of collapsingGradientFixes(text, onLine, fixableSet)) {
        if (heldHere.has(finding)) continue;
        held.push({ finding, reason: "gradient" });
        heldHere.add(finding);
      }
    }

    // Dedupe by (line, rawValue): the replace below already handles every
    // occurrence of a value on its line in one pass, so if the scan
    // reported the same value on the same line more than once (e.g. two
    // separate regex matches for one literal repeated in a line), only
    // the first needs to actually run the replacement — without this, a
    // second finding for an already-fixed line would find nothing left to
    // replace and land in `skipped`, misreporting an applied fix as one
    // that failed.
    const seen = new Set<string>();
    const uniqueFindings = fileFindings.filter((f) => !heldHere.has(f)).filter((f) => {
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

  return { applied, skipped, held };
}
