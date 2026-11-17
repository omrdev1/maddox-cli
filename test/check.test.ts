import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, MAX_CHECK_BYTES } from "../src/check.js";

const THEME = "@theme {\n  --color-ink: #111111;\n  --color-paper: #fafafa;\n}\n";

function withProject(files: Record<string, string>, run: (dir: string) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "maddox-cmd-")));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const project = (extra: Record<string, string> = {}) => ({
  "maddox.config.json": JSON.stringify({ theme: "theme.css", source: "src" }),
  "theme.css": THEME,
  "src/.keep": "",
  ...extra,
});

test("reports drift in a file with its line, nearest token and fix, leaving out matches", () =>
  withProject(project({ "src/card.css": ".card {\n  color: #111111;\n  background: #fafafb;\n}\n" }), (dir) => {
    const r = runCheck({ file: join(dir, "src/card.css"), cwd: dir });
    assert.equal(r.status, "checked");
    assert.equal(r.status === "checked" && r.file, "card.css");
    assert.equal(r.status === "checked" && r.findings.length, 1);
    const f = r.status === "checked" ? r.findings[0] : undefined;
    assert.deepEqual([f?.line, f?.rawValue, f?.severity, f?.nearestToken, f?.suggestion], [3, "#fafafb", "near-miss", "--color-paper", "var(--color-paper)"]);
  }));

test("checks proposed content instead of the file on disk", () =>
  withProject(project({ "src/card.css": ".card { color: #111111; }\n" }), (dir) => {
    const r = runCheck({ file: "src/card.css", content: ".card { color: #fafafb; }\n", cwd: dir });
    assert.equal(r.status === "checked" && r.findings[0]?.rawValue, "#fafafb");
  }));

test("finds the config by walking up from the file, wherever the command runs", () =>
  withProject(project({ "src/ui/card.css": ".card { color: #fafafb; }\n" }), (dir) => {
    const r = runCheck({ file: join(dir, "src/ui/card.css"), cwd: tmpdir() });
    assert.equal(r.status === "checked" && r.file, "ui/card.css");
  }));

test("skips files a scan would skip, and files outside the source folder", () =>
  withProject(project({ "src/card.test.tsx": 'const c = "#fafafb";', "scripts/x.css": ".x { color: #fafafb; }" }), (dir) => {
    assert.equal(runCheck({ file: join(dir, "src/card.test.tsx"), cwd: dir }).status, "skipped");
    assert.equal(runCheck({ file: join(dir, "scripts/x.css"), cwd: dir }).status, "skipped");
  }));

test("refuses paths outside the project", () =>
  withProject(project(), (dir) => {
    const r = runCheck({ file: join(dir, "../elsewhere.css"), content: ".x{}", cwd: dir });
    assert.equal(r.status, "error");
    assert.match(r.status === "error" ? r.message : "", /outside the project/);
  }));

test("explains a missing config and a missing file", () => {
  withProject({ "src/a.css": "", ".git/HEAD": "" }, (dir) => {
    const r = runCheck({ file: join(dir, "src/a.css"), cwd: dir });
    assert.equal(r.status, "error");
    assert.match(r.status === "error" ? r.message : "", /maddox\.config\.json/);
  });
  withProject(project(), (dir) => {
    const r = runCheck({ file: join(dir, "src/nope.css"), cwd: dir });
    assert.match(r.status === "error" ? r.message : "", /not found/);
  });
});

test("refuses content over the size limit", () =>
  withProject(project(), (dir) => {
    const r = runCheck({ file: "src/big.css", content: "a".repeat(MAX_CHECK_BYTES + 1), cwd: dir });
    assert.match(r.status === "error" ? r.message : "", /too large/);
  }));

test("never reads the API key", () =>
  withProject(project({ "src/card.css": ".card { color: #fafafb; }" }), (dir) => {
    const before = process.env.MADDOX_API_KEY;
    let reads = 0;
    const env = new Proxy(process.env, { get: (t, k) => (k === "MADDOX_API_KEY" && reads++, Reflect.get(t, k)) });
    const real = process.env;
    process.env = env;
    try {
      runCheck({ file: join(dir, "src/card.css"), cwd: dir });
    } finally {
      process.env = real;
      if (before === undefined) delete process.env.MADDOX_API_KEY;
    }
    assert.equal(reads, 0);
  }));
