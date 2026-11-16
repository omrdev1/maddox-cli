import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardRunUrl } from "../src/format.js";

test("links to the exact run when the upload returns its id", () => {
  assert.equal(
    dashboardRunUrl("https://www.maddoxengine.com", { scanRunId: "3f2b8c1e-1d2a-4b5c-9d8e-7f6a5b4c3d2e" }),
    "https://www.maddoxengine.com/dashboard/runs/3f2b8c1e-1d2a-4b5c-9d8e-7f6a5b4c3d2e"
  );
});

test("falls back to the dashboard when the id is missing or not a uuid", () => {
  assert.equal(dashboardRunUrl("https://x.dev", {}), "https://x.dev/dashboard");
  assert.equal(dashboardRunUrl("https://x.dev", { scanRunId: "../../evil" }), "https://x.dev/dashboard");
  assert.equal(dashboardRunUrl("https://x.dev/", null), "https://x.dev/dashboard");
});
