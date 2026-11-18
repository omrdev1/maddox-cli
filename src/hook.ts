import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { checkWith, isCheckResult, MAX_CHECK_BYTES, prepareCheck, type CheckResult } from "./check.js";
import { findConfig } from "./config.js";
import { parseAlpha, parseColor } from "./color.js";
import type { Finding } from "./types.js";

// Agent and commit hooks over `maddox check`. Local only: no network, no API
// key, and nothing here writes to the project. See
// docs/plans/2026-11-17-agent-native-layer.md (Phase 1).

/** Runs git and returns stdout, or null when the command fails (not a repo, path not in HEAD, and so on). */
export type GitRunner = (args: string[], cwd: string) => string | null;

export const runGit: GitRunner = (args, cwd) => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_CHECK_BYTES * 2,
      timeout: 5000,
    });
  } catch {
    return null;
  }
};

/** Findings shown to an agent or at commit time: drift only, never matches or whole-component state findings. */
function driftOnly(result: CheckResult): Finding[] {
  if (result.status !== "checked") return [];
  return result.findings.filter((f) => f.kind !== "state" && (f.severity === "near-miss" || f.severity === "unrecognized"));
}

function normalisedValue(f: Finding): string {
  if (f.kind === "color") {
    const rgb = parseColor(f.rawValue);
    if (rgb) return `${rgb.join(",")},${Math.round(parseAlpha(f.rawValue) * 1000) / 1000}`;
  }
  return f.rawValue.toLowerCase().replace(/\s+/g, "");
}

/** What makes two findings "the same drift": kind, value (case and colour format aside) and nearest token. */
export function driftKey(f: Finding): string {
  return `${f.kind}|${normalisedValue(f)}|${f.nearestToken ?? ""}`;
}

/**
 * The drift `after` adds over `before`, counted per driftKey, so moving a line
 * or touching a file with old drift reports nothing, while one more copy of an
 * existing value is reported once. When a key gains copies, those on
 * `preferLines` (the lines just written) are reported first.
 */
export function newDrift(before: Finding[], after: Finding[], preferLines?: Set<number>): Finding[] {
  const beforeCounts = new Map<string, number>();
  for (const f of before) beforeCounts.set(driftKey(f), (beforeCounts.get(driftKey(f)) ?? 0) + 1);

  const afterByKey = new Map<string, Finding[]>();
  for (const f of after) {
    const key = driftKey(f);
    const list = afterByKey.get(key) ?? [];
    list.push(f);
    afterByKey.set(key, list);
  }

  const out: Finding[] = [];
  for (const [key, list] of afterByKey) {
    const extra = list.length - (beforeCounts.get(key) ?? 0);
    if (extra <= 0) continue;
    const ordered = preferLines
      ? [...list.filter((f) => preferLines.has(f.line)), ...list.filter((f) => !preferLines.has(f.line))]
      : list;
    out.push(...ordered.slice(0, extra));
  }
  return out.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

function spannedLines(text: string, starts: number[], length: number, into = new Set<number>()): Set<number> {
  const newlines = (s: string) => s.split("\n").length - 1;
  for (const start of starts) {
    const first = lineAt(text, start);
    const last = first + newlines(text.slice(start, start + length));
    for (let l = first; l <= last; l++) into.add(l);
  }
  return into;
}

interface EditInput {
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

/**
 * How an Edit changed the file: the text before it, rebuilt by reversing the
 * replacement, and the lines the new text now spans. `before` is null when the
 * reversal is ambiguous (the new text appears more than once), in which case
 * only findings on the spanned lines are reported.
 */
export function reverseEdits(after: string, edits: EditInput[]): { before: string | null; lines: Set<number> } {
  const lines = new Set<number>();
  let before: string | null = after;
  // Undo the last edit first, so each reversal sees the text it produced.
  for (const edit of [...edits].reverse()) {
    const oldString = typeof edit.old_string === "string" ? edit.old_string : "";
    const newString = typeof edit.new_string === "string" ? edit.new_string : "";
    if (!newString) continue; // a deletion adds no drift
    const found = occurrences(after, newString);
    spannedLines(after, found, newString.length, lines);
    if (before === null) continue;
    if (edit.replace_all === true) {
      before = before.split(newString).join(oldString);
    } else {
      const inBefore = occurrences(before, newString);
      before = inBefore.length === 1 ? before.slice(0, inBefore[0]) + oldString + before.slice(inBefore[0] + newString.length) : null;
    }
  }
  return { before, lines };
}

// ---------- session memory: the same finding is not repeated in a session ----------

const MAX_REMEMBERED = 2000;

function sessionFile(stateDir: string, sessionId: string): string {
  return join(stateDir, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`);
}

function defaultStateDir(): string {
  let user = "user";
  try {
    user = userInfo().username.replace(/[^\w.-]/g, "_") || user;
  } catch {
    // keep the fallback name
  }
  return join(tmpdir(), `maddox-hook-${user}`);
}

function loadSeen(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function saveSeen(path: string, keys: string[]) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(keys.slice(-MAX_REMEMBERED)), { mode: 0o600 });
  } catch {
    // Memory is a nicety; a read-only temp folder only means repeats.
  }
}

// ---------- messages ----------

const MAX_LISTED = 20;
const MAX_MESSAGE_CHARS = 9000; // Claude Code caps hook text at 10,000 characters

function describe(f: Finding): string {
  const near = f.nearestToken ? `, nearest token ${f.nearestToken}` : ", no close token";
  const fix = f.suggestion ? `; suggested fix: ${f.suggestion}` : "";
  return `line ${f.line}: ${f.rawValue} (${f.kind}, ${f.severity}${near})${fix}`;
}

export function agentMessage(file: string, findings: Finding[]): string {
  const count = findings.length;
  const head = `Maddox design-system check: ${file} now has ${count} hardcoded value${count === 1 ? "" : "s"} that ${count === 1 ? "is" : "are"} not one of the project's tokens.`;
  const listed = findings.slice(0, MAX_LISTED).map((f) => `- ${describe(f)}`);
  if (count > MAX_LISTED) listed.push(`- and ${count - MAX_LISTED} more`);
  const tail =
    "The project's tokens are defined in the theme file named in maddox.config.json. A value that is deliberate can stay, marked with a `maddox-ignore` comment on its line or `maddox-ignore-next-line` on the line above.";
  let text = [head, ...listed, tail].join("\n");
  if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}\n(list truncated)`;
  return text;
}

// ---------- Claude Code PostToolUse ----------

export interface ClaudeHookOptions {
  insist?: boolean;
  stateDir?: string;
  git?: GitRunner;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * Handles one Claude Code PostToolUse payload (the JSON Claude Code writes to
 * the hook's stdin). Returns the JSON object to print, or null to stay quiet:
 * any tool other than Edit or Write, a file Maddox doesn't scan, no config, no
 * new drift, or anything unexpected.
 */
export function claudeCodeHook(stdin: string, options: ClaudeHookOptions = {}): Record<string, unknown> | null {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdin);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.hook_event_name !== undefined && payload.hook_event_name !== "PostToolUse") return null;
  if (typeof payload.tool_name !== "string" || !EDIT_TOOLS.has(payload.tool_name)) return null;
  const input = payload.tool_input;
  if (!input || typeof input !== "object") return null;
  const toolInput = input as Record<string, unknown>;
  const filePath = toolInput.file_path;
  if (typeof filePath !== "string" || !filePath) return null;
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();

  // Never guess at someone else's project: no config above the file, no hook.
  const ctx = prepareCheck(filePath, cwd);
  if (isCheckResult(ctx)) return null;

  // The file as it is now, read from disk rather than from tool_response.
  const afterResult = checkWith(ctx);
  const after = driftOnly(afterResult);
  if (after.length === 0) return null;

  let findings: Finding[];
  if (payload.tool_name === "Write") {
    // An overwrite is compared with the last commit; a new or untracked file is reported in full.
    const git = options.git ?? runGit;
    const committed = git(["show", `HEAD:./${basename(ctx.path)}`], dirname(ctx.path));
    findings = committed === null ? after : newDrift(driftOnly(checkWith(ctx, committed)), after);
  } else {
    const edits = payload.tool_name === "MultiEdit" ? (Array.isArray(toolInput.edits) ? (toolInput.edits as EditInput[]) : []) : [toolInput as EditInput];
    let current: string;
    try {
      current = readFileSync(ctx.path, "utf8");
    } catch {
      return null;
    }
    const { before, lines } = reverseEdits(current, edits);
    if (lines.size === 0) return null;
    findings = before === null ? after.filter((f) => lines.has(f.line)) : newDrift(driftOnly(checkWith(ctx, before)), after, lines);
  }
  if (findings.length === 0) return null;

  // Leave out what this session has already been told about this file.
  const relFile = afterResult.status === "checked" ? afterResult.file : ctx.file;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (sessionId) {
    const path = sessionFile(options.stateDir ?? defaultStateDir(), sessionId);
    const seen = loadSeen(path);
    const seenSet = new Set(seen);
    const fresh = findings.filter((f) => !seenSet.has(`${relFile}|${driftKey(f)}`));
    if (fresh.length === 0) return null;
    for (const f of fresh) seen.push(`${relFile}|${driftKey(f)}`);
    saveSeen(path, seen);
    findings = fresh;
  }

  const message = agentMessage(relFile, findings);
  if (options.insist) return { decision: "block", reason: message };
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } };
}

// ---------- git pre-commit ----------

export interface PreCommitResult {
  exitCode: 0 | 1;
  output: string; // for stderr
}

export interface PreCommitOptions {
  cwd: string;
  all?: boolean; // every drift in staged files, not only what the commit adds
  git?: GitRunner;
}

const MAX_STAGED_FILES = 2000;

function formatLine(file: string, f: Finding): string {
  const near = f.nearestToken ? ` (nearest: ${f.nearestToken})` : "";
  const fix = f.suggestion ? `  fix: ${f.suggestion}` : "";
  return `  ${file}:${f.line}  [${f.kind}] ${f.rawValue} → ${f.severity}${near}${fix}`;
}

/**
 * Checks the staged version of each staged file. By default only drift the
 * commit adds over HEAD blocks it, so a commit that touches a file with old
 * drift isn't held up by it. Files without a maddox.config.json above them are
 * skipped. A file that can't be checked is reported but doesn't block.
 */
export function preCommit(options: PreCommitOptions): PreCommitResult {
  const git = options.git ?? runGit;
  const top = git(["rev-parse", "--show-toplevel"], options.cwd)?.trim();
  if (!top) return { exitCode: 0, output: "" };

  const staged = (git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], top) ?? "")
    .split("\0")
    .filter(Boolean)
    .slice(0, MAX_STAGED_FILES);

  const blocking: string[] = [];
  const warnings: string[] = [];
  let count = 0;
  for (const name of staged) {
    const abs = join(top, name);
    if (!findConfig(dirname(abs))) continue;
    const ctx = prepareCheck(abs, top);
    if (isCheckResult(ctx)) {
      if (ctx.status === "error") warnings.push(`  ${name}: ${ctx.message}`);
      continue;
    }
    const stagedText = git(["show", `:${name}`], top);
    if (stagedText === null) continue;
    const afterResult = checkWith(ctx, stagedText);
    if (afterResult.status === "error") {
      warnings.push(`  ${name}: ${afterResult.message}`);
      continue;
    }
    const after = driftOnly(afterResult);
    if (after.length === 0) continue;
    let findings = after;
    if (!options.all) {
      const headText = git(["show", `HEAD:${name}`], top);
      if (headText !== null) findings = newDrift(driftOnly(checkWith(ctx, headText)), after);
    }
    const file = afterResult.status === "checked" ? afterResult.file : name;
    for (const f of findings) blocking.push(formatLine(file, f));
    count += findings.length;
  }

  const parts: string[] = [];
  if (warnings.length) parts.push("Maddox could not check some staged files (not blocking):", ...warnings);
  if (count > 0) {
    parts.push(
      `Maddox: this commit adds ${count} hardcoded value${count === 1 ? "" : "s"} that ${count === 1 ? "is" : "are"} not one of the project's tokens:`,
      ...blocking,
      "Use the token, or mark a deliberate value with a maddox-ignore comment, then stage and commit again. To commit anyway: git commit --no-verify"
    );
  }
  return { exitCode: count > 0 ? 1 : 0, output: parts.join("\n") };
}
