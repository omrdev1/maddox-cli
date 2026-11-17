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

interface ComparedFinding {
  file: string;
  line: number;
  kind: string;
  rawValue: string;
  severity: string;
  suggestion?: string | null;
}

/** What Maddox Cloud returns for a branch or PR scan (paid plans). */
export type ScanComparison =
  | { available: false }
  | {
      available: true;
      baselineBranch: string;
      baseline: { runId: string; createdAt: string; commitSha: string | null } | null;
      added: number;
      fixed: number;
      addedFindings: ComparedFinding[];
      fixedFindings: ComparedFinding[];
    };

export interface MarkdownOptions {
  // Set only when the run was uploaded to Maddox Cloud, so the comment never
  // links to a dashboard run that does not exist.
  dashboardUrl?: string;
  comparison?: ScanComparison | null;
}

const MAX_ADDED_ROWS = 15;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function comparisonMarkdown(c: ScanComparison): string[] {
  if (!c.available) {
    return [
      "> See exactly which drifts this pull request adds and fixes compared with your main branch: [available on Team and Scale](https://www.maddoxengine.com/pricing).",
      "",
    ];
  }
  const branch = `\`${c.baselineBranch}\``;
  if (!c.baseline) {
    return [
      `> No scan of ${branch} yet, so there is nothing to compare with. Run Maddox on pushes to ${branch} as well as on pull requests to see what each PR adds.`,
      "",
    ];
  }
  if (c.added === 0) {
    const fixedNote = c.fixed > 0 ? ` and fixes **${c.fixed}**` : "";
    return [`### ✅ No new drift compared with ${branch}`, "", `This PR introduces no new drift${fixedNote}.`, ""];
  }
  const lines = [
    `### This PR adds **${c.added}** new drift${c.added === 1 ? "" : "s"} and fixes **${c.fixed}** compared with ${branch}`,
    "",
    "| Location | Kind | Found | Replace with |",
    "|---|---|---|---|",
  ];
  for (const f of c.addedFindings.slice(0, MAX_ADDED_ROWS)) {
    lines.push(`| \`${f.file}:${f.line}\` | ${f.kind} | \`${f.rawValue}\` | ${f.suggestion ? `\`${f.suggestion}\`` : "-"} |`);
  }
  if (c.added > MAX_ADDED_ROWS) lines.push(`| | ${plural(c.added - MAX_ADDED_ROWS, "more new drift")} not shown | | |`);
  lines.push("");
  return lines;
}

/** One-line terminal summary of a comparison, or undefined when there is none. */
export function comparisonText(c: ScanComparison | null | undefined): string | undefined {
  if (!c) return undefined;
  if (!c.available) return "Compare against your main branch with a Team or Scale plan.";
  if (!c.baseline) return `No scan of ${c.baselineBranch} yet to compare with.`;
  return `Compared with ${c.baselineBranch}: ${plural(c.added, "new drift")}, ${c.fixed} fixed.`;
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

  if (options.comparison) lines.push(...comparisonMarkdown(options.comparison));

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

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Link to an uploaded run's own dashboard page, or the dashboard if the response has no valid id. */
export function dashboardRunUrl(apiUrl: string, uploadResponse: unknown): string {
  const base = apiUrl.replace(/\/+$/, "");
  const id = (uploadResponse as { scanRunId?: unknown } | null)?.scanRunId;
  return typeof id === "string" && RUN_ID_RE.test(id) ? `${base}/dashboard/runs/${id}` : `${base}/dashboard`;
}
