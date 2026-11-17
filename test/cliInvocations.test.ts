// Every way the CLI was called before 0.10.0 must behave exactly as it did.
// Runs the real entry point in a child process, with no API key in its environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("src/cli.ts");
const EXAMPLE = resolve("example");

function run(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.MADDOX_API_KEY;
  delete env.GITHUB_ACTIONS;
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function withProject(config: unknown | null, fn: (dir: string) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "maddox-cli-")));
  mkdirSync(join(dir, ".git"));
  cpSync(EXAMPLE, join(dir, "app"), { recursive: true });
  cpSync(EXAMPLE, join(dir, "check"), { recursive: true });
  if (config !== null) writeFileSync(join(dir, "maddox.config.json"), typeof config === "string" ? config : JSON.stringify(config));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const files = (out: string) => (JSON.parse(out) as { filesScanned: number }).filesScanned;

test("positional scan works, and ignores a config in the folder", () =>
  withProject({ theme: "app/theme.css", source: "app", exclude: ["*.css"] }, (dir) => {
    const r = run(dir, ["app", "app/theme.css", "--format", "json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(files(r.out), 1); // the config's exclude ("*.css") was not applied
  }));

test("the Action's --url shape with the '-' placeholder still means a URL scan, not the config", () =>
  withProject({ theme: "app/theme.css" }, (dir) => {
    const r = run(dir, ["-", "app/theme.css", "--url", "http://127.0.0.1:9/none", "--format", "markdown"]);
    assert.notEqual(r.code, 0); // nothing listens there; what matters is it tried the URL
    assert.doesNotMatch(r.err + r.out, /maddox\.config\.json|Usage:/);
  }));

test("flags only, with no config: prints usage and exits 2", () =>
  withProject(null, (dir) => {
    const r = run(dir, ["--format", "json"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /Usage: maddox/);
  }));

test("flags only, with a config: uses the config's paths and the flags still apply", () =>
  withProject({ theme: "app/theme.css", source: "app", project: "web" }, (dir) => {
    const r = run(dir, ["--format", "json", "--fail-below", "100"]);
    assert.equal(r.code, 1); // the flag applied: score below 100 fails
    assert.equal(files(r.out), 1);
  }));

test("a broken config with a flags-only call exits 2 with the config error", () =>
  withProject({ theme: "app/theme.css", sauce: 1 }, (dir) => {
    const r = run(dir, ["--format", "json"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /Unknown key "sauce"/);
  }));

test("./check scans a folder named check; bare reserved names are refused, not scanned", () =>
  withProject(null, (dir) => {
    assert.equal(files(run(dir, ["./check", "app/theme.css", "--format", "json"]).out), 1);
    const r = run(dir, ["mcp", "app/theme.css"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /use \.\/mcp/);
  }));

test("--help and --version never scan, even with a config present", () =>
  withProject({ theme: "app/theme.css", source: "app" }, (dir) => {
    const help = run(dir, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage: maddox/);
    const version = run(dir, ["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.out.trim(), /^\d+\.\d+\.\d+$/);
  }));

test("check accepts flags before the file and rejects an unknown format", () =>
  withProject({ theme: "app/theme.css", source: "app" }, (dir) => {
    const r = run(dir, ["check", "--format", "json", "app/component.css"]);
    assert.equal(r.code, 1, r.err); // the example has a near-miss
    assert.equal(JSON.parse(r.out).file, "component.css");
    assert.equal(run(dir, ["check", "app/component.css", "--format", "yaml"]).code, 2);
  }));

test("check with just a file and no flags checks that file", () =>
  withProject({ theme: "app/theme.css", source: "app" }, (dir) => {
    const r = run(dir, ["check", "app/component.css"]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /component\.css:\d+ +\[color\] #fafafb/);
    const stdin = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, "check", "app/new.css", "--stdin"], {
      cwd: dir, input: ".a { color: #111111; }", encoding: "utf8",
    });
    assert.equal(stdin.status, 0, stdin.stderr);
    assert.match(stdin.stdout, /no drift/);
  }));
