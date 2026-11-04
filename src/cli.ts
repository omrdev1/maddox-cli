#!/usr/bin/env -S npx tsx

import { readFileSync } from "node:fs";
import {
  applyFixes,
  audit,
  auditUrl,
  FigmaVariablesUnavailableError,
  healthScore,
  hasUsableGroundTruth,
  loadGroundTruth,
  loadGroundTruthWithFigma,
  loadStateContract,
} from "./core.js";
import { summarize, toJson, toMarkdown, toText, type ScanSummary } from "./format.js";

async function uploadResult(
  apiUrl: string,
  apiKey: string,
  projectName: string,
  summary: ScanSummary,
  source: "cli" | "github_action"
): Promise<boolean> {
  const response = await fetch(`${apiUrl}/api/scans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Maddox-Api-Key": apiKey,
    },
    body: JSON.stringify({
      projectName,
      source,
      filesScanned: summary.filesScanned,
      findings: summary.findings,
    }),
  });

  // Cloud problems never fail a scan: local results are already printed and
  // --fail-below still decides the exit code.
  if (response.status === 429) {
    console.error("\n⚠️ Cloud limit reached (5 scans/month). Upgrade at maddoxengine.com/pricing for unlimited CI scans.");
    return false;
  }
  if (response.status !== 201) {
    console.error(`\nCloud upload failed (${response.status}). Local results above are unaffected.`);
    return false;
  }

  console.error(`\nUploaded. View the run at ${apiUrl}/dashboard`);
  return true;
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// --exclude may be passed more than once, e.g. --exclude "api/**" --exclude "*.generated.ts"
function flagValues(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((arg, i) => {
    if (arg === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
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
        "[--url <live-page-url>] [--apply-fixes] [--figma-file <file-key>] [--api-key <key>] [--exclude <glob>]\n" +
        "  --url scans a deployed page's rendered HTML/CSS instead of local source " +
        "(pass a placeholder for <target-source-dir>, e.g. '-', when using --url alone). " +
        "--states has no effect in --url mode: state-completeness is a source-code check.\n" +
        "  --apply-fixes writes near-miss color/font-size/spacing suggestions back into " +
        "source files (color/font-size/spacing only — motion and state findings are " +
        "never auto-applied). Not available with --url, which has no source to write to.\n" +
        "  --figma-file <file-key> pulls color/spacing tokens from a Figma file's " +
        "Variables (the file key from its URL). Requires an Enterprise Figma plan and " +
        "MADDOX_FIGMA_TOKEN set to a personal access token (or MADDOX_FIGMA_OAUTH_TOKEN " +
        "for an OAuth2 token) — never pass the token as a CLI flag.\n" +
        "  --exclude <glob> skips matching files/directories (repeatable). A pattern " +
        "with no '/' matches at any depth, e.g. --exclude 'api/**' --exclude '*.generated.ts'. " +
        "A <target-source-dir>/.maddoxignore file (one glob per line) is always applied too. " +
        "Test, spec and story files are skipped by default."
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

  const figmaFileKey = flagValue("--figma-file");
  let groundTruth;
  if (figmaFileKey) {
    const patToken = process.env.MADDOX_FIGMA_TOKEN;
    const oauthToken = process.env.MADDOX_FIGMA_OAUTH_TOKEN;
    if (!patToken && !oauthToken) {
      console.error(
        "\n--figma-file requires MADDOX_FIGMA_TOKEN (a personal access token) or " +
          "MADDOX_FIGMA_OAUTH_TOKEN (an OAuth2 access token) to be set."
      );
      process.exit(1);
    }
    try {
      groundTruth = await loadGroundTruthWithFigma(themeCssPath, motionTokens, tokensStudioPath, {
        fileKey: figmaFileKey,
        token: (patToken ?? oauthToken)!,
        authMode: patToken ? "pat" : "oauth",
      });
    } catch (err) {
      if (err instanceof FigmaVariablesUnavailableError) {
        console.error(`\n${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  } else {
    groundTruth = loadGroundTruth(themeCssPath, motionTokens, tokensStudioPath);
  }

  if (!hasUsableGroundTruth(groundTruth)) {
    console.error(
      `\nNo usable design tokens found in ${themeCssPath}.\n` +
        "Maddox reads color and size values from @theme blocks and resolves var() references from :root. " +
        "Point it at the CSS file that defines your theme, or add --tokens-studio or --figma-file."
    );
    process.exit(1);
  }

  const result = url
    ? await auditUrl(url, groundTruth)
    : await audit(targetDir, groundTruth, stateContract, flagValues("--exclude"));
  const summary = summarize(result.findings, result.filesScanned);

  const applyFixesFlag = process.argv.includes("--apply-fixes");
  if (applyFixesFlag) {
    if (url) {
      console.error("\n--apply-fixes has no effect with --url: there is no local source to write to.");
    } else {
      const { applied, skipped } = applyFixes(targetDir, result.findings);
      if (applied.length > 0) {
        console.error(`\nApplied ${applied.length} fix${applied.length === 1 ? "" : "es"}:`);
        for (const fix of applied) {
          console.error(`  ${fix.file}:${fix.line}  ${fix.rawValue} → ${fix.suggestion}`);
        }
      }
      const motionOrStateSkipped = skipped.filter((f) => f.kind === "motion" || f.kind === "state").length;
      if (motionOrStateSkipped > 0) {
        console.error(`\n${motionOrStateSkipped} motion/state finding${motionOrStateSkipped === 1 ? "" : "s"} skipped — not auto-applied (see usage).`);
      }
    }
  }

  const apiKey = flagValue("--api-key") ?? process.env.MADDOX_API_KEY;
  const apiUrl = process.env.MADDOX_API_URL ?? "https://www.maddoxengine.com";

  // Upload first so the markdown report can link to the run only if it exists.
  const uploaded = apiKey
    ? await uploadResult(apiUrl, apiKey, projectName, summary, process.env.GITHUB_ACTIONS ? "github_action" : "cli")
    : false;

  if (format === "json") {
    console.log(toJson(summary));
  } else if (format === "markdown") {
    console.log(toMarkdown(summary, { dashboardUrl: uploaded ? `${apiUrl}/dashboard` : undefined }));
  } else {
    console.log(toText(summary));
  }

  if (!apiKey && format === "text") {
    console.log("\n💡 Tip: Connect to Maddox Cloud for automated PR comments and team dashboards: npx maddox-engine --api-key <key>");
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
