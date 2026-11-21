import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CONFIG_FILE, resolveInside } from "./config.js";
import { hasComparableTokens, parseThemeCss } from "./groundTruth.js";

const COMMON_THEME_PATHS = [
  "src/app/globals.css",
  "app/globals.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/index.css",
  "src/globals.css",
  "apps/web/app/globals.css",
  "apps/dashboard/app/globals.css",
  "theme.css",
];

const COMMON_SOURCE_DIRS = ["src", "app", "apps/dashboard", "apps/web"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".turbo", "dist", ".ua"]);

const RULES_MARKER = "<!-- maddox-rules -->";
const RULES_SNIPPET = `${RULES_MARKER}
## Design tokens (Maddox)
- Before writing or editing UI styles, call the Maddox MCP \`get_design_tokens\` (or \`find_token\`) tool so you use this project's real design tokens instead of hardcoded hex colors or arbitrary pixel values.
- After editing UI files, fix any token drift reported by the Maddox hook or \`check_code\` before finishing your turn.
`;

export interface InitOptions {
  cwd: string;
  dryRun?: boolean;
  yes?: boolean;
  theme?: string;
  source?: string;
  claudeSettings?: "local" | "shared" | "skip";
  mcp?: boolean;
  rules?: "claude" | "agents" | "cursor" | "skip";
}

export interface PlannedAction {
  file: string;
  kind: "create" | "update" | "skip";
  summary: string;
  content?: string;
}

export interface InitResult {
  root: string;
  theme: string | null;
  source: string;
  dryRun: boolean;
  actions: PlannedAction[];
}

function findCssWithTokens(root: string): string | null {
  for (const rel of COMMON_THEME_PATHS) {
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    try {
      const tokens = parseThemeCss(readFileSync(full, "utf8"));
      if (hasComparableTokens(tokens)) return rel;
    } catch {
      // ignore unreadable file
    }
  }

  // Fallback: shallow walk (depth 3) for any .css file with usable tokens
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && current.depth < 3) {
          queue.push({ dir: full, depth: current.depth + 1 });
        }
      } else if (entry.isFile() && entry.name.endsWith(".css")) {
        try {
          const tokens = parseThemeCss(readFileSync(full, "utf8"));
          if (hasComparableTokens(tokens)) {
            return relative(root, full).replace(/\\/g, "/");
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return null;
}

function detectSourceDir(root: string, themeRel: string | null): string {
  if (themeRel) {
    for (const candidate of COMMON_SOURCE_DIRS) {
      if (themeRel.startsWith(`${candidate}/`) && existsSync(join(root, candidate))) {
        return candidate;
      }
    }
  }
  for (const candidate of COMMON_SOURCE_DIRS) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  return ".";
}

function hasLocalBinary(root: string): boolean {
  if (existsSync(join(root, "node_modules", ".bin", "maddox"))) return true;
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.["maddox-engine"] || pkg.devDependencies?.["maddox-engine"]);
  } catch {
    return false;
  }
}

function planConfigFile(root: string, themeRel: string, sourceRel: string): PlannedAction {
  const full = join(root, CONFIG_FILE);
  if (existsSync(full)) {
    return {
      file: CONFIG_FILE,
      kind: "skip",
      summary: "already exists (left unchanged)",
    };
  }
  const content =
    JSON.stringify(
      {
        project: basename(root),
        theme: themeRel,
        source: sourceRel,
      },
      null,
      2
    ) + "\n";
  return {
    file: CONFIG_FILE,
    kind: "create",
    summary: `theme="${themeRel}", source="${sourceRel}"`,
    content,
  };
}

function planClaudeHook(root: string, mode: "local" | "shared", localBin: boolean): PlannedAction {
  const rel = mode === "shared" ? ".claude/settings.json" : ".claude/settings.local.json";
  const full = join(root, rel);
  const command = localBin ? "./node_modules/.bin/maddox hook claude-code" : "npx -y maddox-engine hook claude-code";

  let existing: Record<string, unknown> = {};
  if (existsSync(full)) {
    try {
      const parsed = JSON.parse(readFileSync(full, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      } else {
        return { file: rel, kind: "skip", summary: "existing file is not a JSON object (left unchanged)" };
      }
    } catch {
      return { file: rel, kind: "skip", summary: "existing file is not valid JSON (left unchanged)" };
    }
  }

  const hooks = (existing.hooks && typeof existing.hooks === "object" && !Array.isArray(existing.hooks)
    ? { ...(existing.hooks as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  const postToolUse = Array.isArray(hooks.PostToolUse) ? [...(hooks.PostToolUse as unknown[])] : [];

  const alreadyWired = JSON.stringify(postToolUse).includes("hook claude-code");
  if (alreadyWired) {
    return { file: rel, kind: "skip", summary: "Maddox PostToolUse hook already configured" };
  }

  postToolUse.push({
    matcher: "Edit|Write|MultiEdit",
    hooks: [{ type: "command", command }],
  });
  hooks.PostToolUse = postToolUse;

  const updated = { ...existing, hooks };
  return {
    file: rel,
    kind: existsSync(full) ? "update" : "create",
    summary: `add Claude Code PostToolUse hook (${command})`,
    content: JSON.stringify(updated, null, 2) + "\n",
  };
}

function planMcpConfig(root: string, localBin: boolean): PlannedAction {
  const rel = ".mcp.json";
  const full = join(root, rel);
  const serverEntry = localBin
    ? { command: "./node_modules/.bin/maddox", args: ["mcp"] }
    : { command: "npx", args: ["-y", "maddox-engine", "mcp"] };

  let existing: Record<string, unknown> = {};
  if (existsSync(full)) {
    try {
      const parsed = JSON.parse(readFileSync(full, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      } else {
        return { file: rel, kind: "skip", summary: "existing file is not a JSON object (left unchanged)" };
      }
    } catch {
      return { file: rel, kind: "skip", summary: "existing file is not valid JSON (left unchanged)" };
    }
  }

  const mcpServers = (existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)
    ? { ...(existing.mcpServers as Record<string, unknown>) }
    : {}) as Record<string, unknown>;

  if (mcpServers.maddox !== undefined) {
    return { file: rel, kind: "skip", summary: "maddox MCP server already configured" };
  }

  mcpServers.maddox = serverEntry;
  const updated = { ...existing, mcpServers };
  return {
    file: rel,
    kind: existsSync(full) ? "update" : "create",
    summary: `add maddox MCP server (${serverEntry.command} ${serverEntry.args.join(" ")})`,
    content: JSON.stringify(updated, null, 2) + "\n",
  };
}

function planRulesFile(root: string, target: "claude" | "agents" | "cursor"): PlannedAction {
  const rel = target === "claude" ? "CLAUDE.md" : target === "agents" ? "AGENTS.md" : ".cursor/rules/maddox.mdc";
  const full = join(root, rel);
  if (existsSync(full)) {
    const current = readFileSync(full, "utf8");
    if (current.includes(RULES_MARKER)) {
      return { file: rel, kind: "skip", summary: "Maddox rules snippet already present" };
    }
    const separator = current.endsWith("\n") ? "\n" : "\n\n";
    return {
      file: rel,
      kind: "update",
      summary: "append short Maddox design-token rules snippet",
      content: `${current}${separator}${RULES_SNIPPET}`,
    };
  }
  return {
    file: rel,
    kind: "create",
    summary: "create with short Maddox design-token rules snippet",
    content: RULES_SNIPPET,
  };
}

function detectDefaultRulesTarget(root: string): "claude" | "agents" | "cursor" {
  if (existsSync(join(root, "CLAUDE.md"))) return "claude";
  if (existsSync(join(root, "AGENTS.md"))) return "agents";
  if (existsSync(join(root, ".cursor"))) return "cursor";
  return "claude";
}

export function planInit(options: InitOptions): InitResult {
  const root = resolve(options.cwd);
  const theme = options.theme
    ? relative(root, resolveInside(root, options.theme)).replace(/\\/g, "/")
    : findCssWithTokens(root);
  const source = options.source
    ? relative(root, resolveInside(root, options.source)).replace(/\\/g, "/") || "."
    : detectSourceDir(root, theme);

  const actions: PlannedAction[] = [];
  if (!theme) {
    return { root, theme: null, source, dryRun: Boolean(options.dryRun), actions };
  }

  const localBin = hasLocalBinary(root);
  actions.push(planConfigFile(root, theme, source));

  const claudeMode = options.claudeSettings ?? "local";
  if (claudeMode !== "skip") {
    actions.push(planClaudeHook(root, claudeMode, localBin));
  }

  if (options.mcp !== false) {
    actions.push(planMcpConfig(root, localBin));
  }

  const rulesMode = options.rules ?? detectDefaultRulesTarget(root);
  if (rulesMode !== "skip") {
    actions.push(planRulesFile(root, rulesMode));
  }

  return { root, theme, source, dryRun: Boolean(options.dryRun), actions };
}

export function applyInit(result: InitResult): void {
  if (result.dryRun) return;
  for (const action of result.actions) {
    if (action.kind === "skip" || action.content === undefined) continue;
    const full = resolveInside(result.root, action.file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, action.content, "utf8");
  }
}

export function formatInitPlan(result: InitResult): string {
  if (!result.theme) {
    return (
      `Could not find a CSS file with @theme or :root design tokens in ${result.root}.\n` +
      `Pass one explicitly: maddox init --theme path/to/globals.css`
    );
  }
  const header = result.dryRun ? "Maddox init (dry run — no files written):" : "Maddox init:";
  const lines = [header];
  for (const a of result.actions) {
    const tag = a.kind === "create" ? "[create]" : a.kind === "update" ? "[update]" : "[skip]  ";
    lines.push(`  ${tag} ${a.file} — ${a.summary}`);
  }
  return lines.join("\n");
}

export async function runInitInteractive(options: InitOptions): Promise<InitResult> {
  const result = planInit(options);
  if (!result.theme || result.dryRun || options.yes || !input.isTTY) {
    if (result.theme && !result.dryRun) applyInit(result);
    return result;
  }

  const rl = createInterface({ input, output });
  try {
    output.write(`${formatInitPlan(result)}\n\n`);
    const kept: PlannedAction[] = [];
    for (const action of result.actions) {
      if (action.kind === "skip") {
        kept.push(action);
        continue;
      }
      const answer = (await rl.question(`Apply [${action.kind}] ${action.file}? (Y/n) `)).trim().toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        kept.push(action);
      } else {
        kept.push({ file: action.file, kind: "skip", summary: "skipped by user" });
      }
    }
    const finalResult: InitResult = { ...result, actions: kept };
    applyInit(finalResult);
    return finalResult;
  } finally {
    rl.close();
  }
}
