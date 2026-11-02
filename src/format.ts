import { healthScore, type Finding } from "./core.js";

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
const MAX_NEAR_MISS_ROWS = 15;
const MAX_OTHER_ROWS = 100;

export interface MarkdownOptions {
  // Set only when the run was uploaded to Maddox Cloud, so the comment never
  // links to a dashboard run that does not exist.
  dashboardUrl?: string;
}

function scoreBadge(score: number): string {
  const color = score >= 90 ? "brightgreen" : score >= 70 ? "yellow" : "red";
  return `![Drift health ${score}/100](https://img.shields.io/badge/drift%20health-${score}%2F100-${color})`;
}

export function toMarkdown(summary: ScanSummary, options: MarkdownOptions = {}): string {
  const { counts } = summary;
  const total = counts.match + counts["near-miss"] + counts.unrecognized + counts.missing;
  const score = healthScore(counts);
  const nearMisses = summary.findings.filter((f) => f.severity === "near-miss");
  const others = summary.findings.filter((f) => f.severity !== "match" && f.severity !== "near-miss");

  const lines = [
    MARKER,
    "## Maddox Engine drift report",
    "",
    "| Health score | Near-miss tokens | Unrecognized | Missing states |",
    "|---|---|---|---|",
    `| ${scoreBadge(score)} | ${counts["near-miss"]} | ${counts.unrecognized} | ${counts.missing} |`,
    "",
    `Scanned **${summary.filesScanned}** files, **${total}** checks.`,
    "",
  ];

  if (nearMisses.length === 0 && others.length === 0) {
    lines.push("No drift found. Every checked value matches the design system.", "");
  }

  if (nearMisses.length > 0) {
    lines.push(
      `### Near-miss tokens (${nearMisses.length})`,
      "",
      "| Location | Found | Design token (Figma / CSS) | Replace with |",
      "|---|---|---|---|"
    );
    for (const f of nearMisses.slice(0, MAX_NEAR_MISS_ROWS)) {
      lines.push(
        `| \`${f.file}:${f.line}\` | \`${f.rawValue}\` | ${f.nearestToken ? `\`${f.nearestToken}\`` : "-"} | ${f.suggestion ? `\`${f.suggestion}\`` : "-"} |`
      );
    }
    if (nearMisses.length > MAX_NEAR_MISS_ROWS) {
      lines.push(`| | ${nearMisses.length - MAX_NEAR_MISS_ROWS} more near-misses not shown | | |`);
    }
    lines.push("");
  }

  if (others.length > 0) {
    lines.push(
      `<details><summary>Unrecognized values and missing states (${others.length})</summary>`,
      "",
      "| Location | Kind | Value | Severity |",
      "|---|---|---|---|"
    );
    for (const f of others.slice(0, MAX_OTHER_ROWS)) {
      lines.push(`| \`${f.file}:${f.line}\` | ${f.kind} | \`${f.rawValue}\` | ${f.severity} |`);
    }
    if (others.length > MAX_OTHER_ROWS) {
      lines.push(`| | ${others.length - MAX_OTHER_ROWS} more not shown | | |`);
    }
    lines.push("", "</details>", "");
  }

  if (options.dashboardUrl) {
    lines.push(`[View this run on the Maddox dashboard](${options.dashboardUrl})`);
  }

  return lines.join("\n").trimEnd();
}
