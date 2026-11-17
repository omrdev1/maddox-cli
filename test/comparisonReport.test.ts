import { test } from "node:test";
import assert from "node:assert/strict";
import { toMarkdown, summarize } from "../src/format.js";

const summary = summarize([], 3);
const added = [{ file: "src/a.css", line: 4, kind: "color", rawValue: "#123457", severity: "near-miss", suggestion: "var(--brand)" }];

test("PR comment leads with what this PR adds and fixes", () => {
  const md = toMarkdown(summary, {
    comparison: { available: true, baselineBranch: "main", baseline: { runId: "r", createdAt: "2026-11-17T10:00:00Z", commitSha: "abc1234" }, added: 1, fixed: 2, addedFindings: added, fixedFindings: [] },
  });
  assert.match(md, /This PR adds \*\*1\*\* new drift and fixes \*\*2\*\* compared with `main`/);
  assert.match(md, /src\/a\.css:4/);
});

test("no new drift reads as a pass", () => {
  const md = toMarkdown(summary, {
    comparison: { available: true, baselineBranch: "main", baseline: { runId: "r", createdAt: "2026-11-17T10:00:00Z", commitSha: null }, added: 0, fixed: 0, addedFindings: [], fixedFindings: [] },
  });
  assert.match(md, /No new drift compared with `main`/);
});

test("no baseline yet explains how to get one", () => {
  const md = toMarkdown(summary, { comparison: { available: true, baselineBranch: "main", baseline: null, added: 0, fixed: 0, addedFindings: [], fixedFindings: [] } });
  assert.match(md, /No scan of `main` yet/);
});

test("free plan gets a single upgrade line, no comparison", () => {
  const md = toMarkdown(summary, { comparison: { available: false } });
  assert.match(md, /Team and Scale/);
  assert.doesNotMatch(md, /new drift/);
});

test("without a comparison the report is unchanged", () => {
  assert.doesNotMatch(toMarkdown(summary), /Compared with|Team and Scale/);
});
