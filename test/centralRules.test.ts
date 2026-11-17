import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScanComparison } from "../src/format.js";
import { applyExceptions, newDriftVerdict, parseCentralRules, EMPTY_CENTRAL_RULES } from "../src/centralRules.js";

test("applyExceptions removes approved drift values case-insensitively and keeps matches", () => {
  const findings = [
    { rawValue: "#FF6B00", severity: "unrecognized" as const },
    { rawValue: "#ff6b00", severity: "near-miss" as const },
    { rawValue: "#ff6b00", severity: "match" as const },
    { rawValue: "#123456", severity: "unrecognized" as const },
    { rawValue: "14px", severity: "near-miss" as const },
  ];
  const { findings: kept, exceptedCount } = applyExceptions(findings, [" #ff6b00 ", "14px", ""]);
  assert.equal(exceptedCount, 3);
  assert.deepEqual(kept, [
    { rawValue: "#ff6b00", severity: "match" },
    { rawValue: "#123456", severity: "unrecognized" },
  ]);
});

test("parseCentralRules accepts the server shape and drops anything malformed", () => {
  assert.deepEqual(parseCentralRules({ failBelow: 80, failOnNewDrift: true, exceptions: ["#ff6b00", 3] }), {
    failBelow: 80,
    failOnNewDrift: true,
    exceptions: ["#ff6b00"],
  });
  assert.deepEqual(parseCentralRules(null), EMPTY_CENTRAL_RULES);
  assert.deepEqual(parseCentralRules({ failBelow: "80", failOnNewDrift: "yes" }), EMPTY_CENTRAL_RULES);
  assert.equal(parseCentralRules({ failBelow: 120 }).failBelow, null);
});

const on = { ...EMPTY_CENTRAL_RULES, failOnNewDrift: true };
const pr = { branch: "feat", baseBranch: "main", pullRequest: 7 };
const compared = (added: number): ScanComparison & { available: true } => ({
  available: true, baselineBranch: "main", baseline: { runId: "r", createdAt: "t", commitSha: null }, added, fixed: 0, addedFindings: [], fixedFindings: [],
});

test("newDriftVerdict fails a pull request that adds drift", () => {
  const v = newDriftVerdict(on, pr, compared(2));
  assert.equal(v.fail, true);
  assert.match(v.message!, /2 new drifts/);
});

test("newDriftVerdict passes a pull request that adds nothing", () => {
  assert.equal(newDriftVerdict(on, pr, compared(0)).fail, false);
});

test("newDriftVerdict never fails pushes to main, and is silent when the rule is off", () => {
  assert.deepEqual(newDriftVerdict(on, { branch: "main" }, compared(5)), { fail: false });
  assert.deepEqual(newDriftVerdict(EMPTY_CENTRAL_RULES, pr, compared(5)), { fail: false });
});

test("newDriftVerdict explains, without failing, when there is nothing to compare with", () => {
  const noBaseline = { ...compared(0), baseline: null };
  const v1 = newDriftVerdict(on, pr, noBaseline);
  assert.equal(v1.fail, false);
  assert.match(v1.message!, /no earlier scan of main/);
  const v2 = newDriftVerdict(on, pr, null);
  assert.equal(v2.fail, false);
  assert.match(v2.message!, /comparison unavailable/);
});
