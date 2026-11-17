import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfig, loadConfig, resolveInside, ConfigError } from "../src/config.js";

function withDir(files: Record<string, string>, run: (dir: string) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "maddox-config-")));
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

const cfg = (o: unknown) => JSON.stringify(o);

test("findConfig walks up from a nested folder to the nearest maddox.config.json", () =>
  withDir({ "maddox.config.json": cfg({ theme: "theme.css" }), "theme.css": "", "src/ui/x.css": "" }, (dir) => {
    assert.equal(findConfig(join(dir, "src/ui")), join(dir, "maddox.config.json"));
  }));

test("findConfig stops at the repository root", () =>
  withDir({ "maddox.config.json": cfg({ theme: "t.css" }), "repo/.git/HEAD": "", "repo/src/x.css": "" }, (dir) => {
    assert.equal(findConfig(join(dir, "repo/src")), null);
  }));

test("loadConfig resolves every path against the project root and fills defaults", () =>
  withDir(
    { "maddox.config.json": cfg({ theme: "app/theme.css", source: "app", exclude: ["legacy/**"], project: "web" }), "app/theme.css": "" },
    (dir) => {
      const c = loadConfig(join(dir, "maddox.config.json"));
      assert.equal(c.root, dir);
      assert.equal(c.theme, join(dir, "app/theme.css"));
      assert.equal(c.source, join(dir, "app"));
      assert.deepEqual(c.exclude, ["legacy/**"]);
      assert.equal(c.project, "web");
      assert.equal(c.motion, undefined);
    }
  ));

test("source defaults to the project root and project to the folder name", () =>
  withDir({ "maddox.config.json": cfg({ theme: "theme.css" }), "theme.css": "" }, (dir) => {
    const c = loadConfig(join(dir, "maddox.config.json"));
    assert.equal(c.source, dir);
    assert.equal(c.project, dir.split("/").pop());
  }));

test("loadConfig rejects unknown keys, wrong types, missing theme and invalid JSON with a clear message", () => {
  const cases: [unknown, RegExp][] = [
    [{ theme: "theme.css", them: "x" }, /Unknown key "them"/],
    [{ theme: 3 }, /"theme" must be a string/],
    [{}, /"theme" is required/],
    [{ theme: "theme.css", exclude: "legacy" }, /"exclude" must be a list of strings/],
    [{ theme: "missing.css" }, /theme file not found/],
  ];
  for (const [body, message] of cases) {
    withDir({ "maddox.config.json": cfg(body), "theme.css": "" }, (dir) => {
      assert.throws(() => loadConfig(join(dir, "maddox.config.json")), (e: Error) => e instanceof ConfigError && message.test(e.message));
    });
  }
  withDir({ "maddox.config.json": "{ nope", "theme.css": "" }, (dir) => {
    assert.throws(() => loadConfig(join(dir, "maddox.config.json")), /not valid JSON/);
  });
});

test("paths in the config cannot leave the project, including through a symlink", () =>
  withDir({ "project/maddox.config.json": cfg({ theme: "../outside.css" }), "outside.css": "" }, (dir) => {
    assert.throws(() => loadConfig(join(dir, "project/maddox.config.json")), /outside the project/);
    writeFileSync(join(dir, "project/maddox.config.json"), cfg({ theme: "link.css" }));
    symlinkSync(join(dir, "outside.css"), join(dir, "project/link.css"));
    assert.throws(() => loadConfig(join(dir, "project/maddox.config.json")), /outside the project/);
  }));

test("resolveInside accepts paths inside the root, including ones not created yet, and refuses escapes", () =>
  withDir({ "src/a.css": "" }, (dir) => {
    assert.equal(resolveInside(dir, "src/a.css"), join(dir, "src/a.css"));
    assert.equal(resolveInside(dir, "src/new.css"), join(dir, "src/new.css"));
    assert.equal(resolveInside(dir, join(dir, "src/a.css")), join(dir, "src/a.css"));
    assert.throws(() => resolveInside(dir, "../etc/passwd"), /outside the project/);
    assert.throws(() => resolveInside(dir, "/etc/passwd"), /outside the project/);
  }));
