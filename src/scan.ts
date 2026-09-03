import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export interface RawUsage {
  file: string;
  line: number;
  kind: "color" | "spacing" | "font-size" | "motion";
  rawValue: string;
}

const HEX_RE = /#([a-f0-9]{3}|[a-f0-9]{6})\b/gi;
const FONT_SIZE_RE = /font-size:\s*([\d.]+(?:px|rem|em))/gi;
const MOTION_DURATION_RE = /duration:\s*([\d.]+)/gi;
const MOTION_EASE_RE = /ease:\s*['"]([\w-]+)['"]/gi;

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/**
 * Extracts raw color/font-size/motion literals from a single blob of
 * content. Exported directly (not just via scanSource's filesystem walk)
 * so callers with in-memory content — e.g. fetched HTML/CSS from a public
 * URL, with no local checkout — can run the same extraction.
 */
export function extractFromContent(file: string, content: string): RawUsage[] {
  const usages: RawUsage[] = [];

  for (const re of [HEX_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      usages.push({
        file,
        line: lineNumberAt(content, m.index),
        kind: "color",
        rawValue: m[0].toLowerCase(),
      });
    }
  }

  FONT_SIZE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FONT_SIZE_RE.exec(content)) !== null) {
    usages.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "font-size",
      rawValue: m[1],
    });
  }

  MOTION_DURATION_RE.lastIndex = 0;
  while ((m = MOTION_DURATION_RE.exec(content)) !== null) {
    usages.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "motion",
      rawValue: m[1],
    });
  }

  MOTION_EASE_RE.lastIndex = 0;
  while ((m = MOTION_EASE_RE.exec(content)) !== null) {
    usages.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "motion",
      rawValue: m[1],
    });
  }

  return usages;
}

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

export interface ScannedFile {
  file: string; // relative to rootDir
  content: string;
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
