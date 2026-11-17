import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { extractFromContent, type RawUsage, type ScannedFile } from "./extract.js";
import { createIgnoreMatcher, loadIgnoreFile, type IgnoreMatcher } from "./ignore.js";

// Deliberately NOT re-exporting RawUsage/ScannedFile/extractFromContent
// here — anything that needs those and must stay browser-safe (crawl.ts,
// diff.ts, or a future client component) should import them from
// ./extract.js directly, not through this file. This file's own
// node:fs/node:path imports are unconditional at module scope, so ANY
// import from scan.ts — even just for a re-exported browser-safe name —
// pulls those into a webpack client bundle and breaks it, exactly the
// bug this split exists to prevent.

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".turbo", "dist"]);
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".css"]);
// Tests, specs, Storybook files and mocks hold demo and fixture values, not
// the app's own styling, so scanning them only adds false findings.
// A Tailwind config defines tokens rather than using them, so it is skipped too.
const DEFAULT_IGNORE_PATTERNS = ["tailwind.config.*", "*.test.*", "*.spec.*", "*.story.*", "*.stories.*", "__tests__", "__mocks__"];

function walkDir(dir: string, rootDir: string, ignore: IgnoreMatcher, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (ignore.isIgnored(relative(rootDir, fullPath))) continue;
      walkDir(fullPath, rootDir, ignore, out);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      const fullPath = join(dir, entry.name);
      if (ignore.isIgnored(relative(rootDir, fullPath))) continue;
      out.push(fullPath);
    }
  }
}

/**
 * Whether a full scan of `rootDir` would include `relativePath`: same
 * extensions, skipped folders, default ignores, `.maddoxignore` and extra
 * patterns, applied to every parent folder as the walk does. Used by
 * single-file checks so they never report on a file a scan would skip.
 */
export function isScannable(rootDir: string, relativePath: string, extraIgnorePatterns: string[] = []): boolean {
  const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.length === 0 || segments.includes("..")) return false;
  const name = segments[segments.length - 1];
  if (!SCAN_EXTENSIONS.has(name.slice(name.lastIndexOf(".")))) return false;
  const ignore = createIgnoreMatcher([...DEFAULT_IGNORE_PATTERNS, ...loadIgnoreFile(rootDir), ...extraIgnorePatterns]);
  for (let i = 1; i <= segments.length; i++) {
    if (i < segments.length && SKIP_DIRS.has(segments[i - 1])) return false;
    if (ignore.isIgnored(segments.slice(0, i).join("/"))) return false;
  }
  return true;
}

/**
 * Walks .ts/.tsx/.js/.jsx/.css files under `rootDir` (skipping node_modules/.next,
 * test and story files, and anything matched by `.maddoxignore` or `extraIgnorePatterns`) and
 * returns each file's relative path and content. Shared by the
 * token/motion usage scan and the component state-completeness check.
 */
function readScannedFiles(rootDir: string, extraIgnorePatterns: string[] = []): ScannedFile[] {
  const ignore = createIgnoreMatcher([...DEFAULT_IGNORE_PATTERNS, ...loadIgnoreFile(rootDir), ...extraIgnorePatterns]);
  const filePaths: string[] = [];
  walkDir(rootDir, rootDir, ignore, filePaths);

  const files: ScannedFile[] = [];
  for (const fullPath of filePaths) {
    try {
      files.push({ file: relative(rootDir, fullPath), content: readFileSync(fullPath, "utf-8") });
    } catch {
      // unreadable file, skip
    }
  }
  return files;
}

/**
 * Walks .ts/.tsx/.js/.jsx/.css files under `rootDir` (skipping node_modules/.next
 * and any `.maddoxignore`/`extraIgnorePatterns` match) and extracts raw
 * color/font-size/motion literals with file:line. Source-level scan, not
 * a live-fetched-HTML scan.
 */
export async function scanSource(rootDir: string, extraIgnorePatterns: string[] = []): Promise<RawUsage[]> {
  const usages: RawUsage[] = [];
  for (const { file, content } of readScannedFiles(rootDir, extraIgnorePatterns)) {
    usages.push(...extractFromContent(file, content));
  }
  return usages;
}

/**
 * Same file walk as scanSource, but returning raw file contents for the
 * component state-completeness check rather than token/motion usages.
 */
export async function scanFiles(rootDir: string, extraIgnorePatterns: string[] = []): Promise<ScannedFile[]> {
  return readScannedFiles(rootDir, extraIgnorePatterns);
}
