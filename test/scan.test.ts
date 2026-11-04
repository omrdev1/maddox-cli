import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSource } from "../src/scan.js";

function withProject(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "maddox-scan-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const scannedFiles = async (dir: string, extra: string[] = []) =>
  [...new Set((await scanSource(dir, extra)).map((usage) => usage.file))].sort();

test("scans application files but skips tests, specs, stories and mocks by default", () =>
  withProject(
    {
      "src/Button.tsx": 'const c = "#111111";',
      "src/Button.test.tsx": 'const c = "#222222";',
      "src/Button.spec.ts": 'const c = "#333333";',
      "src/Button.stories.tsx": 'const c = "#444444";',
      "src/Button.story.tsx": 'const c = "#555555";',
      "src/__tests__/helpers.ts": 'const c = "#666666";',
      "src/__mocks__/theme.ts": 'const c = "#777777";',
    },
    async (dir) => assert.deepEqual(await scannedFiles(dir), ["src/Button.tsx"])
  ));

test("user ignore patterns still apply on top of the defaults", () =>
  withProject(
    { "src/a.tsx": 'const c = "#111111";', "src/generated/b.tsx": 'const c = "#222222";' },
    async (dir) => assert.deepEqual(await scannedFiles(dir, ["generated"]), ["src/a.tsx"])
  ));
