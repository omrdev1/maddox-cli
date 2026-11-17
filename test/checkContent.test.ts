import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, checkContent, loadGroundTruth } from "../src/core.js";
import { isScannable } from "../src/scan.js";

const THEME = "@theme {\n  --color-ink: #111111;\n  --color-paper: #fafafa;\n  --text-sm: 14px;\n}\n";

function withProject(files: Record<string, string>, run: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "maddox-check-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("isScannable applies the same extensions, default ignores, skipped folders and .maddoxignore as a full scan", () =>
  withProject({ ".maddoxignore": "legacy/**\n" }, (dir) => {
    assert.equal(isScannable(dir, "src/Card.tsx"), true);
    assert.equal(isScannable(dir, "src/card.css"), true);
    assert.equal(isScannable(dir, "src/card.scss"), false);
    assert.equal(isScannable(dir, "src/Card.test.tsx"), false);
    assert.equal(isScannable(dir, "src/Card.stories.tsx"), false);
    assert.equal(isScannable(dir, "src/__tests__/Card.tsx"), false);
    assert.equal(isScannable(dir, "node_modules/x/index.js"), false);
    assert.equal(isScannable(dir, "dist/app.js"), false);
    assert.equal(isScannable(dir, "tailwind.config.ts"), false);
    assert.equal(isScannable(dir, "legacy/old.css"), false);
    assert.equal(isScannable(dir, "src/generated/x.ts", ["generated"]), false);
  }));

test("checkContent gives exactly the findings a full scan gives for that file", () =>
  withProject(
    {
      "theme.css": THEME,
      "src/card.css": ".card { color: #111111; background: #fafafb; font-size: 15px; }\n",
      "src/other.css": ".x { color: #123456; }\n",
    },
    async (dir) => {
      const gt = loadGroundTruth(join(dir, "theme.css"), {});
      const full = (await audit(join(dir, "src"), gt)).findings.filter((f) => f.file === "card.css");
      const single = checkContent(join(dir, "src"), "card.css", readFileSync(join(dir, "src/card.css"), "utf8"), gt);
      assert.ok(single);
      assert.deepEqual(single, full);
      assert.ok(single.some((f) => f.severity === "near-miss" && f.suggestion));
    }
  ));

test("checkContent checks proposed content, not what is on disk", () =>
  withProject({ "theme.css": THEME, "src/card.css": ".card { color: #111111; }\n" }, (dir) => {
    const gt = loadGroundTruth(join(dir, "theme.css"), {});
    const findings = checkContent(join(dir, "src"), "card.css", ".card { color: #fafafb; }\n", gt);
    assert.ok(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rawValue, "#fafafb");
  }));

test("checkContent returns null for files a scan would skip", () =>
  withProject({ "theme.css": THEME }, (dir) => {
    const gt = loadGroundTruth(join(dir, "theme.css"), {});
    assert.equal(checkContent(dir, "Card.test.tsx", 'const c = "#fafafb";', gt), null);
    assert.equal(checkContent(dir, "styles.scss", ".a { color: #fafafb; }", gt), null);
  }));

test("checkContent includes state findings when a state contract is given", () =>
  withProject({ "theme.css": THEME }, (dir) => {
    const gt = loadGroundTruth(join(dir, "theme.css"), {});
    const findings = checkContent(dir, "Button.tsx", "export const Button = () => <button />;", gt, {
      stateContract: { "Button.tsx": ["disabled"] },
    });
    assert.ok(findings?.some((f) => f.kind === "state" && f.rawValue === "disabled"));
  }));
