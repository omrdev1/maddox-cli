import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreBadgeColor } from "../src/format.js";

test("a low score is never green: below 60 is red", () => {
  assert.equal(scoreBadgeColor(32), "red");
  assert.equal(scoreBadgeColor(59), "red");
});

test("bands switch at 60 and 85, matching the dashboard", () => {
  assert.equal(scoreBadgeColor(60), "yellow");
  assert.equal(scoreBadgeColor(84), "yellow");
  assert.equal(scoreBadgeColor(85), "brightgreen");
  assert.equal(scoreBadgeColor(100), "brightgreen");
});
