// Safety rules for suggested and applied fixes, each from a real case found
// while fixing Grafikui's own products.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractFromContent } from "../src/extract.js";
import { diffUsages } from "../src/diff.js";
import { attachSuggestions } from "../src/suggestFix.js";
import { applyFixes } from "../src/applyFixes.js";
import type { GroundTruth } from "../src/types.js";

const findingsFor = (file: string, content: string, tokens: Record<string, string>) =>
  attachSuggestions(diffUsages(extractFromContent(file, content), { tokens, motion: [] } as GroundTruth));

function applyTo(file: string, content: string, tokens: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "maddox-safe-"));
  try {
    writeFileSync(join(dir, file), content);
    const result = applyFixes(dir, findingsFor(file, content, tokens));
    return { result, after: readFileSync(join(dir, file), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a token reference is already correct, so it is never offered as a fix", () => {
  const f = findingsFor("a.css", ".a { color: var(--color-ink); }", { "--color-ink": "#141413" });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "match");
  assert.equal(f[0].suggestion, undefined);
});

test("an opaque colour is never matched to a translucent token", () => {
  const tokens = { "--color-hw-border": "rgba(255, 255, 255, 0.06)", "--color-surface": "#fafaf8" };
  const [f] = findingsFor("a.css", ".a { background: #ffffff; }", tokens);
  assert.equal(f.nearestToken, "--color-surface");
  const [only] = findingsFor("a.css", ".a { background: #ffffff; }", { "--color-hw-border": "rgba(255, 255, 255, 0.06)" });
  assert.equal(only.severity, "unrecognized");
  assert.equal(only.suggestion, undefined);
});

test("a background prefers a background token over a closer text token, and never suggests a text token for it", () => {
  const both = { "--color-text-primary": "#0d0d0d", "--color-hw-body": "#1c1c1a" };
  const [f] = findingsFor("a.css", ".a { background: #111110; }", both);
  assert.equal(f.nearestToken, "--color-hw-body");
  assert.equal(f.suggestion, "var(--color-hw-body)");
  const [onlyText] = findingsFor("a.css", ".a { background: #111110; }", { "--color-text-primary": "#0d0d0d" });
  assert.equal(onlyText.severity, "near-miss");
  assert.equal(onlyText.suggestion, undefined);
  const [text] = findingsFor("a.css", ".a { color: #111110; }", both);
  assert.equal(text.suggestion, "var(--color-text-primary)");
});

test("fixes inside Framer Motion props and GSAP tweens are held, since var() can't be animated", () => {
  const tokens = { "--color-brand": "#141413" }; // a neutral name, so only the animation rule is in play
  for (const line of [
    'const a = <motion.p animate={{ color: "#151514" }} />;',
    'tl.fromTo(el, { color: "#151514" }, { color: "#fff" });',
    'gsap.to(el, { backgroundColor: "#151514" });',
  ]) {
    const { result, after } = applyTo("a.tsx", line + "\n", tokens);
    assert.equal(after, line + "\n", line);
    assert.equal(result.applied.length, 0);
    assert.ok(result.held.some((h) => h.reason === "animation"), line);
  }
});

test("fixes are held when they would make a gradient's stops identical, and applied when they wouldn't", () => {
  const tokens = { "--color-hw-body": "#1c1c1a", "--color-hw-panel": "#242421" };
  const flat = ".a { background: linear-gradient(180deg, #111110 0%, #1a1a18 100%); }\n";
  const r1 = applyTo("a.css", flat, tokens);
  assert.equal(r1.after, flat);
  assert.ok(r1.result.held.some((h) => h.reason === "gradient"));
  const keeps = ".a { background: linear-gradient(180deg, #1a1a18 0%, #242422 100%); }\n";
  const r2 = applyTo("a.css", keeps, tokens);
  assert.equal(r2.after, ".a { background: linear-gradient(180deg, var(--color-hw-body) 0%, var(--color-hw-panel) 100%); }\n");
});

test("fixes in email templates are held, since email clients don't support CSS variables", () => {
  const email = `import { Resend } from 'resend';\nconst html = \`<html><body style="color: #151514">Hi</body></html>\`;\n`;
  const { result, after } = applyTo("route.ts", email, { "--color-ink": "#141413" });
  assert.equal(after, email);
  assert.ok(result.held.some((h) => h.reason === "email"));
});

test("a tint of a token colour counts as that token, with no automatic fix (it would lose its transparency)", () => {
  const [f] = findingsFor("a.css", ".a { background: rgba(255, 255, 255, 0.06); }", { "--color-white": "#ffffff" });
  assert.equal(f.severity, "match");
  assert.equal(f.nearestToken, "--color-white");
  assert.equal(f.suggestion, undefined);
});
