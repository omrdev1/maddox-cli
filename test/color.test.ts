import { test } from "node:test";
import assert from "node:assert/strict";
import { parseColor } from "../src/color.js";

function assertClose(actual: number[] | null, expected: number[], tolerance: number) {
  assert.ok(actual, "expected a parsed color, got null");
  actual.forEach((channel, i) => {
    assert.ok(
      Math.abs(channel - expected[i]) <= tolerance,
      `channel ${i}: got ${channel}, expected ${expected[i]} (+/- ${tolerance})`
    );
  });
}

test("parses 3, 6 and 8 digit hex, ignoring alpha", () => {
  assert.deepEqual(parseColor("#fff"), [255, 255, 255]);
  assert.deepEqual(parseColor("#FAFAFB"), [250, 250, 251]);
  assert.deepEqual(parseColor("#ff000080"), [255, 0, 0]);
});

test("parses rgb and rgba in comma and space syntax", () => {
  assert.deepEqual(parseColor("rgb(255, 0, 0)"), [255, 0, 0]);
  assert.deepEqual(parseColor("rgb(255 0 0 / 50%)"), [255, 0, 0]);
  assert.deepEqual(parseColor("rgba(0, 0, 0, .5)"), [0, 0, 0]);
});

test("parses hsl in comma and space syntax", () => {
  assert.deepEqual(parseColor("hsl(0 0% 100%)"), [255, 255, 255]);
  assert.deepEqual(parseColor("hsl(0, 100%, 50%)"), [255, 0, 0]);
  // the shadcn "slate-50" style value: hsl(210 40% 98%) is #f8fafc
  assertClose(parseColor("hsl(210 40% 98%)"), [248, 250, 252], 1);
});

test("parses oklch against known Tailwind values", () => {
  assert.deepEqual(parseColor("oklch(1 0 0)"), [255, 255, 255]);
  assert.deepEqual(parseColor("oklch(0 0 0)"), [0, 0, 0]);
  assertClose(parseColor("oklch(0.985 0 0)"), [250, 250, 250], 1); // neutral-50, #fafafa
  assertClose(parseColor("oklch(98.5% 0 0)"), [250, 250, 250], 1);
  assertClose(parseColor("oklch(0.922 0 0)"), [229, 229, 229], 1); // neutral-200, #e5e5e5
});

// Reference values read back from Chrome's own CSS engine (canvas getImageData),
// so the parser is checked against an independent implementation, not itself.
test("matches the browser for chromatic oklch and hsl colors", () => {
  assertClose(parseColor("oklch(0.623 0.214 259.815)"), [43, 127, 255], 1); // Tailwind v4 blue-500
  assertClose(parseColor("oklch(0.637 0.237 25.331)"), [251, 44, 54], 1);
  assertClose(parseColor("oklch(0.723 0.219 149.579)"), [0, 201, 80], 1);
  assertClose(parseColor("oklch(0.5 0.1 200)"), [0, 116, 122], 1);
  assertClose(parseColor("oklch(70% 0.15 60)"), [225, 133, 40], 1);
  assertClose(parseColor("hsl(222.2 47.4% 11.2%)"), [15, 23, 42], 1);
  assertClose(parseColor("hsl(0 84.2% 60.2%)"), [239, 68, 68], 1);
});

test("returns null for values that are not a concrete color", () => {
  for (const value of ["var(--background)", "transparent", "currentColor", "red", "oklch(", "#12", "12px", ""]) {
    assert.equal(parseColor(value), null, value);
  }
});
