import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const CONFIG_FILE = "maddox.config.json";

/** A loaded maddox.config.json, with every path absolute and inside `root`. */
export interface MaddoxConfig {
  root: string;
  theme: string;
  source: string;
  motion?: string;
  states?: string;
  tokensStudio?: string;
  exclude: string[];
  project: string;
}

export class ConfigError extends Error {}

const PATH_KEYS = ["theme", "source", "motion", "states", "tokensStudio"] as const;
const KNOWN_KEYS = new Set<string>([...PATH_KEYS, "exclude", "project"]);

/** Walks up from `startDir` to the nearest config file, stopping at the repository root. */
export function findConfig(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return null; // repository root: don't read a parent project's config
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolves `path` (relative to `root`, or absolute) and confirms it sits
 * inside `root` after following symlinks. A path that doesn't exist yet is
 * checked through its nearest existing parent. Throws ConfigError otherwise.
 */
export function resolveInside(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const target = isAbsolute(path) ? resolve(path) : resolve(realRoot, path);
  let existing = target;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  const real = rest.length ? join(realpathSync(existing), ...rest) : realpathSync(existing);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new ConfigError(`"${path}" is outside the project (${realRoot}).`);
  }
  return real;
}

export function loadConfig(configPath: string): MaddoxConfig {
  const root = realpathSync(dirname(configPath));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON.`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${CONFIG_FILE} must contain a JSON object.`);
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!KNOWN_KEYS.has(key)) throw new ConfigError(`Unknown key "${key}" in ${CONFIG_FILE}. Allowed: ${[...KNOWN_KEYS].join(", ")}.`);
  }
  if (body.theme === undefined) throw new ConfigError(`"theme" is required in ${CONFIG_FILE}: the CSS file with your @theme tokens.`);

  const paths: Partial<Record<(typeof PATH_KEYS)[number], string>> = {};
  for (const key of PATH_KEYS) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) throw new ConfigError(`"${key}" must be a string path in ${CONFIG_FILE}.`);
    const resolved = resolveInside(root, value);
    if (!existsSync(resolved)) throw new ConfigError(`${key === "source" ? "source folder" : `${key} file`} not found: ${value}`);
    paths[key] = resolved;
  }

  if (body.exclude !== undefined && !(Array.isArray(body.exclude) && body.exclude.every((p) => typeof p === "string"))) {
    throw new ConfigError(`"exclude" must be a list of strings in ${CONFIG_FILE}.`);
  }
  if (body.project !== undefined && (typeof body.project !== "string" || !body.project.trim())) {
    throw new ConfigError(`"project" must be a string in ${CONFIG_FILE}.`);
  }

  return {
    root,
    theme: paths.theme!,
    source: paths.source ?? root,
    motion: paths.motion,
    states: paths.states,
    tokensStudio: paths.tokensStudio,
    exclude: (body.exclude as string[] | undefined) ?? [],
    project: (body.project as string | undefined) ?? basename(root),
  };
}
