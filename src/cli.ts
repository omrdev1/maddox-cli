#!/usr/bin/env -S npx tsx

import { readFileSync } from "node:fs";
import { audit, auditUrl, healthScore, loadGroundTruth, loadStateContract } from "./core.js";
import { summarize, toJson, toMarkdown, toText, type ScanSummary } from "./format.js";

async function uploadResult(apiUrl: string, apiKey: string, projectName: string, summary: ScanSummary) {
  const response = await fetch(`${apiUrl}/api/scans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Maddox-Api-Key": apiKey,
    },
    body: JSON.stringify({
      projectName,
      source: "cli",
      filesScanned: summary.filesScanned,
      findings: summary.findings,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upload failed (${response.status}): ${body}`);
  }

  const result = (await response.json()) as { scanRunId: string };
  console.error(`\nUploaded. Scan run: ${result.scanRunId}`);
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const targetDir = process.argv[2];
  const themeCssPath = process.argv[3];
  const url = flagValue("--url");

  if (!themeCssPath || (!targetDir && !url)) {
    console.error(
      "Usage: pnpm scan <target-source-dir> <path-to-globals.css-with-@theme-block> " +
        "[--project <name>] [--motion <path-to-motion-tokens.json>] " +
        "[--states <path-to-state-contract.json>] [--format text|json|markdown] " +
        "[--fail-below <0-100>] [--tokens-studio <path-to-tokens-studio-export.json>] " +
        "[--url <live-page-url>]\n" +
        "  --url scans a deployed page's rendered HTML/CSS instead of local source " +
        "(pass a placeholder for <target-source-dir>, e.g. '-', when using --url alone). " +
        "--states has no effect in --url mode: state-completeness is a source-code check."
    );
    process.exit(1);
  }

  const projectName = flagValue("--project") ?? (url ? new URL(url).hostname : targetDir.split("/").pop()) ?? "unnamed-project";
  const format = flagValue("--format") ?? "text";

  // Motion tokens are an optional external JSON file (a plain object like
  // @grafikui/motion's motionTokens export) — the CLI has no opinion on any
  // one target's motion system, so this stays a vendored/passed-in file
  // per project rather than a hardcoded import.
  const motionPath = flagValue("--motion");
  const motionTokens = motionPath
    ? (JSON.parse(readFileSync(motionPath, "utf-8")) as Record<string, unknown>)
    : {};

  const statesPath = flagValue("--states");
  const stateContract = statesPath ? loadStateContract(statesPath) : undefined;

  const tokensStudioPath = flagValue("--tokens-studio");
  const groundTruth = loadGroundTruth(themeCssPath, motionTokens, tokensStudioPath);

  const result = url ? await auditUrl(url, groundTruth) : await audit(targetDir, groundTruth, stateContract);
  const summary = summarize(result.findings, result.filesScanned);

  if (format === "json") {
    console.log(toJson(summary));
  } else if (format === "markdown") {
    console.log(toMarkdown(summary));
  } else {
    console.log(toText(summary));
  }

  const apiKey = process.env.MADDOX_API_KEY;
  const apiUrl = process.env.MADDOX_API_URL ?? "http://localhost:3000";

  if (apiKey) {
    await uploadResult(apiUrl, apiKey, projectName, summary);
  } else if (format === "text") {
    console.log("\nSet MADDOX_API_KEY to upload results to the dashboard.");
  }

  const failBelowRaw = flagValue("--fail-below");
  if (failBelowRaw !== undefined) {
    const threshold = Number(failBelowRaw);
    if (Number.isNaN(threshold)) {
      console.error(`\n--fail-below expects a number, got "${failBelowRaw}"`);
      process.exit(1);
    }

    const score = healthScore(summary.counts);
    console.error(`\nHealth score: ${score} (threshold: ${threshold})`);

    if (score < threshold) {
      console.error(`Maddox: drift below threshold — failing build (${score} < ${threshold}).`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
