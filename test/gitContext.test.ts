import { test } from "node:test";
import assert from "node:assert/strict";
import { gitContextFromEnv } from "../src/gitContext.js";

const prEvent = { pull_request: { number: 42, head: { sha: "1111111aaaaaaa" } }, repository: { default_branch: "main" } };
const pushEvent = { repository: { default_branch: "trunk" } };

test("GitHub pull_request: head branch, base branch, PR number and the real head commit", () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "feat/x", GITHUB_BASE_REF: "main", GITHUB_SHA: "9999999merge", GITHUB_EVENT_PATH: "/e.json" };
  assert.deepEqual(gitContextFromEnv(env, () => prEvent), {
    branch: "feat/x", baseBranch: "main", defaultBranch: "main", pullRequest: 42, commitSha: "1111111aaaaaaa",
  });
});

test("GitHub push: branch from the ref, default branch from the event", () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "trunk", GITHUB_SHA: "abcdef1234", GITHUB_EVENT_PATH: "/e.json" };
  assert.deepEqual(gitContextFromEnv(env, () => pushEvent), { branch: "trunk", defaultBranch: "trunk", commitSha: "abcdef1234" });
});

test("explicit MADDOX_* variables work in any CI and win", () => {
  const env = { MADDOX_BRANCH: "feature", MADDOX_BASE_BRANCH: "develop", MADDOX_COMMIT_SHA: "abc1234", GITHUB_ACTIONS: "true", GITHUB_REF_NAME: "ignored" };
  assert.deepEqual(gitContextFromEnv(env, () => null), { branch: "feature", baseBranch: "develop", commitSha: "abc1234" });
});

test("no CI and no variables: nothing", () => {
  assert.deepEqual(gitContextFromEnv({}, () => null), {});
});

test("an unreadable event file is ignored, not fatal", () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main", GITHUB_SHA: "abcdef1234", GITHUB_EVENT_PATH: "/missing.json" };
  assert.deepEqual(gitContextFromEnv(env, () => { throw new Error("ENOENT"); }), { branch: "main", commitSha: "abcdef1234" });
});
