import { test } from "node:test";
import assert from "node:assert/strict";
import { hasComparableTokens, hasUsableGroundTruth, parseThemeCss } from "../src/groundTruth.js";

test("reads literal tokens from a plain @theme block", () => {
  const tokens = parseThemeCss(`@theme { --color-ink: #111111; --text-sm: 0.875rem; }`);
  assert.deepEqual(tokens, { "--color-ink": "#111111", "--text-sm": "0.875rem" });
});

test("resolves @theme inline var() references from :root (the shadcn pattern)", () => {
  const css = `
    :root { --background: hsl(0 0% 100%); --radius: 0.6rem; }
    .dark { --background: hsl(222 47% 11%); }
    @theme inline {
      --color-background: var(--background);
      --radius-md: var(--radius);
    }`;
  assert.deepEqual(parseThemeCss(css), {
    "--color-background": "hsl(0 0% 100%)",
    "--radius-md": "0.6rem",
  });
});

test("merges every @theme block, whatever its modifier", () => {
  const css = `
    @theme { --color-a: #111111; }
    @theme static { --color-b: #222222; }
    @theme inline { --color-c: #333333; }`;
  assert.deepEqual(Object.keys(parseThemeCss(css)).sort(), ["--color-a", "--color-b", "--color-c"]);
});

test("follows chained references and uses a var() fallback when the variable is missing", () => {
  const css = `
    :root { --base: #123456; --alias: var(--base); }
    @theme inline {
      --color-one: var(--alias);
      --color-two: var(--missing, #abcdef);
    }`;
  assert.deepEqual(parseThemeCss(css), { "--color-one": "#123456", "--color-two": "#abcdef" });
});

test("drops tokens whose references cannot be resolved, including cycles", () => {
  const css = `
    :root { --x: var(--y); --y: var(--x); }
    @theme inline { --color-loop: var(--x); --color-ghost: var(--nowhere); --color-ok: #111111; }`;
  assert.deepEqual(parseThemeCss(css), { "--color-ok": "#111111" });
});

test("ignores declarations inside comments", () => {
  const tokens = parseThemeCss(`@theme { /* --color-fake: #ffffff; */ --color-real: #000000; }`);
  assert.deepEqual(tokens, { "--color-real": "#000000" });
});

test("hasComparableTokens needs at least one color or length value", () => {
  assert.equal(hasComparableTokens({}), false);
  assert.equal(hasComparableTokens({ "--font-sans": "Inter, sans-serif" }), false);
  assert.equal(hasComparableTokens({ "--color-a": "oklch(0.5 0.1 200)" }), true);
  assert.equal(hasComparableTokens({ "--text-sm": "0.875rem" }), true);
});

test("ground truth is usable with comparable tokens or with motion tokens, not with neither", () => {
  assert.equal(hasUsableGroundTruth({ tokens: {}, motion: [] }), false);
  assert.equal(hasUsableGroundTruth({ tokens: { "--font-sans": "Inter" }, motion: [] }), false);
  assert.equal(hasUsableGroundTruth({ tokens: { "--color-a": "#111111" }, motion: [] }), true);
  assert.equal(hasUsableGroundTruth({ tokens: {}, motion: [{ path: "fade.duration", value: 0.3 }] }), true);
});

test("reads blocks that follow @import and other statements, as real stylesheets do", () => {
  const css = `
    @import "tailwindcss";
    @plugin "@tailwindcss/typography";
    @custom-variant dark (&:is(.dark *));

    :root { --background: hsl(0 0% 100%); }
    @theme inline { --color-background: var(--background); }`;
  assert.deepEqual(parseThemeCss(css), { "--color-background": "hsl(0 0% 100%)" });
});

test("reads a plain @theme block that follows an @import", () => {
  assert.deepEqual(parseThemeCss(`@import "tailwindcss";\n@theme { --color-ink: #111111; }`), {
    "--color-ink": "#111111",
  });
});
