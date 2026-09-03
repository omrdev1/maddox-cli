export * from "./types.js";
export * from "./groundTruth.js";
export * from "./scan.js";
export * from "./diff.js";
export * from "./stateCheck.js";
export * from "./healthScore.js";

import { scanSource, scanFiles } from "./scan.js";
import { diffUsages } from "./diff.js";
import { checkStates } from "./stateCheck.js";
import type { GroundTruth, ScanResult, StateContract } from "./types.js";

export async function audit(
  rootDir: string,
  groundTruth: GroundTruth,
  stateContract?: StateContract
): Promise<ScanResult> {
  const usages = await scanSource(rootDir);
  const findings = diffUsages(usages, groundTruth);
  const scannedFiles = new Set(usages.map((u) => u.file));

  if (stateContract) {
    const files = await scanFiles(rootDir);
    findings.push(...checkStates(files, stateContract));
    for (const f of files) scannedFiles.add(f.file);
  }

  return { findings, filesScanned: scannedFiles.size };
}
