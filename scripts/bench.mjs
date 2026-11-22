#!/usr/bin/env node
// Times the commands an editor or agent runs on every edit, so the figures in
// the README can be reproduced. Usage: node scripts/bench.mjs [runs]
// Builds a small throwaway git project, runs each scenario with 3 warm-up runs
// then `runs` timed runs (default 40), and prints the median and p95 in ms.
// Uses the local build in ./dist, so run `npm run build` first.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runs = Number(process.argv[2] ?? 40);
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
if (!existsSync(cli)) {
  console.error("dist/cli.js not found. Run `npm run build` first.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "maddox-bench-"));
const sh = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
try {
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "package.json"), '{"name":"bench","version":"1.0.0"}');
  writeFileSync(join(dir, "maddox.config.json"), '{"theme":"app/globals.css","source":"app"}');
  writeFileSync(join(dir, "app/globals.css"), "@theme { --color-brand: #2563eb; --color-ink: #141413; --spacing-4: 16px; }\n");
  const rule = (i) => `.k${i} { color: var(--color-brand); padding: var(--spacing-4); }`;
  const clean = Array.from({ length: 40 }, (_, i) => rule(i)).join("\n") + "\n";
  const withDrift = Array.from({ length: 39 }, (_, i) => rule(i)).join("\n") + "\n.drift { color: #2563ec; }\n";
  writeFileSync(join(dir, "app/clean.css"), clean);
  writeFileSync(join(dir, "app/drift.css"), withDrift);
  sh("init", "-q");
  sh("config", "user.email", "bench@example.com");
  sh("config", "user.name", "bench");
  sh("add", "-A");
  sh("commit", "-qm", "base");

  const payload = (tool, file) =>
    JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: tool,
      tool_input: { file_path: join(dir, "app", file), ...(tool === "Edit" ? { old_string: "#2563eb", new_string: "#2563ec" } : {}) },
      tool_response: { success: true },
      cwd: dir,
    });

  const time = (cmd, args, input = "") => {
    const t = process.hrtime.bigint();
    spawnSync(cmd, args, { cwd: dir, input, stdio: ["pipe", "ignore", "ignore"] });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const bench = (label, cmd, args, input) => {
    for (let i = 0; i < 3; i++) time(cmd, args, input);
    const ts = Array.from({ length: runs }, () => time(cmd, args, input)).sort((a, b) => a - b);
    const med = ts[Math.floor(ts.length / 2)];
    const p95 = ts[Math.ceil(ts.length * 0.95) - 1];
    console.log(`${label.padEnd(58)} median ${med.toFixed(0).padStart(4)} ms   p95 ${p95.toFixed(0).padStart(4)} ms`);
  };

  console.log(`maddox bench: ${runs} runs each, ${cpus()[0].model}, node ${process.version}\n`);
  bench("bare node startup (baseline)", process.execPath, ["-e", "0"]);
  bench("maddox check <file>", process.execPath, [cli, "check", "app/clean.css", "--format", "json"]);
  bench("hook claude-code: Edit, no drift", process.execPath, [cli, "hook", "claude-code"], payload("Edit", "clean.css"));
  bench("hook claude-code: Edit adds drift", process.execPath, [cli, "hook", "claude-code"], payload("Edit", "drift.css"));
  bench("hook claude-code: Write over committed file, drift", process.execPath, [cli, "hook", "claude-code"], payload("Write", "drift.css"));
  writeFileSync(join(dir, "app/drift.css"), withDrift.replace("#2563ec", "#2563ed"));
  sh("add", "app/drift.css");
  bench("hook pre-commit: one staged file", process.execPath, [cli, "hook", "pre-commit"]);
  console.log("\nThe hook command `maddox init` writes goes through npx, which adds its own startup time; time it with:");
  console.log("  npx -y maddox-engine hook claude-code  (not included here, since it depends on npm's cache)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
