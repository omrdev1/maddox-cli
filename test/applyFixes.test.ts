import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyFixes } from "../src/applyFixes.js";

test("applyFixes matches uppercase hex literals and ignores longer hex prefixes", () => {
  const dir = mkdtempSync(join(tmpdir(), "maddox-apply-"));
  try {
    writeFileSync(join(dir, "App.tsx"), 'const a = "#FFF"; const b = "#ffffff";\n');
    const result = applyFixes(dir, [
      {
        file: "App.tsx",
        line: 1,
        kind: "color",
        rawValue: "#fff",
        severity: "near-miss",
        nearestToken: "--color-surface",
        suggestion: "var(--color-surface)",
      },
    ]);
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].occurrences, 1);
    assert.equal(result.skipped.length, 0);
    assert.equal(
      readFileSync(join(dir, "App.tsx"), "utf8"),
      'const a = "var(--color-surface)"; const b = "#ffffff";\n'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
