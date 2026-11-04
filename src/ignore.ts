import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Deliberately hand-rolled rather than pulling in a glob dependency —
// the package has none today (see package.json), and the pattern
// vocabulary this needs is small: `*` (any run of non-slash chars),
// `**` (any run of chars including slashes), and plain substrings. Good
// enough for excluding a file, a directory, or an extension; not a
// general-purpose .gitignore implementation.
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

export interface IgnoreMatcher {
  isIgnored(relativeFilePath: string): boolean;
}

/**
 * Builds a matcher from glob patterns (gitignore-style: `node_modules`,
 * `**\/*.generated.ts`, `api/webhooks/**`). A pattern with no `/` is also
 * matched against every path segment, so a bare `fixtures` excludes any
 * directory or file named exactly that at any depth, matching how
 * .gitignore itself treats slash-free patterns.
 */
export function createIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  const cleaned = patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"));

  const regexes = cleaned.map((p) => ({
    full: globToRegExp(p),
    segment: p.includes("/") ? null : globToRegExp(p),
  }));

  return {
    isIgnored(relativeFilePath: string): boolean {
      const normalized = relativeFilePath.replace(/\\/g, "/");
      const segments = normalized.split("/");
      return regexes.some(({ full, segment }) => {
        if (full.test(normalized)) return true;
        if (segment) return segments.some((s) => segment.test(s));
        return false;
      });
    },
  };
}

/**
 * Reads `<rootDir>/.maddoxignore` (one glob pattern per line, `#` comments
 * ignored) if present. Returns an empty pattern list — not an error — when
 * the file doesn't exist, since exclusions are opt-in.
 */
export function loadIgnoreFile(rootDir: string): string[] {
  const path = join(rootDir, ".maddoxignore");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n");
}
