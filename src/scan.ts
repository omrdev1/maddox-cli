import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { extractFromContent, type RawUsage, type ScannedFile } from "./extract.js";

// Deliberately NOT re-exporting RawUsage/ScannedFile/extractFromContent
// here — anything that needs those and must stay browser-safe (crawl.ts,
// diff.ts, or a future client component) should import them from
// ./extract.js directly, not through this file. This file's own
// node:fs/node:path imports are unconditional at module scope, so ANY
// import from scan.ts — even just for a re-exported browser-safe name —
// pulls those into a webpack client bundle and breaks it, exactly the
// bug this split exists to prevent.

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".turbo", "dist"]);
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

function walkDir(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkDir(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (SCAN_EXTENSIONS.has(ext)) out.push(join(dir, entry.name));
    }
  }
}

/**
 * Walks .ts/.tsx/.css files under `rootDir` (skipping node_modules/.next)
 * and returns each file's relative path and content. Shared by the
 * token/motion usage scan and the component state-completeness check.
 */
function readScannedFiles(rootDir: string): ScannedFile[] {
  const filePaths: string[] = [];
  walkDir(rootDir, filePaths);

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
 * Walks .ts/.tsx/.css files under `rootDir` (skipping node_modules/.next)
 * and extracts raw color/font-size/motion literals with file:line.
 * Source-level scan, not a live-fetched-HTML scan.
 */
export async function scanSource(rootDir: string): Promise<RawUsage[]> {
  const usages: RawUsage[] = [];
  for (const { file, content } of readScannedFiles(rootDir)) {
    usages.push(...extractFromContent(file, content));
  }
  return usages;
}

/**
 * Same file walk as scanSource, but returning raw file contents for the
 * component state-completeness check rather than token/motion usages.
 */
export async function scanFiles(rootDir: string): Promise<ScannedFile[]> {
  return readScannedFiles(rootDir);
}
