import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromContent } from "../src/extract.js";
import { diffUsages } from "../src/diff.js";
import { healthScore } from "../src/healthScore.js";
import type { GroundTruth } from "../src/types.js";

const gt: GroundTruth = {
  tokens: { "--color-paper": "#fafafa", "--color-ink": "#1a1a1a", "--text-sm": "14px", "--spacing-4": "16px" },
  motion: [],
};

const refs = (content: string, file = "a.css") => extractFromContent(file, content).filter((u) => u.tokenRef);

test("token references are found in CSS, JSX strings and Tailwind brackets, with position", () => {
  const css = ".a { color: var(--color-paper); padding: var(--spacing-4); }";
  assert.deepEqual(refs(css).map((u) => [u.tokenRef, u.line, u.column]), [["--color-paper", 1, 13], ["--spacing-4", 1, 42]]);
  const tsx = 'const c = <p className="text-[length:var(--text-sm)]" style={{ color: "var(--color-ink)" }} />;';
  assert.deepEqual(refs(tsx, "a.tsx").map((u) => u.tokenRef), ["--text-sm", "--color-ink"]);
});

test("references inside a custom property definition are not usages", () => {
  const css = ":root { --surface: var(--color-paper); }\n@theme { --color-brand: var(--color-ink); }";
  assert.deepEqual(refs(css), []);
});

test("a reference to a real token counts as a match of that token's kind", () => {
  const findings = diffUsages(refs(".a { color: var(--color-paper); font-size: var(--text-sm); margin: var(--spacing-4); }"), gt);
  assert.deepEqual(
    findings.map((f) => [f.kind, f.severity, f.nearestToken, f.rawValue]),
    [
      ["color", "match", "--color-paper", "var(--color-paper)"],
      ["font-size", "match", "--text-sm", "var(--text-sm)"],
      ["spacing", "match", "--spacing-4", "var(--spacing-4)"],
    ]
  );
});

test("references to variables that are not design tokens are ignored, not scored", () => {
  assert.deepEqual(diffUsages(refs(".a { opacity: var(--tw-bg-opacity); color: var(--unknown); }"), gt), []);
});

test("replacing a drifted literal with its token raises the score", () => {
  const before = diffUsages(extractFromContent("a.css", ".a { color: #fafafb; background: #1a1a1a; }"), gt);
  const after = diffUsages(extractFromContent("a.css", ".a { color: var(--color-paper); background: #1a1a1a; }"), gt);
  const count = (fs: typeof before) => ({
    match: fs.filter((f) => f.severity === "match").length,
    "near-miss": fs.filter((f) => f.severity === "near-miss").length,
    unrecognized: fs.filter((f) => f.severity === "unrecognized").length,
    missing: 0,
  });
  assert.ok(healthScore(count(after)) > healthScore(count(before)), `${healthScore(count(before))} -> ${healthScore(count(after))}`);
});
