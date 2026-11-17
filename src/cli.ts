#!/usr/bin/env node

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
import { comparisonText, dashboardRunUrl, summarize, toJson, toMarkdown, toText, type ScanComparison, type ScanSummary } from "./format.js";
import { detectGitContext, type GitContext } from "./gitContext.js";
import { checkText, runCheck } from "./check.js";
import { suggestTokens, themeSnippet } from "./suggestTokens.js";
import { ConfigError, findConfig, loadConfig, type MaddoxConfig } from "./config.js";
import { applyExceptions, EMPTY_CENTRAL_RULES, newDriftVerdict, parseCentralRules, type CentralRules } from "./centralRules.js";

// Exit codes: 1 = drift failed a rule (--fail-below or central rules),
// 2 = the scan itself could not run (bad arguments, no tokens, a crash).
// The Action uses the difference so comment-only setups stay comment-only.
const SCAN_ERROR = 2;

// Central rules never block a scan: if they can't be fetched, the scan runs
// with local flags only and says so.
async function fetchCentralRules(apiUrl: string, apiKey: string): Promise<CentralRules> {
  try {
    const response = await fetch(`${apiUrl}/api/rules`, {
      headers: { "X-Maddox-Api-Key": apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`\n⚠️ Could not load central rules (${response.status}); continuing with local flags only.`);
      return EMPTY_CENTRAL_RULES;
    }
    return parseCentralRules(await response.json().catch(() => null));
  } catch {
    console.error("\n⚠️ Could not reach Maddox Cloud for central rules; continuing with local flags only.");
    return EMPTY_CENTRAL_RULES;
  }
}

async function uploadResult(
  apiUrl: string,
  apiKey: string,
  projectName: string,
  summary: ScanSummary,
  source: "cli" | "github_action",
  git: GitContext
): Promise<{ runUrl: string; comparison: ScanComparison | null } | undefined> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/scans`, {
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
        ...(git.branch ? { git } : {}),
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    console.error("\nCould not reach Maddox Cloud to upload. Local results above are unaffected.");
    return undefined;
  }

  // Cloud problems never fail a scan: local results are already printed and
  // --fail-below still decides the exit code.
  const body = await response.json().catch(() => null);
  if (response.status !== 201) {
    // Plan limits (429 monthly uploads, 403 projects) come with a readable reason from the server.
    const reason = typeof body?.error === "string" ? body.error : `Cloud upload failed (${response.status}).`;
    const prefix = response.status === 429 || response.status === 403 ? "⚠️ " : "";
    console.error(`\n${prefix}${reason} Local results above are unaffected.`);
    return undefined;
  }

  const runUrl = dashboardRunUrl(apiUrl, body);
  const comparison = (body?.comparison ?? null) as ScanComparison | null;
  console.error(`\nUploaded. View the run at ${runUrl}`);
  const compared = comparisonText(comparison);
  if (compared) console.error(compared);
  return { runUrl, comparison };
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// `maddox check <file> [--stdin] [--format text|json]`: one file against the
// project's tokens, found through maddox.config.json. Local only, no API key.
// Exit 0: no drift (or file skipped). 1: drift found. 2: could not check.
async function checkCommand(args: string[]) {
  const formatAt = args.indexOf("--format");
  const format = formatAt === -1 ? "text" : args[formatAt + 1];
  if (format !== "text" && format !== "json") {
    console.error(`--format for check must be text or json, got "${format ?? ""}"`);
    process.exit(SCAN_ERROR);
  }
  const file = args.find((a, i) => !a.startsWith("--") && (formatAt === -1 || i !== formatAt + 1));
  if (!file) {
    console.error("Usage: maddox check <file> [--stdin] [--format text|json]");
    process.exit(SCAN_ERROR);
  }
  const content = args.includes("--stdin") ? await readStdin() : undefined;
  const result = runCheck({ file, content, cwd: process.cwd() });
  if (format === "json") console.log(JSON.stringify(result, null, 2));
  else (result.status === "error" ? console.error : console.log)(checkText(result));
  process.exit(result.status === "error" ? SCAN_ERROR : result.status === "checked" && result.findings.length > 0 ? 1 : 0);
}

// Names kept for upcoming subcommands, so their meaning never changes under
// someone's existing script. A folder with one of these names is scanned as ./name.
const RESERVED_SUBCOMMANDS = new Set(["hook", "mcp", "init"]);

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

async function main() {
  const first = process.argv[2];
  if (first === "--version" || first === "-v") {
    console.log(packageVersion());
    return;
  }
  // Subcommands come first. A folder that shares a subcommand's name can be
  // scanned as ./check.
  if (first === "check") return checkCommand(process.argv.slice(3));
  if (first && RESERVED_SUBCOMMANDS.has(first)) {
    console.error(`"maddox ${first}" is not available in this version yet. To scan a folder named ${first}, use ./${first}.`);
    process.exit(SCAN_ERROR);
  }
  const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");

  // With no paths given, read them from maddox.config.json. Flags still win.
  let config: MaddoxConfig | undefined;
  const hasPositional = process.argv[2] !== undefined && !process.argv[2].startsWith("--");
  if (!hasPositional && !wantsHelp) {
    const configPath = findConfig(process.cwd());
    if (configPath) {
      try {
        config = loadConfig(configPath);
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        console.error(`\n${err.message}`);
        process.exit(SCAN_ERROR);
      }
    }
  }
  // Without a config, the paths must come first; never read a flag's value as a path.
  const targetDir = config ? config.source : hasPositional ? process.argv[2] : "";
  const themeCssPath = config ? config.theme : hasPositional ? process.argv[3] : "";
  const url = flagValue("--url");

  if (wantsHelp || !themeCssPath || (!targetDir && !url)) {
    (wantsHelp ? console.log : console.error)(
      "Usage: maddox <target-source-dir> <path-to-globals.css-with-@theme-block> " +
        "[--project <name>] [--motion <path-to-motion-tokens.json>] " +
        "[--states <path-to-state-contract.json>] [--format text|json|markdown] " +
        "[--fail-below <0-100>] [--tokens-studio <path-to-tokens-studio-export.json>] " +
        "[--url <live-page-url>] [--apply-fixes] [--figma-file <file-key>] [--api-key <key>] [--exclude <glob>]\n" +
        "  --url scans a deployed page's rendered HTML/CSS instead of local source " +
        "(pass a placeholder for <target-source-dir>, e.g. '-', when using --url alone). " +
        "--states has no effect in --url mode: state-completeness is a source-code check.\n" +
        "  --apply-fixes writes near-miss color/font-size/spacing suggestions back into " +
        "source files (color/font-size/spacing only, never a translucent color — motion and state findings are " +
        "never auto-applied). Not available with --url, which has no source to write to.\n" +
        "  --figma-file <file-key> pulls color/spacing tokens from a Figma file's " +
        "Variables (the file key from its URL). Requires an Enterprise Figma plan and " +
        "MADDOX_FIGMA_TOKEN set to a personal access token (or MADDOX_FIGMA_OAUTH_TOKEN " +
        "for an OAuth2 token) — never pass the token as a CLI flag.\n" +
        "  --exclude <glob> skips matching files/directories (repeatable). A pattern " +
        "with no '/' matches at any depth, e.g. --exclude 'api/**' --exclude '*.generated.ts'. " +
        "A <target-source-dir>/.maddoxignore file (one glob per line) is always applied too. " +
        "Test, spec and story files are skipped by default.\n" +
        "  With a maddox.config.json in the project ({\"theme\": \"app/globals.css\", \"source\": \"app\"}), run " +
        "`maddox` with no paths; flags still override it.\n" +
        "  --suggest-tokens [--min-uses N] lists colours used N or more times (default 5) that your theme " +
        "doesn't name, as a ready-to-paste @theme block with the score you'd get by adding them.\n" +
        "  maddox check <file> [--stdin] [--format text|json] checks one file (or proposed content on stdin) " +
        "against the config's tokens. Local only: no upload, no API key."
    );
    process.exit(wantsHelp ? 0 : SCAN_ERROR);
  }

  const projectName = flagValue("--project") ?? config?.project ?? (url ? new URL(url).hostname : targetDir.split("/").pop()) ?? "unnamed-project";
  const format = flagValue("--format") ?? "text";

  // Motion tokens are an optional external JSON file (a plain object like
  // @grafikui/motion's motionTokens export) — the CLI has no opinion on any
  // one target's motion system, so this stays a vendored/passed-in file
  // per project rather than a hardcoded import.
  const motionPath = flagValue("--motion") ?? config?.motion;
  const motionTokens = motionPath
    ? (JSON.parse(readFileSync(motionPath, "utf-8")) as Record<string, unknown>)
    : {};

  const statesPath = flagValue("--states") ?? config?.states;
  const stateContract = statesPath ? loadStateContract(statesPath) : undefined;

  const tokensStudioPath = flagValue("--tokens-studio") ?? config?.tokensStudio;

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
      process.exit(SCAN_ERROR);
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
        process.exit(SCAN_ERROR);
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
    process.exit(SCAN_ERROR);
  }

  const apiKey = flagValue("--api-key") ?? process.env.MADDOX_API_KEY;
  const apiUrl = process.env.MADDOX_API_URL ?? "https://www.maddoxengine.com";

  const [result, centralRules] = await Promise.all([
    url ? auditUrl(url, groundTruth) : audit(targetDir, groundTruth, stateContract, [...(config?.exclude ?? []), ...flagValues("--exclude")]),
    apiKey ? fetchCentralRules(apiUrl, apiKey) : Promise.resolve(EMPTY_CENTRAL_RULES),
  ]);
  // Approved exceptions are dropped before anything else, so they are never
  // reported, auto-fixed, scored or uploaded.
  const { findings, exceptedCount } = applyExceptions(result.findings, centralRules.exceptions);
  if (exceptedCount > 0) {
    console.error(`\n${exceptedCount} finding${exceptedCount === 1 ? "" : "s"} skipped as approved exceptions (central rules).`);
  }
  const summary = summarize(findings, result.filesScanned);

  const applyFixesFlag = process.argv.includes("--apply-fixes");
  if (applyFixesFlag) {
    if (url) {
      console.error("\n--apply-fixes has no effect with --url: there is no local source to write to.");
    } else {
      const { applied, skipped, held } = applyFixes(targetDir, findings);
      if (applied.length > 0) {
        console.error(`\nApplied ${applied.length} fix${applied.length === 1 ? "" : "es"}:`);
        for (const fix of applied) {
          console.error(`  ${fix.file}:${fix.line}  ${fix.rawValue} → ${fix.suggestion}`);
        }
      }
      if (held.length > 0) {
        const why = { animation: "inside an animation (var() can't be animated)", gradient: "would flatten a gradient", email: "in an email template (no CSS variables)" };
        console.error(`\nHeld ${held.length} fix${held.length === 1 ? "" : "es"} for you to decide:`);
        for (const { finding, reason } of held) {
          console.error(`  ${finding.file}:${finding.line}  ${finding.rawValue} → ${finding.suggestion}  (${why[reason]})`);
        }
      }
      const motionOrStateSkipped = skipped.filter((f) => f.kind === "motion" || f.kind === "state").length;
      if (motionOrStateSkipped > 0) {
        console.error(`\n${motionOrStateSkipped} motion/state finding${motionOrStateSkipped === 1 ? "" : "s"} skipped — not auto-applied (see usage).`);
      }
    }
  }

  // Git details are only needed for an upload, so skip the git calls without a key.
  const git: GitContext = url || !apiKey ? {} : detectGitContext(targetDir);

  // Upload first so the markdown report can link to the run only if it exists.
  const uploaded = apiKey
    ? await uploadResult(
        apiUrl,
        apiKey,
        projectName,
        summary,
        process.env.GITHUB_ACTIONS ? "github_action" : "cli",
        git
      )
    : undefined;

  // --suggest-tokens [--min-uses N]: colours used often that the theme doesn't name.
  const suggestions = process.argv.includes("--suggest-tokens")
    ? suggestTokens(findings, groundTruth.tokens, { minUses: Math.max(1, Number(flagValue("--min-uses") ?? 5) || 5) })
    : undefined;

  if (format === "json") {
    console.log(suggestions ? JSON.stringify({ ...JSON.parse(toJson(summary)), suggestedTokens: suggestions }, null, 2) : toJson(summary));
  } else if (format === "markdown") {
    console.log(toMarkdown(summary, { dashboardUrl: uploaded?.runUrl, comparison: uploaded?.comparison }));
  } else {
    console.log(toText(summary));
  }
  if (suggestions && format !== "json") {
    if (suggestions.tokens.length === 0) {
      console.log("\nNo suggested tokens: no unnamed colour is used often enough.");
    } else {
      console.log(
        `\nSuggested new tokens (colours used often that your theme doesn't name). ` +
          `Adding all of them would take the score from ${suggestions.currentScore} to ${suggestions.projectedScore}. ` +
          `Names are a starting point; rename freely.\n\n${themeSnippet(suggestions.tokens)}`
      );
    }
  }

  if (!apiKey && format === "text") {
    console.log("\n💡 Tip: connect to Maddox Cloud for scan history, and see what each pull request adds or fixes compared with main: npx maddox-engine --api-key <key>");
  }

  // --fail-below on the command line wins over the workspace's central rule.
  const failBelowRaw = flagValue("--fail-below");
  let threshold = centralRules.failBelow;
  let thresholdLabel = "central rule";
  if (failBelowRaw !== undefined) {
    threshold = Number(failBelowRaw);
    thresholdLabel = "threshold";
    if (Number.isNaN(threshold)) {
      console.error(`\n--fail-below expects a number, got "${failBelowRaw}"`);
      process.exit(SCAN_ERROR);
    }
  }

  let failed = false;
  if (threshold !== null) {
    const score = healthScore(summary.counts);
    console.error(`\nHealth score: ${score} (${thresholdLabel}: ${threshold})`);
    if (score < threshold) {
      console.error(`Maddox: drift below ${thresholdLabel} — failing build (${score} < ${threshold}).`);
      failed = true;
    }
  }

  const newDrift = newDriftVerdict(centralRules, git, uploaded?.comparison);
  if (newDrift.message) console.error(`\n${newDrift.message}`);
  if (failed || newDrift.fail) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(SCAN_ERROR);
});
