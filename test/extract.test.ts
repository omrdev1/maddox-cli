import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromContent } from "../src/extract.js";

// Literal values only; var() token references are covered in tokenRefs.test.ts.
const values = (content: string) => extractFromContent("a.css", content).filter((u) => !u.tokenRef).map((u) => u.rawValue);

test("ignores colors written in block and line comments", () => {
  const content = [
    "/* #fafafa */",
    "// #fbfbfb",
    "const a = 1; // #fcfcfc",
    "color: #111111;",
  ].join("\n");
  assert.deepEqual(values(content), ["#111111"]);
});

test("keeps line numbers correct after a multi-line comment", () => {
  const content = "/* one\ntwo\nthree */\ncolor: #111111;";
  assert.equal(extractFromContent("a.css", content)[0].line, 4);
});

test("does not treat a url's double slash as a comment", () => {
  assert.deepEqual(values('const u = "https://x.dev/a"; const c = "#111111";'), ["#111111"]);
});

test("ignores values on custom property declarations (token definitions)", () => {
  const content = [
    ":root {",
    "  --color-base-100: #151a22;",
    "  --a:#111111;--b:#222222;",
    "}",
    ".x { color: #333333; }",
  ].join("\n");
  assert.deepEqual(values(content), ["#333333"]);
});

test("still reads a hex used as a var() fallback", () => {
  assert.deepEqual(values(".x { color: var(--c, #444444); }"), ["#444444"]);
});

test("ignores no-op motion values: zero and one millisecond", () => {
  const content = [
    "animation-duration: 1ms !important;",
    "transition-duration: 0ms;",
    "message.loading('x', { duration: 0 });",
    "{ delay: 0 }",
  ].join("\n");
  assert.deepEqual(values(content), []);
});

test("reads motion durations with their unit", () => {
  assert.deepEqual(values("transition-duration: 0.3s;"), ["0.3"]);
  assert.deepEqual(values("transition-duration: 300ms;"), ["0.3"]);
  assert.deepEqual(values("transition: { duration: 0.8 }"), ["0.8"]);
});

test("maddox-ignore on a line skips that line only", () => {
  const content = ['const a = "#111111"; // maddox-ignore', 'const b = "#222222";'].join("\n");
  assert.deepEqual(values(content), ["#222222"]);
});

test("maddox-ignore-next-line skips the following line, in line and block comments", () => {
  const content = [
    "// maddox-ignore-next-line",
    'const a = "#111111";',
    "/* maddox-ignore-next-line */",
    ".x { color: #222222; }",
    'const c = "#333333";',
  ].join("\n");
  assert.deepEqual(values(content), ["#333333"]);
});

test("maddox-ignore-start and maddox-ignore-end skip a whole region", () => {
  const content = [
    'const before = "#111111";',
    "// maddox-ignore-start",
    'const palette = ["#222222", "#333333"];',
    'const preset = { background: "#444444" };',
    "// maddox-ignore-end",
    'const after = "#555555";',
  ].join("\n");
  assert.deepEqual(values(content), ["#111111", "#555555"]);
});

test("an unclosed region skips to the end of the file, and ordinary comments suppress nothing", () => {
  assert.deepEqual(values(['// maddox-ignore-start', 'const a = "#111111";', 'const b = "#222222";'].join("\n")), []);
  assert.deepEqual(values(['// please ignore this', 'const a = "#111111";'].join("\n")), ["#111111"]);
});

test("ignored lines also hide motion values", () => {
  assert.deepEqual(values("{ duration: 0.8 } // maddox-ignore"), []);
});
