// Color functions, 4/8-digit hex, JSX and Tailwind font sizes, spacing,
// and position-exact --apply-fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractFromContent } from "../src/extract.js";
import { diffUsages } from "../src/diff.js";
import { suggestFix } from "../src/suggestFix.js";
import { applyFixes } from "../src/applyFixes.js";
import { audit } from "../src/core.js";
import type { Finding, GroundTruth } from "../src/types.js";

const of = (file: string, content: string, kind?: string) =>
  extractFromContent(file, content)
    .filter((u) => !kind || u.kind === kind)
    .map((u) => u.rawValue);

// ---------- color ----------

test("reads rgb(), hsl() and oklch() color literals in source", () => {
  const css = ".x { color: rgb(18, 52, 87); background: hsl(210 50% 40%); border-color: oklch(0.5 0.1 200); }";
  assert.deepEqual(of("a.css", css, "color"), ["rgb(18, 52, 87)", "hsl(210 50% 40%)", "oklch(0.5 0.1 200)"]);
});

test("ignores color functions built from variables (shadcn hsl(var(--x)), Tailwind v3 compiled output)", () => {
  const css = ".x { color: hsl(var(--primary)); background: hsl(var(--primary) / 0.5); fill: rgb(0 0 0 / var(--tw-bg-opacity)); }";
  assert.deepEqual(of("a.css", css, "color"), []);
});

test("ignores fully transparent colors (the transparent idiom)", () => {
  assert.deepEqual(of("a.css", ".x { color: rgba(0, 0, 0, 0); background: #0000; }", "color"), []);
});

test("reads 4- and 8-digit hex, but never HTML entities", () => {
  assert.deepEqual(of("a.tsx", 'const a = "#abcd"; const b = "#12345680";', "color"), ["#abcd", "#12345680"]);
  assert.deepEqual(of("a.tsx", "<p>It&#8217;s &#1234; done</p>", "color"), []);
});

test("records the exact column and source literal of a usage", () => {
  const [usage] = extractFromContent("a.css", ".x {\n  color: #ABCDEF;\n}");
  assert.equal(usage.line, 2);
  assert.equal(usage.column, 10);
  assert.equal(usage.literal, "#ABCDEF");
  assert.equal(usage.rawValue, "#abcdef");
});

test("ignores hex inside attribute selectors (shadcn chart.tsx), but reads JSX attributes", () => {
  const tsx = [
    `className="[&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_line[stroke="#ccc"]]:stroke-border"`,
    "css: '[fill=#123456] { opacity: 0 }'",
    '<path fill="#123456" stroke=\'#abcdef\' />',
  ].join("\n");
  assert.deepEqual(of("a.tsx", tsx, "color"), ["#123456", "#abcdef"]);
});

// ---------- font-size ----------

test("reads JSX fontSize strings and numbers, and Tailwind text-[...]", () => {
  const tsx = [
    'style={{ fontSize: "15px" }}',
    "style={{ fontSize: 15 }}",
    "style={{ fontSize: '0.875rem' }}",
    'className="md:text-[13px] text-[#aabbcc]"',
  ].join("\n");
  assert.deepEqual(of("a.tsx", tsx, "font-size").sort(), ["0.875rem", "13px", "15px", "15px"]);
});

test("a bare number is only a px font size in JS/TS, never in CSS", () => {
  assert.deepEqual(of("a.css", ".x { fontSize: 15 }", "font-size"), []);
});

// ---------- spacing ----------

test("reads CSS padding, margin and gap lengths, skipping 0, auto and negatives", () => {
  const css = ".x { padding: 12px 16px; margin-top: 1.5rem; gap: 8px; margin: 0 auto; margin-left: -8px; }";
  assert.deepEqual(of("a.css", css, "spacing"), ["12px", "16px", "1.5rem", "8px"]);
});

test("reads JSX spacing strings and numbers, but not expressions or types", () => {
  const tsx = [
    'style={{ paddingTop: 12, marginInline: "4px", gap: isMobile ? 8 : 16 }}',
    "interface P { padding: number; margin: string }",
    "const p = { padding: theme.spacing(2) };",
  ].join("\n");
  assert.deepEqual(of("a.tsx", tsx, "spacing"), ["12px", "4px"]);
});

test("reads single-value Tailwind spacing brackets, skipping negatives and multi-value brackets", () => {
  const tsx = 'className="p-[13px] mt-[1.5rem] gap-x-[6px] -mt-[8px] p-[10px_20px] w-[13px]"';
  assert.deepEqual(of("a.tsx", tsx, "spacing"), ["13px", "1.5rem", "6px"]);
});

// ---------- diff ----------

const brandAndScale: GroundTruth = {
  tokens: {
    "--color-brand": "#123456",
    "--text-base": "16px",
    "--spacing-4": "16px",
    "--radius-md": "14px",
  },
  motion: [],
};

test("color functions in source diff against tokens like hex does", () => {
  const usages = extractFromContent("a.css", ".x { color: rgb(18, 52, 87); }");
  const [finding] = diffUsages(usages, brandAndScale);
  assert.equal(finding.severity, "near-miss");
  assert.equal(finding.nearestToken, "--color-brand");
});

test("spacing compares by pixel distance against spacing tokens only", () => {
  const usages = extractFromContent("a.css", ".x { padding: 15px; margin: 1rem; gap: 14px; }");
  const findings = diffUsages(usages, brandAndScale);
  assert.deepEqual(
    findings.map((f) => [f.rawValue, f.severity, f.nearestToken]),
    [
      ["15px", "near-miss", "--spacing-4"],
      ["1rem", "match", "--spacing-4"],
      ["14px", "near-miss", "--spacing-4"], // never --radius-md, even though it is exact
    ]
  );
});

test("no spacing findings when the theme only has a Tailwind v4 --spacing base or non-spacing lengths", () => {
  const usages = extractFromContent("a.css", ".x { padding: 13px; }");
  assert.deepEqual(diffUsages(usages, { tokens: { "--spacing": "0.25rem", "--text-sm": "14px" }, motion: [] }), []);
});

// ---------- suggestions ----------

const finding = (over: Partial<Finding>): Finding => ({
  file: "a.tsx",
  line: 1,
  kind: "color",
  rawValue: "#123457",
  severity: "near-miss",
  nearestToken: "--color-brand",
  ...over,
});

test("suggestions are typed inside a whole Tailwind bracket and quoted for a JS number", () => {
  assert.equal(suggestFix(finding({ fixStyle: "tailwind" })), "color:var(--color-brand)");
  assert.equal(suggestFix(finding({ kind: "font-size", nearestToken: "--text-base", fixStyle: "tailwind" })), "length:var(--text-base)");
  assert.equal(suggestFix(finding({ kind: "spacing", nearestToken: "--spacing-4", fixStyle: "js-number" })), '"var(--spacing-4)"');
  assert.equal(suggestFix(finding({})), "var(--color-brand)");
});

test("translucent colors get no suggestion, since a token would drop the transparency", () => {
  assert.equal(suggestFix(finding({ rawValue: "rgba(18, 52, 87, 0.5)" })), undefined);
  assert.equal(suggestFix(finding({ rawValue: "#12345780" })), undefined);
  assert.equal(suggestFix(finding({ rawValue: "rgba(18, 52, 87, 1)" })), "var(--color-brand)");
});

// ---------- apply-fixes, end to end ----------

function withProject(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "maddox-gaps-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function fix(dir: string): Promise<void> {
  const result = await audit(dir, brandAndScale);
  applyFixes(dir, result.findings);
}

test("the same literal in two kinds on one line gets each kind's own token", () =>
  withProject({ "A.tsx": 'const s = { fontSize: "15px", padding: "15px" };\n' }, async (dir) => {
    await fix(dir);
    assert.equal(
      readFileSync(join(dir, "A.tsx"), "utf8"),
      'const s = { fontSize: "var(--text-base)", padding: "var(--spacing-4)" };\n'
    );
  }));

test("Tailwind brackets get type-hinted fixes, partial brackets get plain var()", () =>
  withProject(
    { "B.tsx": 'const c = "bg-[#123457] text-[15px] p-[15px] shadow-[0_0_0_1px_#123457]";\n' },
    async (dir) => {
      await fix(dir);
      assert.equal(
        readFileSync(join(dir, "B.tsx"), "utf8"),
        'const c = "bg-[color:var(--color-brand)] text-[length:var(--text-base)] p-[length:var(--spacing-4)] shadow-[0_0_0_1px_var(--color-brand)]";\n'
      );
    }
  ));

test("a JS number becomes a quoted var() string so the file still compiles", () =>
  withProject({ "C.tsx": "const s = { fontSize: 15, marginTop: 15 };\n" }, async (dir) => {
    await fix(dir);
    assert.equal(
      readFileSync(join(dir, "C.tsx"), "utf8"),
      'const s = { fontSize: "var(--text-base)", marginTop: "var(--spacing-4)" };\n'
    );
  }));

test("translucent colors are left untouched", () =>
  withProject({ "D.css": ".x { color: rgba(18, 52, 87, 0.5); }\n" }, async (dir) => {
    await fix(dir);
    assert.equal(readFileSync(join(dir, "D.css"), "utf8"), ".x { color: rgba(18, 52, 87, 0.5); }\n");
  }));

test("a finding whose column no longer holds its literal is skipped", () =>
  withProject({ "E.css": ".x { color: #123457; }\n" }, async (dir) => {
    const result = await audit(dir, brandAndScale);
    writeFileSync(join(dir, "E.css"), ".x { margin: 0; color: #123457; }\n");
    const { applied, skipped } = applyFixes(dir, result.findings);
    assert.equal(applied.length, 0);
    assert.equal(skipped.length, 1);
  }));

test("scans .js/.jsx files and skips tailwind.config (it defines tokens, it does not use them)", () =>
  withProject(
    {
      "F.jsx": 'const a = "#123457";\n',
      "tailwind.config.js": 'module.exports = { theme: { colors: { brand: "#123457" } } };\n',
    },
    async (dir) => {
      const result = await audit(dir, brandAndScale);
      assert.deepEqual(result.findings.map((f) => f.file), ["F.jsx"]);
    }
  ));
