import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromContent } from "../src/extract.js";
import { diffUsages } from "../src/diff.js";
import { attachSuggestions } from "../src/suggestFix.js";
import { suggestTokens, nameForColor, themeSnippet } from "../src/suggestTokens.js";
import type { Finding, GroundTruth } from "../src/types.js";

const scan = (css: string, tokens: Record<string, string>): Finding[] =>
  attachSuggestions(diffUsages(extractFromContent("a.css", css), { tokens, motion: [] } as GroundTruth));
const repeat = (n: number, rule: string) => Array.from({ length: n }, (_, i) => rule.replace("%", String(i))).join("\n");

test("names a colour from its hue and lightness on a 50 to 950 scale", () => {
  assert.equal(nameForColor("#0b3b33"), "--color-teal-900");
  assert.equal(nameForColor("#c62828"), "--color-red-600");
  assert.equal(nameForColor("#777777"), "--color-gray-600");
  assert.equal(nameForColor("rgba(255, 255, 255, 0.06)"), "--color-white-a6");
  assert.equal(nameForColor("rgb(0 0 0 / 0.4)"), "--color-black-a40");
});

test("suggests colours used often that match no token, most used first, with a projected score", () => {
  const css = [repeat(6, ".a% { color: #0b3b33; }"), repeat(3, ".b% { color: #c62828; }"), repeat(2, ".c% { color: #141413; }")].join("\n");
  const findings = scan(css, { "--color-ink": "#141413" });
  const s = suggestTokens(findings, { "--color-ink": "#141413" }, { minUses: 3 });
  assert.deepEqual(s.tokens.map((t) => [t.name, t.value, t.uses]), [["--color-teal-900", "#0b3b33", 6], ["--color-red-600", "#c62828", 3]]);
  assert.ok(s.projectedScore > s.currentScore);
  assert.equal(s.projectedScore, 100);
});

test("ignores colours used fewer times than the minimum", () => {
  const findings = scan(repeat(2, ".a% { color: #0b3b33; }"), { "--color-ink": "#141413" });
  assert.deepEqual(suggestTokens(findings, { "--color-ink": "#141413" }, { minUses: 5 }).tokens, []);
});

test("includes deliberate gradient shades that are near a token but can't be fixed without flattening the gradient", () => {
  const css = repeat(5, ".k% { background: linear-gradient(180deg, #111110 0%, #1a1a18 100%); }");
  const findings = scan(css, { "--color-hw-body": "#1c1c1a" });
  const names = suggestTokens(findings, { "--color-hw-body": "#1c1c1a" }, { minUses: 5 }).tokens.map((t) => t.value);
  assert.deepEqual(names.sort(), ["#111110", "#1a1a18"]);
});

test("leaves out near-misses that have a safe fix, since fixing them is the better move", () => {
  const findings = scan(repeat(6, ".a% { color: #151514; }"), { "--color-ink": "#141413" });
  assert.deepEqual(suggestTokens(findings, { "--color-ink": "#141413" }, { minUses: 5 }).tokens, []);
});

test("never reuses an existing token name, and writes a ready-to-paste @theme block", () => {
  const findings = scan(repeat(5, ".a% { color: #0b3b33; }"), { "--color-teal-900": "#134e4a" });
  const s = suggestTokens(findings, { "--color-teal-900": "#134e4a" }, { minUses: 5 });
  assert.equal(s.tokens[0].name, "--color-teal-900-2");
  assert.equal(themeSnippet(s.tokens), "@theme {\n  --color-teal-900-2: #0b3b33; /* 5 uses */\n}");
});

test("the same colour written different ways is one suggestion", () => {
  const css = [repeat(3, ".a% { color: rgba(0,0,0,0.5); }"), repeat(3, ".b% { color: rgba(0, 0, 0, 0.5); }"), repeat(2, ".c% { color: #0B3B33; }"), repeat(2, ".d% { color: #0b3b33; }")].join("\n");
  const s = suggestTokens(scan(css, { "--color-ink": "#141413" }), { "--color-ink": "#141413" }, { minUses: 4 });
  assert.deepEqual(s.tokens.map((t) => [t.name, t.uses]), [["--color-black-a50", 6], ["--color-teal-900", 4]]);
});

test("very dark shades get distinct steps instead of a numbered duplicate", () => {
  assert.equal(nameForColor("#1a1a18"), "--color-gray-950");
  assert.equal(nameForColor("#111110"), "--color-gray-975");
});
