import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { checkContent } from "./core.js";
import { loadGroundTruth, loadStateContract } from "./groundTruth.js";
import { ConfigError, CONFIG_FILE, findConfig, loadConfig, resolveInside } from "./config.js";
import type { Finding } from "./types.js";

/** Larger files are refused: real source files are far smaller, and the extractor's regexes shouldn't run on megabytes of minified text. */
export const MAX_CHECK_BYTES = 1_000_000;

export type CheckResult =
  | { status: "checked"; file: string; findings: Finding[] } // drift only, no matches
  | { status: "skipped"; file: string; reason: string }
  | { status: "error"; message: string };

/**
 * Checks one file (or proposed content for it) against the project's tokens,
 * using maddox.config.json found by walking up from the file. Local only:
 * no network and no API key.
 */
export function runCheck(input: { file: string; content?: string; cwd: string }): CheckResult {
  try {
    const target = resolve(input.cwd, input.file);
    const configPath = findConfig(dirname(target)) ?? findConfig(input.cwd);
    if (!configPath) {
      return { status: "error", message: `No ${CONFIG_FILE} found above ${input.file}. Create one with at least {"theme": "path/to/theme.css"}.` };
    }
    const config = loadConfig(configPath);
    // A full scan skips symlinked files, so a single-file check does too.
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      return { status: "skipped", file: input.file, reason: "a symlink, which a full scan skips" };
    }
    const path = resolveInside(config.root, target);

    let content = input.content;
    if (content === undefined) {
      if (!existsSync(path) || !statSync(path).isFile()) return { status: "error", message: `File not found: ${input.file}` };
      if (statSync(path).size > MAX_CHECK_BYTES) return { status: "error", message: `${input.file} is too large to check (over 1 MB).` };
      content = readFileSync(path, "utf8");
    }
    if (Buffer.byteLength(content) > MAX_CHECK_BYTES) return { status: "error", message: `${input.file} is too large to check (over 1 MB).` };

    const rel = relative(config.source, path);
    if (rel === "" || isAbsolute(rel) || rel.split(sep).includes("..")) {
      return { status: "skipped", file: relative(config.root, path), reason: "outside the source folder in maddox.config.json" };
    }

    const motion = config.motion ? (JSON.parse(readFileSync(config.motion, "utf8")) as Record<string, unknown>) : {};
    const groundTruth = loadGroundTruth(config.theme, motion, config.tokensStudio);
    const stateContract = config.states ? loadStateContract(config.states) : undefined;
    const findings = checkContent(config.source, rel, content, groundTruth, { stateContract, ignorePatterns: config.exclude });
    if (!findings) return { status: "skipped", file: rel, reason: "not a file Maddox scans (extension, test or story file, or ignored)" };
    return { status: "checked", file: rel, findings: findings.filter((f) => f.severity !== "match") };
  } catch (err) {
    if (err instanceof ConfigError) return { status: "error", message: err.message };
    return { status: "error", message: `Could not check ${input.file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function checkText(result: CheckResult): string {
  if (result.status === "error") return result.message;
  if (result.status === "skipped") return `${result.file}: skipped (${result.reason}).`;
  if (result.findings.length === 0) return `${result.file}: no drift.`;
  return result.findings
    .map((f) => {
      const nearest = f.nearestToken ? ` (nearest: ${f.nearestToken})` : "";
      const fix = f.suggestion ? `  fix: ${f.suggestion}` : "";
      return `${result.file}:${f.line}  [${f.kind}] ${f.rawValue} → ${f.severity}${nearest}${fix}`;
    })
    .join("\n");
}
