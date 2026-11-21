import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInit, formatInitPlan, planInit } from "../src/init.js";

function makeTempApp() {
  const root = mkdtempSync(join(tmpdir(), "maddox-init-"));
  mkdirSync(join(root, "src", "app"), { recursive: true });
  writeFileSync(
    join(root, "src", "app", "globals.css"),
    `@theme {\n  --color-brand: #2ee6b8;\n  --spacing-4: 16px;\n}\n`
  );
  return root;
}

test("planInit auto-detects @theme CSS and source dir and respects --dry-run", () => {
  const root = makeTempApp();
  try {
    const dry = planInit({ cwd: root, dryRun: true });
    assert.equal(dry.theme, "src/app/globals.css");
    assert.equal(dry.source, "src");
    assert.equal(dry.actions.length, 4);
    applyInit(dry);
    assert.equal(existsSync(join(root, "maddox.config.json")), false);
    assert.equal(existsSync(join(root, ".mcp.json")), false);
    assert.match(formatInitPlan(dry), /dry run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyInit writes config, local Claude hook, .mcp.json, and CLAUDE.md without duplicating on re-run", () => {
  const root = makeTempApp();
  try {
    const first = planInit({ cwd: root });
    applyInit(first);

    const cfg = JSON.parse(readFileSync(join(root, "maddox.config.json"), "utf8"));
    assert.equal(cfg.theme, "src/app/globals.css");
    assert.equal(cfg.source, "src");

    const claude = JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8"));
    assert.equal(claude.hooks.PostToolUse.length, 1);
    assert.match(claude.hooks.PostToolUse[0].hooks[0].command, /hook claude-code/);

    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    assert.deepEqual(mcp.mcpServers.maddox.args, ["-y", "maddox-engine", "mcp"]);

    const rules = readFileSync(join(root, "CLAUDE.md"), "utf8");
    assert.match(rules, /get_design_tokens/);

    // Re-running init must skip all 4 files cleanly
    const second = planInit({ cwd: root });
    assert.ok(second.actions.every((a) => a.kind === "skip"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merges into existing .claude/settings.json and .mcp.json without overwriting other entries", () => {
  const root = makeTempApp();
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { PostToolUse: [{ matcher: "Bash", hooks: [] }] } })
    );
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-mcp", args: [] } } })
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "maddox-engine": "^0.12.0" } }));

    const plan = planInit({ cwd: root, claudeSettings: "shared", rules: "skip" });
    applyInit(plan);

    const claude = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(claude.permissions, { allow: ["Read"] });
    assert.equal(claude.hooks.PostToolUse.length, 2);
    assert.equal(claude.hooks.PostToolUse[1].hooks[0].command, "./node_modules/.bin/maddox hook claude-code");

    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers.other);
    assert.equal(mcp.mcpServers.maddox.command, "./node_modules/.bin/maddox");
    assert.equal(existsSync(join(root, "CLAUDE.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns theme=null cleanly when no CSS tokens exist", () => {
  const root = mkdtempSync(join(tmpdir(), "maddox-init-empty-"));
  try {
    const plan = planInit({ cwd: root });
    assert.equal(plan.theme, null);
    assert.equal(plan.actions.length, 0);
    assert.match(formatInitPlan(plan), /--theme/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
