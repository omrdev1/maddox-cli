import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { checkWith, MAX_CHECK_BYTES, prepareCheck, isCheckResult } from "./check.js";
import { parseColor } from "./color.js";
import { ConfigError, CONFIG_FILE, findConfig, loadConfig, resolveInside, type MaddoxConfig } from "./config.js";
import { checkContent } from "./core.js";
import { diffUsages } from "./diff.js";
import { loadGroundTruth, loadStateContract } from "./groundTruth.js";
import { healthScore } from "./healthScore.js";
import { attachSuggestions } from "./suggestFix.js";
import type { Finding, GroundTruth, StateContract } from "./types.js";

const DEFAULT_TOKEN_LIMIT = 150;
const MAX_TOKEN_LIMIT = 250;
const DEFAULT_FINDING_LIMIT = 50;
const MAX_FINDING_LIMIT = 100;
const MAX_SCAN_FILES = 500;
const MAX_SCAN_MS = 10_000;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".turbo", "dist"]);

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const SERVER_INSTRUCTIONS = [
  "Maddox Engine verifies source code against this project's local design tokens (colors, font sizes, spacing, motion, and component states).",
  "Before writing or editing UI styles, call get_design_tokens (or find_token for a specific value) so you use the project's real tokens up front.",
  "After writing or editing styles, call check_code on the changed file (or pass proposed content) and fix any reported drift before finishing.",
  "All Maddox MCP tools are read-only and run 100% locally with zero network calls.",
].join(" ");

interface CachedProject {
  configPath: string;
  signature: string;
  config: MaddoxConfig;
  groundTruth: GroundTruth;
  stateContract?: StateContract;
}

export interface McpServerOptions {
  rootDir?: string;
  version?: string;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function fileMtime(filePath?: string): string {
  if (!filePath) return "";
  try {
    return `${filePath}:${statSync(filePath).mtimeMs}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function classifyCssToken(name: string, value: string): "color" | "font-size" | "spacing" | "other" {
  if (parseColor(value) !== null) return "color";
  const isLength = /^-?\d+(?:\.\d+)?(?:px|rem|em)$/i.test(value.trim());
  if (!isLength) return "other";
  if (/(?:^|[-_])(text|font[-_]?size|type|leading)(?:[-_]|$)/i.test(name)) return "font-size";
  if (/(?:^|[-_])(spacing|space|gap|padding|margin)(?:[-_]|$)/i.test(name)) return "spacing";
  return "spacing";
}

function detectValueKind(value: string): "color" | "font-size" | "spacing" | "motion" {
  if (parseColor(value) !== null) return "color";
  if (/^-?\d+(?:\.\d+)?(?:px|rem|em)$/i.test(value.trim())) return "spacing";
  return "motion";
}

function formatFindingSummary(f: Finding) {
  return {
    file: f.file,
    line: f.line,
    kind: f.kind,
    value: f.rawValue,
    severity: f.severity,
    ...(f.nearestToken ? { nearestToken: f.nearestToken } : {}),
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
  };
}

function collectCandidateFiles(dir: string, out: string[], deadlineMs: number): boolean {
  if (out.length >= MAX_SCAN_FILES || Date.now() >= deadlineMs) return true;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES || Date.now() >= deadlineMs) return true;
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (collectCandidateFiles(full, out, deadlineMs)) return true;
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return false;
}

export function createMaddoxMcpServer(options: McpServerOptions = {}): Server {
  const version = options.version ?? "0.12.0";
  const fallbackRoot = resolve(options.rootDir ?? process.cwd());
  let cache: CachedProject | null = null;

  const server = new Server(
    { name: "maddox-engine", version },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  async function resolveProjectRoot(): Promise<string> {
    try {
      const clientCaps = server.getClientCapabilities();
      if (clientCaps?.roots) {
        const res = await server.listRoots();
        for (const root of res.roots ?? []) {
          if (root.uri.startsWith("file://")) {
            const p = fileURLToPath(root.uri);
            if (existsSync(p)) return resolve(p);
          }
        }
      }
    } catch {
      // Client does not support roots or timed out; fall back to --root / cwd.
    }
    return fallbackRoot;
  }

  function loadProject(startDir: string): CachedProject {
    const configPath = findConfig(startDir);
    if (!configPath) {
      throw new ConfigError(
        `No ${CONFIG_FILE} found above ${startDir}. Create one with at least {"theme": "path/to/theme.css"}.`
      );
    }

    const configSig = fileMtime(configPath);
    if (cache && cache.configPath === configPath) {
      const currentSig = [
        configSig,
        fileMtime(cache.config.theme),
        fileMtime(cache.config.tokensStudio),
        fileMtime(cache.config.motion),
        fileMtime(cache.config.states),
      ].join("|");
      if (currentSig === cache.signature) return cache;
    }

    const config = loadConfig(configPath);
    const motion = config.motion ? (JSON.parse(readFileSync(config.motion, "utf8")) as Record<string, unknown>) : {};
    const groundTruth = loadGroundTruth(config.theme, motion, config.tokensStudio);
    const stateContract = config.states ? loadStateContract(config.states) : undefined;
    const signature = [
      configSig,
      fileMtime(config.theme),
      fileMtime(config.tokensStudio),
      fileMtime(config.motion),
      fileMtime(config.states),
    ].join("|");

    cache = { configPath, signature, config, groundTruth, stateContract };
    return cache;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_design_tokens",
        description:
          "List this project's local design tokens (colors, font sizes, spacing, and motion) from maddox.config.json so you can use exact tokens before writing styles.",
        inputSchema: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["all", "color", "font-size", "spacing", "motion"],
              description: "Optional token category filter. Defaults to 'all'.",
            },
            limit: {
              type: "number",
              description: `Maximum tokens to return (default ${DEFAULT_TOKEN_LIMIT}, max ${MAX_TOKEN_LIMIT}).`,
            },
          },
          additionalProperties: false,
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      {
        name: "find_token",
        description:
          "Find whether a CSS/style value (hex/rgb/oklch color, px/rem length, or motion value) matches a project design token, or return the nearest token and suggested fix.",
        inputSchema: {
          type: "object",
          properties: {
            value: {
              type: "string",
              description: "The raw value to look up (e.g. '#e05244', '19px', '0.875rem', '0.25').",
            },
            kind: {
              type: "string",
              enum: ["color", "font-size", "spacing", "motion"],
              description: "Optional value kind. Auto-detected if omitted.",
            },
            role: {
              type: "string",
              enum: ["bg", "text", "border"],
              description: "Optional CSS role for color matching so backgrounds prefer background tokens.",
            },
          },
          required: ["value"],
          additionalProperties: false,
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      {
        name: "check_code",
        description:
          "Check a single project file (or proposed file content) for design-token drift against maddox.config.json. Read-only and local.",
        inputSchema: {
          type: "object",
          properties: {
            file: {
              type: "string",
              description: "File path relative to the project root (or absolute path inside the project).",
            },
            content: {
              type: "string",
              description: "Optional proposed file content to check before writing to disk.",
            },
            limit: {
              type: "number",
              description: `Maximum drift findings to return (default ${DEFAULT_FINDING_LIMIT}, max ${MAX_FINDING_LIMIT}).`,
            },
          },
          required: ["file"],
          additionalProperties: false,
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      {
        name: "scan_project",
        description:
          "Scan the project (or specific subdirectories/files inside it) for design-token drift and return the local health score, counts, and top findings.",
        inputSchema: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of relative file or folder paths inside the project to scope the scan.",
            },
            limit: {
              type: "number",
              description: `Maximum drift findings to return (default ${DEFAULT_FINDING_LIMIT}, max ${MAX_FINDING_LIMIT}).`,
            },
          },
          additionalProperties: false,
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;

    try {
      const rootDir = await resolveProjectRoot();

      if (name === "get_design_tokens") {
        const project = loadProject(rootDir);
        const kind = typeof args.kind === "string" ? args.kind : "all";
        const limit = clampLimit(args.limit, DEFAULT_TOKEN_LIMIT, MAX_TOKEN_LIMIT);

        const entries: { name: string; value: string | number; kind: string }[] = [];
        for (const [tokenName, tokenValue] of Object.entries(project.groundTruth.tokens)) {
          const tokenKind = classifyCssToken(tokenName, tokenValue);
          if (kind === "all" || kind === tokenKind) {
            entries.push({ name: tokenName, value: tokenValue, kind: tokenKind });
          }
        }
        if (kind === "all" || kind === "motion") {
          for (const m of project.groundTruth.motion) {
            entries.push({ name: m.path, value: m.value, kind: "motion" });
          }
        }

        const total = entries.length;
        const shown = entries.slice(0, limit);
        const truncated = Math.max(0, total - shown.length);
        const lines = shown.map((t) => `${t.name}: ${t.value} (${t.kind})`);
        if (truncated > 0) lines.push(`... and ${truncated} more tokens (filter with kind or raise limit).`);
        const text =
          total === 0
            ? `No ${kind === "all" ? "" : `${kind} `}tokens found in ${project.config.project}.`
            : `${project.config.project} (${total} token${total === 1 ? "" : "s"}):\n${lines.join("\n")}`;

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            project: project.config.project,
            kind,
            total,
            truncated,
            tokens: shown,
          },
        };
      }

      if (name === "find_token") {
        const value = typeof args.value === "string" ? args.value.trim() : "";
        if (!value) {
          return {
            isError: true,
            content: [{ type: "text", text: "Missing required parameter: value." }],
          };
        }
        const project = loadProject(rootDir);
        const kind =
          args.kind === "color" || args.kind === "font-size" || args.kind === "spacing" || args.kind === "motion"
            ? args.kind
            : detectValueKind(value);
        const role = args.role === "bg" || args.role === "text" || args.role === "border" ? args.role : undefined;

        const [finding] = diffUsages(
          [{ file: "<lookup>", line: 1, kind, rawValue: value, ...(role ? { role } : {}) }],
          project.groundTruth
        );
        if (finding) attachSuggestions([finding]);

        const tokenValue =
          finding?.nearestToken !== undefined
            ? project.groundTruth.tokens[finding.nearestToken] ??
              project.groundTruth.motion.find((m) => m.path === finding.nearestToken)?.value
            : undefined;

        const structured = {
          value,
          kind,
          severity: finding?.severity ?? "unrecognized",
          matched: finding?.severity === "match",
          ...(finding?.nearestToken ? { nearestToken: finding.nearestToken } : {}),
          ...(tokenValue !== undefined ? { nearestValue: tokenValue } : {}),
          ...(finding?.suggestion ? { suggestion: finding.suggestion } : {}),
        };

        const text =
          structured.matched && structured.nearestToken
            ? `${value} matches ${structured.nearestToken} (${tokenValue}).`
            : structured.nearestToken
              ? `${value} is ${structured.severity} (nearest: ${structured.nearestToken} = ${tokenValue}${structured.suggestion ? `; fix: ${structured.suggestion}` : ""}).`
              : `${value} does not match any ${kind} token in ${project.config.project}.`;

        return {
          content: [{ type: "text", text }],
          structuredContent: structured,
        };
      }

      if (name === "check_code") {
        const file = typeof args.file === "string" ? args.file.trim() : "";
        if (!file) {
          return {
            isError: true,
            content: [{ type: "text", text: "Missing required parameter: file." }],
          };
        }
        const content = typeof args.content === "string" ? args.content : undefined;
        const limit = clampLimit(args.limit, DEFAULT_FINDING_LIMIT, MAX_FINDING_LIMIT);

        const prepared = prepareCheck(file, rootDir);
        if (isCheckResult(prepared)) {
          const isErr = prepared.status === "error";
          const text =
            prepared.status === "error"
              ? prepared.message
              : prepared.status === "skipped"
                ? `${prepared.file}: skipped (${prepared.reason}).`
                : `${prepared.file}: no drift.`;
          return {
            ...(isErr ? { isError: true } : {}),
            content: [{ type: "text", text }],
            structuredContent: prepared as unknown as Record<string, unknown>,
          };
        }

        // Reuse cached ground truth when pointing at the same config.
        try {
          const cached = loadProject(prepared.config.root);
          if (cached.config.root === prepared.config.root) {
            prepared.tokens = { groundTruth: cached.groundTruth, stateContract: cached.stateContract };
          }
        } catch {
          // Fall back to checkWith loading tokens directly.
        }

        const result = checkWith(prepared, content);
        if (result.status === "error") {
          return {
            isError: true,
            content: [{ type: "text", text: result.message }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }
        if (result.status === "skipped") {
          return {
            content: [{ type: "text", text: `${result.file}: skipped (${result.reason}).` }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }

        const totalDrift = result.findings.length;
        const shown = result.findings.slice(0, limit).map(formatFindingSummary);
        const truncated = Math.max(0, totalDrift - shown.length);
        const textLines = shown.map((f) => {
          const nearest = f.nearestToken ? ` (nearest: ${f.nearestToken})` : "";
          const fix = f.suggestion ? `  fix: ${f.suggestion}` : "";
          return `${f.file}:${f.line}  [${f.kind}] ${f.value} -> ${f.severity}${nearest}${fix}`;
        });
        if (truncated > 0) textLines.push(`... and ${truncated} more drift findings.`);
        const text = totalDrift === 0 ? `${result.file}: no drift.` : textLines.join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            status: "checked",
            file: result.file,
            totalDrift,
            truncated,
            findings: shown,
          },
        };
      }

      if (name === "scan_project") {
        const project = loadProject(rootDir);
        const limit = clampLimit(args.limit, DEFAULT_FINDING_LIMIT, MAX_FINDING_LIMIT);
        const rawPaths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0) : [];

        const deadlineMs = Date.now() + MAX_SCAN_MS;
        const candidatePaths: string[] = [];
        let truncatedFiles = false;

        const rootsToWalk =
          rawPaths.length > 0
            ? rawPaths.map((p) => resolveInside(project.config.root, p))
            : [project.config.source];

        for (const target of rootsToWalk) {
          if (!existsSync(target) || lstatSync(target).isSymbolicLink()) continue;
          const st = statSync(target);
          if (st.isFile()) {
            if (candidatePaths.length < MAX_SCAN_FILES) candidatePaths.push(target);
            else truncatedFiles = true;
          } else if (st.isDirectory()) {
            if (collectCandidateFiles(target, candidatePaths, deadlineMs)) truncatedFiles = true;
          }
        }

        const allFindings: Finding[] = [];
        let filesScanned = 0;

        for (const fullPath of candidatePaths) {
          if (Date.now() >= deadlineMs) {
            truncatedFiles = true;
            break;
          }
          const rel = relative(project.config.source, fullPath);
          if (rel === "" || isAbsolute(rel) || rel.split(sep).includes("..")) continue;
          let st;
          try {
            st = statSync(fullPath);
          } catch {
            continue;
          }
          if (!st.isFile() || st.size > MAX_CHECK_BYTES) continue;
          let content: string;
          try {
            content = readFileSync(fullPath, "utf8");
          } catch {
            continue;
          }
          const fileFindings = checkContent(project.config.source, rel, content, project.groundTruth, {
            stateContract: project.stateContract,
            ignorePatterns: project.config.exclude,
          });
          if (!fileFindings) continue;
          filesScanned++;
          allFindings.push(...fileFindings);
        }

        const counts = {
          match: allFindings.filter((f) => f.severity === "match").length,
          nearMiss: allFindings.filter((f) => f.severity === "near-miss").length,
          unrecognized: allFindings.filter((f) => f.severity === "unrecognized").length,
          missing: allFindings.filter((f) => f.severity === "missing").length,
        };
        const score = healthScore({
          match: counts.match,
          "near-miss": counts.nearMiss,
          unrecognized: counts.unrecognized,
          missing: counts.missing,
        });
        const driftFindings = allFindings.filter((f) => f.severity !== "match");
        const shown = driftFindings.slice(0, limit).map(formatFindingSummary);
        const truncatedFindings = Math.max(0, driftFindings.length - shown.length);

        const summaryLines = [
          `${project.config.project} — local health score: ${score}/100 (${filesScanned} file${filesScanned === 1 ? "" : "s"} scanned${truncatedFiles ? ", capped" : ""})`,
          `Counts: ${counts.match} match, ${counts.nearMiss} near-miss, ${counts.unrecognized} unrecognized, ${counts.missing} missing`,
        ];
        for (const f of shown) {
          const nearest = f.nearestToken ? ` (nearest: ${f.nearestToken})` : "";
          const fix = f.suggestion ? `  fix: ${f.suggestion}` : "";
          summaryLines.push(`${f.file}:${f.line}  [${f.kind}] ${f.value} -> ${f.severity}${nearest}${fix}`);
        }
        if (truncatedFindings > 0) summaryLines.push(`... and ${truncatedFindings} more drift findings.`);

        return {
          content: [{ type: "text", text: summaryLines.join("\n") }],
          structuredContent: {
            label: "local",
            project: project.config.project,
            score,
            filesScanned,
            truncatedFiles,
            counts,
            totalDrift: driftFindings.length,
            truncatedFindings,
            findings: shown,
          },
        };
      }

      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    } catch (err) {
      const message =
        err instanceof ConfigError ? err.message : `Maddox MCP error: ${err instanceof Error ? err.message : String(err)}`;
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });

  return server;
}

export async function startMaddoxMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = createMaddoxMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
