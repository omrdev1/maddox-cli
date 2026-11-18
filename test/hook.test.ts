import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeCodeHook, driftKey, newDrift, preCommit, reverseEdits } from "../src/hook.js";
import type { Finding } from "../src/types.js";

const CLI = resolve("src/cli.ts");

const THEME = [
  "@theme {",
  "  --color-ink: #111111;",
  "  --color-paper: #fafafa;",
  "  --text-sm: 14px;",
  "}",
  "",
].join("\n");

function withTemp(files: Record<string, string>, fn: (dir: string, stateDir: string) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "maddox-hook-test-")));
  const stateDir = join(dir, ".hook-state");
  mkdirSync(join(dir, ".git"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  try {
    fn(dir, stateDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withGitRepo(files: Record<string, string>, fn: (dir: string, stateDir: string) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "maddox-git-hook-")));
  const stateDir = join(dir, ".hook-state");
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  git(["init", "-q"]);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  try {
    fn(dir, stateDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "maddox.config.json": JSON.stringify({ theme: "theme.css", source: "src" }),
    "theme.css": THEME,
    "src/.keep": "",
    ...extra,
  };
}

function runCli(cwd: string, args: string[], stdin = "") {
  const env = { ...process.env };
  delete env.MADDOX_API_KEY;
  delete env.GITHUB_ACTIONS;
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    cwd,
    env,
    input: stdin,
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("PostToolUse Edit reports new drift with line, nearest token, fix and maddox-ignore note", () =>
  withTemp(
    baseFiles({
      "src/Card.tsx": [
        "export function Card() {",
        '  return <div style={{ color: "#111111", backgroundColor: "#fafafb" }}>Hi</div>;',
        "}",
        "",
      ].join("\n"),
    }),
    (dir, stateDir) => {
      const payload = JSON.stringify({
        session_id: "sess-1",
        cwd: dir,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(dir, "src/Card.tsx"),
          old_string: '  return <div style={{ color: "#111111" }}>Hi</div>;',
          new_string: '  return <div style={{ color: "#111111", backgroundColor: "#fafafb" }}>Hi</div>;',
        },
        tool_response: { filePath: join(dir, "src/Card.tsx") },
      });

      const out = claudeCodeHook(payload, { stateDir }) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      assert.ok(out);
      assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
      const msg = out.hookSpecificOutput.additionalContext;
      assert.match(msg, /Card\.tsx now has 1 hardcoded value/);
      assert.match(msg, /line 2: #fafafb \(color, near-miss, nearest token --color-paper\); suggested fix: var\(--color-paper\)/);
      assert.match(msg, /maddox-ignore/);
      assert.doesNotMatch(msg, /#111111/); // matches are never reported
    }
  ));

test("PostToolUse --insist returns block decision and reason", () =>
  withTemp(
    baseFiles({
      "src/card.css": ".card {\n  color: #123456;\n}\n",
    }),
    (dir, stateDir) => {
      const payload = JSON.stringify({
        cwd: dir,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(dir, "src/card.css"),
          old_string: "  color: #111111;",
          new_string: "  color: #123456;",
        },
      });
      const out = claudeCodeHook(payload, { insist: true, stateDir }) as { decision: string; reason: string };
      assert.equal(out.decision, "block");
      assert.match(out.reason, /line 2: #123456 \(color, unrecognized, nearest token --color-ink\)/);
    }
  ));

test("Edit moving pre-existing drift down by adding clean lines reports nothing", () =>
  withTemp(
    baseFiles({
      "src/card.css": [
        "/* added header */",
        "/* second line */",
        ".card {",
        "  background: #fafafb;",
        "}",
        "",
      ].join("\n"),
    }),
    (dir, stateDir) => {
      const payload = JSON.stringify({
        cwd: dir,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(dir, "src/card.css"),
          old_string: ".card {",
          new_string: "/* added header */\n/* second line */\n.card {",
        },
      });
      assert.equal(claudeCodeHook(payload, { stateDir }), null);
    }
  ));

test("Edit adding a second copy of an already-present drift value reports only the new copy on the edited line", () =>
  withTemp(
    baseFiles({
      "src/card.css": [
        ".old { background: #fafafb; }",
        ".new { background: #fafafb; }",
        "",
      ].join("\n"),
    }),
    (dir, stateDir) => {
      const payload = JSON.stringify({
        cwd: dir,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(dir, "src/card.css"),
          old_string: ".new { background: var(--color-paper); }",
          new_string: ".new { background: #fafafb; }",
        },
      });
      const out = claudeCodeHook(payload, { stateDir }) as { hookSpecificOutput: { additionalContext: string } };
      assert.ok(out);
      const msg = out.hookSpecificOutput.additionalContext;
      assert.match(msg, /now has 1 hardcoded value/);
      assert.match(msg, /line 2: #fafafb/);
    }
  ));

test("replace_all Edit reverses all replacements cleanly", () =>
  withTemp(
    baseFiles({
      "src/card.css": [
        ".a { background: #fafafb; }",
        ".b { background: #fafafb; }",
        "",
      ].join("\n"),
    }),
    (dir, stateDir) => {
      const payload = JSON.stringify({
        cwd: dir,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(dir, "src/card.css"),
          old_string: "background: var(--color-paper);",
          new_string: "background: #fafafb;",
          replace_all: true,
        },
      });
      const out = claudeCodeHook(payload, { stateDir }) as { hookSpecificOutput: { additionalContext: string } };
      assert.ok(out);
      assert.match(out.hookSpecificOutput.additionalContext, /now has 2 hardcoded values/);
      assert.match(out.hookSpecificOutput.additionalContext, /line 1: #fafafb/);
      assert.match(out.hookSpecificOutput.additionalContext, /line 2: #fafafb/);
    }
  ));

test("case and colour-format variants share a driftKey; substrings like 14px vs 114px stay distinct", () => {
  const f = (overrides: Partial<Finding>): Finding => ({
    file: "a.css",
    line: 1,
    kind: "color",
    rawValue: "#FAFAFB",
    severity: "near-miss",
    nearestToken: "--color-paper",
    ...overrides,
  });

  assert.equal(driftKey(f({ rawValue: "#FAFAFB" })), driftKey(f({ rawValue: "#fafafb" })));
  assert.equal(driftKey(f({ rawValue: "#fafafb" })), driftKey(f({ rawValue: "rgb(250, 250, 251)" })));
  assert.notEqual(
    driftKey(f({ kind: "font-size", rawValue: "14px", nearestToken: "--text-sm" })),
    driftKey(f({ kind: "font-size", rawValue: "114px", nearestToken: "--text-sm" }))
  );

  // Equivalent colour format change (e.g. #FAFAFB -> rgb(250, 250, 251)) is not new drift.
  assert.deepEqual(newDrift([f({ rawValue: "#FAFAFB" })], [f({ rawValue: "rgb(250, 250, 251)" })]), []);

  // Substring size 14px vs 114px: 14px in file does not mask adding 114px on line 2.
  const rev = reverseEdits(".a { font-size: 14px; }\n.b { font-size: 114px; }\n", [
    { old_string: ".b { font-size: var(--text-sm); }", new_string: ".b { font-size: 114px; }" },
  ]);
  assert.equal(rev.before, ".a { font-size: 14px; }\n.b { font-size: var(--text-sm); }\n");
  assert.deepEqual([...rev.lines], [2]);
});

test("ambiguous Edit reversal falls back to findings on lines spanned by new_string", () =>
  withTemp(
    baseFiles({
      "src/card.css": [
        ".first { color: #123456; }",
        ".second { color: #654321; }",
        ".dup { color: #654321; }",
        "",
      ].join("\n"),
    }),
    (dir, stateDir) => {
      // Both .second and .dup have `color: #654321;`, so reversing `new_string` is ambiguous.
      // Line 1 has #123456 outside the spanned lines and must not be reported by the fallback.
      const payload = JSON.stringify({
        cwd: dir,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(dir, "src/card.css"),
          old_string: "color: var(--color-ink);",
          new_string: "color: #654321;",
        },
      });
      const out = claudeCodeHook(payload, { stateDir }) as { hookSpecificOutput: { additionalContext: string } };
      assert.ok(out);
      const msg = out.hookSpecificOutput.additionalContext;
      assert.doesNotMatch(msg, /#123456/);
      assert.match(msg, /#654321/);
    }
  ));

test("MultiEdit reverses edits in order and reports newly introduced drift", () =>
  withTemp(
    baseFiles({
      "src/card.css": [
        ".a { color: #111111; }",
        ".b { background: #fafafb; }",
        ".c { font-size: 15px; }",
        "",
      ].join("\n"),
    }),
    (dir, stateDir) => {
      const payload = JSON.stringify({
        cwd: dir,
        hook_event_name: "PostToolUse",
        tool_name: "MultiEdit",
        tool_input: {
          file_path: join(dir, "src/card.css"),
          edits: [
            { old_string: ".b { background: var(--color-paper); }", new_string: ".b { background: #fafafb; }" },
            { old_string: ".c { font-size: var(--text-sm); }", new_string: ".c { font-size: 15px; }" },
          ],
        },
      });
      const out = claudeCodeHook(payload, { stateDir }) as { hookSpecificOutput: { additionalContext: string } };
      assert.ok(out);
      const msg = out.hookSpecificOutput.additionalContext;
      assert.match(msg, /line 2: #fafafb/);
      assert.match(msg, /line 3: 15px/);
    }
  ));

test("Write compares against HEAD on a tracked file and reports all drift on a new file", () =>
  withGitRepo(
    baseFiles({
      "src/tracked.css": ".old { color: #123456; }\n",
    }),
    (dir, stateDir) => {
      // Overwriting tracked.css keeping old #123456 and adding #fafafb reports only #fafafb.
      writeFileSync(join(dir, "src/tracked.css"), ".old { color: #123456; }\n.new { background: #fafafb; }\n");
      const trackedOut = claudeCodeHook(
        JSON.stringify({
          cwd: dir,
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: join(dir, "src/tracked.css") },
        }),
        { stateDir }
      ) as { hookSpecificOutput: { additionalContext: string } };
      assert.ok(trackedOut);
      assert.doesNotMatch(trackedOut.hookSpecificOutput.additionalContext, /#123456/);
      assert.match(trackedOut.hookSpecificOutput.additionalContext, /line 2: #fafafb/);

      // Writing an untracked file reports all drift in full.
      writeFileSync(join(dir, "src/brand-new.css"), ".fresh { color: #fafafb; font-size: 15px; }\n");
      const newOut = claudeCodeHook(
        JSON.stringify({
          cwd: dir,
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: join(dir, "src/brand-new.css") },
        }),
        { stateDir }
      ) as { hookSpecificOutput: { additionalContext: string } };
      assert.ok(newOut);
      assert.match(newOut.hookSpecificOutput.additionalContext, /#fafafb/);
      assert.match(newOut.hookSpecificOutput.additionalContext, /15px/);
    }
  ));

test("state findings are filtered out and matches are omitted", () =>
  withTemp(
    {
      ...baseFiles({
        "states.json": JSON.stringify({ Button: ["disabled", "loading"] }),
        "src/Button.tsx": "export function Button() {\n  return <button style={{ color: '#111111' }}>Save</button>;\n}\n",
      }),
      "maddox.config.json": JSON.stringify({ theme: "theme.css", source: "src", states: "states.json" }),
    },
    (dir, stateDir) => {
      const payload = JSON.stringify({
        cwd: dir,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(dir, "src/Button.tsx") },
      });
      // Missing states + clean color token => hook stays quiet.
      assert.equal(claudeCodeHook(payload, { stateDir }), null);
    }
  ));

test("session memory suppresses repeated findings in the same session, allows new findings and new sessions", () =>
  withTemp(
    baseFiles({
      "src/card.css": ".a { color: #fafafb; }\n",
    }),
    (dir, stateDir) => {
      const makePayload = (sessionId: string, oldS: string, newS: string) =>
        JSON.stringify({
          session_id: sessionId,
          cwd: dir,
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: { file_path: join(dir, "src/card.css"), old_string: oldS, new_string: newS },
        });

      // First edit introduces #fafafb in sess-a -> reported.
      const first = claudeCodeHook(makePayload("sess-a", ".a { color: var(--color-paper); }", ".a { color: #fafafb; }"), { stateDir });
      assert.ok(first);

      // Re-introducing/replacing another line with #fafafb in same sess-a -> suppressed by session memory.
      writeFileSync(join(dir, "src/card.css"), ".a { color: #fafafb; }\n.b { background: #fafafb; }\n");
      const repeat = claudeCodeHook(makePayload("sess-a", ".b { background: var(--color-paper); }", ".b { background: #fafafb; }"), { stateDir });
      assert.equal(repeat, null);

      // Different drift (#123456) in sess-a -> reported.
      writeFileSync(join(dir, "src/card.css"), ".a { color: #fafafb; }\n.b { background: #123456; }\n");
      const different = claudeCodeHook(makePayload("sess-a", ".b { background: #fafafb; }", ".b { background: #123456; }"), { stateDir }) as {
        hookSpecificOutput: { additionalContext: string };
      };
      assert.ok(different);
      assert.match(different.hookSpecificOutput.additionalContext, /#123456/);
      assert.doesNotMatch(different.hookSpecificOutput.additionalContext, /#fafafb/);

      // New session sess-b sees #123456 again -> reported.
      const otherSession = claudeCodeHook(makePayload("sess-b", ".b { background: #fafafb; }", ".b { background: #123456; }"), { stateDir });
      assert.ok(otherSession);
    }
  ));

test("quiet paths and crash isolation return null and exit 0 with empty stdout/stderr via CLI", () => {
  withTemp(
    baseFiles({
      "src/Button.test.tsx": 'const c = "#fafafb";\n',
      "src/Button.stories.tsx": 'const c = "#fafafb";\n',
      "src/notes.md": "# Notes #fafafb\n",
      "docs/outside.css": ".x { color: #fafafb; }\n",
    }),
    (dir, stateDir) => {
      const cases = [
        JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(dir, "src/x.css") } }),
        JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
        JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(dir, "src/Button.test.tsx") } }),
        JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(dir, "src/Button.stories.tsx") } }),
        JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(dir, "src/notes.md") } }),
        JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(dir, "docs/outside.css") } }),
        JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(dir, "../outside-root.css") } }),
        "{not json",
        "[]",
        "",
      ];
      for (const stdin of cases) {
        assert.equal(claudeCodeHook(stdin, { stateDir }), null);
        const r = runCli(dir, ["hook", "claude-code"], stdin);
        assert.equal(r.code, 0);
        assert.equal(r.out, "");
        assert.equal(r.err, "");
      }
    }
  );

  // Missing maddox.config.json also stays completely silent and exits 0.
  withTemp({ "src/a.css": ".a { color: #fafafb; }\n" }, (dir, stateDir) => {
    const stdin = JSON.stringify({
      cwd: dir,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(dir, "src/a.css") },
    });
    assert.equal(claudeCodeHook(stdin, { stateDir }), null);
    const r = runCli(dir, ["hook", "claude-code"], stdin);
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.equal(r.err, "");
  });
});

test("pre-commit hook gates only new staged drift by default, supports --all, and skips ignored/non-scannable files", () =>
  withGitRepo(
    baseFiles({
      "src/.maddoxignore": "ignored/**\n",
      "src/existing-drift.css": ".legacy { color: #123456; }\n",
      "src/clean.css": ".clean { color: #111111; }\n",
    }),
    (dir) => {
      const stage = (rel: string, content: string) => {
        mkdirSync(join(dir, rel, ".."), { recursive: true });
        writeFileSync(join(dir, rel), content);
        execFileSync("git", ["add", rel], { cwd: dir });
      };
      const unstageAll = () => execFileSync("git", ["reset", "-q"], { cwd: dir });

      // 1. Clean staged change exits 0 with no output.
      stage("src/clean.css", ".clean { color: #111111; background: var(--color-paper); }\n");
      const cleanRes = runCli(dir, ["hook", "pre-commit"]);
      assert.equal(cleanRes.code, 0);
      assert.equal(cleanRes.err, "");
      unstageAll();

      // 2. Touching a file with pre-existing drift in HEAD without adding drift exits 0 by default, 1 with --all.
      stage("src/existing-drift.css", "/* comment */\n.legacy { color: #123456; }\n");
      const legacyDefault = preCommit({ cwd: dir });
      assert.equal(legacyDefault.exitCode, 0);
      assert.equal(legacyDefault.output, "");
      const legacyAll = preCommit({ cwd: dir, all: true });
      assert.equal(legacyAll.exitCode, 1);
      assert.match(legacyAll.output, /existing-drift\.css:2\s+\[color\] #123456/);
      unstageAll();

      // 3. Staged change adding new drift over HEAD exits 1 with details and --no-verify hint.
      stage("src/existing-drift.css", ".legacy { color: #123456; }\n.added { background: #fafafb; }\n");
      const addedRes = runCli(dir, ["hook", "pre-commit"]);
      assert.equal(addedRes.code, 1);
      assert.match(addedRes.err, /this commit adds 1 hardcoded value/);
      assert.match(addedRes.err, /existing-drift\.css:2\s+\[color\] #fafafb → near-miss \(nearest: --color-paper\)\s+fix: var\(--color-paper\)/);
      assert.match(addedRes.err, /git commit --no-verify/);
      assert.doesNotMatch(addedRes.err, /#123456/);
      unstageAll();

      // 4. Staged newly added file with drift exits 1.
      stage("src/brand-new.css", ".card { font-size: 15px; }\n");
      const newFileRes = preCommit({ cwd: dir });
      assert.equal(newFileRes.exitCode, 1);
      assert.match(newFileRes.output, /brand-new\.css:1\s+\[font-size\] 15px/);
      unstageAll();

      // 5. Staged ignored or non-scannable file is skipped and exits 0.
      stage("src/ignored/gen.css", ".x { color: #fafafb; }\n");
      stage("src/Card.test.tsx", 'const c = "#fafafb";\n');
      const skippedRes = preCommit({ cwd: dir });
      assert.equal(skippedRes.exitCode, 0);
      assert.equal(skippedRes.output, "");
    }
  ));
