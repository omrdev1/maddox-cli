import type { Finding } from "./core.js";

export interface ScanSummary {
  filesScanned: number;
  counts: { match: number; "near-miss": number; unrecognized: number; missing: number };
  findings: Finding[];
}

export function summarize(findings: Finding[], filesScanned: number): ScanSummary {
  const counts = { match: 0, "near-miss": 0, unrecognized: 0, missing: 0 };
  for (const f of findings) counts[f.severity]++;
  return { filesScanned, counts, findings };
}

export function toJson(summary: ScanSummary): string {
  return JSON.stringify(summary, null, 2);
}

export function toText(summary: ScanSummary): string {
  const lines = [
    `Scanned ${summary.filesScanned} files.`,
    `  match:        ${summary.counts.match}`,
    `  near-miss:    ${summary.counts["near-miss"]}`,
    `  unrecognized: ${summary.counts.unrecognized}`,
    `  missing:      ${summary.counts.missing}`,
    "",
  ];
  for (const f of summary.findings) {
    if (f.severity === "match") continue;
    lines.push(
      `${f.file}:${f.line}  [${f.kind}] ${f.rawValue}  → ${f.severity}${
        f.nearestToken ? ` (nearest: ${f.nearestToken})` : ""
      }${f.suggestion ? `  fix: ${f.suggestion}` : ""}`
    );
  }
  return lines.join("\n");
}

const MARKER = "<!-- maddox-engine-drift-report -->";

export function toMarkdown(summary: ScanSummary): string {
  const { counts } = summary;
  const total = counts.match + counts["near-miss"] + counts.unrecognized + counts.missing;
  const nonMatch = summary.findings.filter((f) => f.severity !== "match");

  const lines = [
    MARKER,
    "## Maddox Engine — Drift Report",
    "",
    `Scanned **${summary.filesScanned}** files, **${total}** token/motion/state checks.`,
    "",
    `| Match | Near-miss | Unrecognized | Missing state |`,
    `|---|---|---|---|`,
    `| ${counts.match} | ${counts["near-miss"]} | ${counts.unrecognized} | ${counts.missing} |`,
    "",
  ];

  if (nonMatch.length === 0) {
    lines.push("No drift found. Every checked value matches the design system.");
    return lines.join("\n");
  }

  lines.push("<details><summary>Findings</summary>", "", "| Location | Kind | Value | Severity | Nearest token | Suggested fix |", "|---|---|---|---|---|---|");
  for (const f of nonMatch.slice(0, 100)) {
    lines.push(
      `| \`${f.file}:${f.line}\` | ${f.kind} | \`${f.rawValue}\` | ${f.severity} | ${f.nearestToken ? `\`${f.nearestToken}\`` : "—"} | ${f.suggestion ? `\`${f.suggestion}\`` : "—"} |`
    );
  }
  if (nonMatch.length > 100) {
    lines.push(`| ... | ${nonMatch.length - 100} more findings not shown | | | |`);
  }
  lines.push("", "</details>");

  return lines.join("\n");
}
