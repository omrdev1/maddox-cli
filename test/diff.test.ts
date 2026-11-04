import { test } from "node:test";
import assert from "node:assert/strict";
import { diffUsages } from "../src/diff.js";
import type { RawUsage } from "../src/extract.js";

function colorUsage(rawValue: string): RawUsage {
  return { file: "Button.tsx", line: 1, kind: "color", rawValue };
}

function diffOne(tokens: Record<string, string>, rawValue: string) {
  return diffUsages([colorUsage(rawValue)], { tokens, motion: [] })[0];
}

test("a hex color matches the hsl token it equals", () => {
  const finding = diffOne({ "--color-background": "hsl(0 0% 100%)" }, "#ffffff");
  assert.equal(finding.severity, "match");
  assert.equal(finding.nearestToken, "--color-background");
});

test("a hex color close to an oklch token is a near-miss", () => {
  const finding = diffOne({ "--color-muted": "oklch(0.985 0 0)" }, "#fcfcfc");
  assert.equal(finding.severity, "near-miss");
  assert.equal(finding.nearestToken, "--color-muted");
});

test("a hex color far from every token stays unrecognized", () => {
  const finding = diffOne({ "--color-background": "hsl(0 0% 100%)" }, "#ff0000");
  assert.equal(finding.severity, "unrecognized");
});

test("non-color tokens are ignored when matching colors", () => {
  const finding = diffOne({ "--text-sm": "0.875rem", "--color-ink": "#111111" }, "#111111");
  assert.equal(finding.severity, "match");
  assert.equal(finding.nearestToken, "--color-ink");
});

function fontSizeUsage(rawValue: string): RawUsage {
  return { file: "Card.css", line: 3, kind: "font-size", rawValue };
}

test("a font size that equals a token once converted to pixels is a match, not a near-miss", () => {
  const [finding] = diffUsages([fontSizeUsage("0.875rem")], { tokens: { "--text-sm": "14px" }, motion: [] });
  assert.equal(finding.severity, "match");
  assert.equal(finding.nearestToken, "--text-sm");
});

test("a font size 2px off a token is still a near-miss", () => {
  const [finding] = diffUsages([fontSizeUsage("2rem")], { tokens: { "--text-headline": "30px" }, motion: [] });
  assert.equal(finding.severity, "near-miss");
});

test("kinds with nothing to compare against produce no findings", () => {
  const usages: RawUsage[] = [
    colorUsage("#123456"),
    fontSizeUsage("12px"),
    { file: "a.ts", line: 1, kind: "motion", rawValue: "0.4" },
  ];
  assert.deepEqual(diffUsages(usages, { tokens: { "--font-sans": "Inter" }, motion: [] }), []);
});

test("each kind is only compared when its own tokens exist", () => {
  const usages: RawUsage[] = [colorUsage("#123456"), fontSizeUsage("12px")];
  const findings = diffUsages(usages, { tokens: { "--color-ink": "#111111" }, motion: [] });
  assert.deepEqual(findings.map((f) => f.kind), ["color"]);
});
