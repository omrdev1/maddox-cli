export * from "./types.js";
export * from "./color.js";
export * from "./extract.js";
export * from "./groundTruth.js";
export * from "./tokensStudio.js";
export * from "./figmaVariables.js";
export * from "./scan.js";
export * from "./ignore.js";
export * from "./crawl.js";
export * from "./diff.js";
export * from "./stateCheck.js";
export * from "./healthScore.js";
export * from "./suggestFix.js";
export * from "./applyFixes.js";
export * from "./routeMap.js";
export * from "./centralRules.js";
export * from "./suggestTokens.js";
export * from "./tokenRoles.js";

import { scanSource, scanFiles, isScannable } from "./scan.js";
import { extractFromContent } from "./extract.js";
import { crawlUrl } from "./crawl.js";
import { diffUsages } from "./diff.js";
import { checkStates } from "./stateCheck.js";
import { attachSuggestions } from "./suggestFix.js";
import type { Finding, GroundTruth, ScanResult, StateContract } from "./types.js";

export async function audit(
  rootDir: string,
  groundTruth: GroundTruth,
  stateContract?: StateContract,
  ignorePatterns: string[] = []
): Promise<ScanResult> {
  const usages = await scanSource(rootDir, ignorePatterns);
  const findings = diffUsages(usages, groundTruth);
  const scannedFiles = new Set(usages.map((u) => u.file));

  if (stateContract) {
    const files = await scanFiles(rootDir, ignorePatterns);
    findings.push(...checkStates(files, stateContract));
    for (const f of files) scannedFiles.add(f.file);
  }

  attachSuggestions(findings);

  return { findings, filesScanned: scannedFiles.size };
}

/**
 * The production-aware counterpart to audit(): fetches a live page (plus
 * its same-origin stylesheets) instead of walking local source files, and
 * diffs what's actually shipped against the same ground truth. No state
 * contract here — component-state completeness is a source-code question
 * (is the state referenced anywhere in this file's source), which has no
 * equivalent for a fetched, already-rendered page.
 */
export async function auditUrl(pageUrl: string, groundTruth: GroundTruth): Promise<ScanResult> {
  const { usages, sourcesScanned } = await crawlUrl(pageUrl);
  const findings = diffUsages(usages, groundTruth);
  attachSuggestions(findings);
  return { findings, filesScanned: sourcesScanned.length };
}

/**
 * Checks one file's text (on disk or proposed) exactly as audit() would check
 * that file within `rootDir`. Returns null when a scan would skip the file
 * (unsupported extension, test or story file, ignored path).
 */
export function checkContent(
  rootDir: string,
  relativePath: string,
  content: string,
  groundTruth: GroundTruth,
  options: { stateContract?: StateContract; ignorePatterns?: string[] } = {}
): Finding[] | null {
  if (!isScannable(rootDir, relativePath, options.ignorePatterns)) return null;
  const file = relativePath.replace(/\\/g, "/");
  const findings = diffUsages(extractFromContent(file, content), groundTruth);
  if (options.stateContract) findings.push(...checkStates([{ file, content }], options.stateContract));
  attachSuggestions(findings);
  return findings;
}
