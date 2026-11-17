import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Which branch / commit / pull request a scan belongs to, sent with uploads so
// Maddox Cloud can compare a pull request with its base branch.

export interface GitContext {
  branch?: string;
  commitSha?: string;
  baseBranch?: string;
  defaultBranch?: string;
  pullRequest?: number;
}

type Env = Record<string, string | undefined>;
type GitHubEvent = {
  pull_request?: { number?: number; head?: { sha?: string } };
  repository?: { default_branch?: string };
} | null;

function compact(ctx: GitContext): GitContext {
  return Object.fromEntries(Object.entries(ctx).filter(([, v]) => v !== undefined && v !== "")) as GitContext;
}

/**
 * From environment variables only: explicit MADDOX_BRANCH / MADDOX_BASE_BRANCH /
 * MADDOX_COMMIT_SHA (any CI) win; otherwise GitHub Actions' own variables and
 * event payload. Returns {} when neither is present.
 */
export function gitContextFromEnv(env: Env, readEvent: (path: string) => unknown): GitContext {
  if (env.MADDOX_BRANCH) {
    return compact({ branch: env.MADDOX_BRANCH, baseBranch: env.MADDOX_BASE_BRANCH, commitSha: env.MADDOX_COMMIT_SHA });
  }
  if (env.GITHUB_ACTIONS !== "true") return {};

  let event: GitHubEvent = null;
  if (env.GITHUB_EVENT_PATH) {
    try {
      event = readEvent(env.GITHUB_EVENT_PATH) as GitHubEvent;
    } catch {
      event = null;
    }
  }
  const defaultBranch = event?.repository?.default_branch;
  const isPullRequest = env.GITHUB_EVENT_NAME === "pull_request" || env.GITHUB_EVENT_NAME === "pull_request_target";

  if (isPullRequest) {
    return compact({
      branch: env.GITHUB_HEAD_REF,
      baseBranch: env.GITHUB_BASE_REF,
      defaultBranch,
      pullRequest: event?.pull_request?.number,
      // GITHUB_SHA is GitHub's temporary merge commit on PRs; report the real head commit.
      commitSha: event?.pull_request?.head?.sha ?? env.GITHUB_SHA,
    });
  }
  return compact({ branch: env.GITHUB_REF_NAME, defaultBranch, commitSha: env.GITHUB_SHA });
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** From a local git checkout (for scans run on a developer's machine). */
export function gitContextFromRepo(cwd: string): GitContext {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") return {}; // detached HEAD or not a git repo
  const remoteHead = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]); // e.g. "origin/main"
  return compact({
    branch,
    commitSha: git(cwd, ["rev-parse", "HEAD"]),
    defaultBranch: remoteHead?.replace(/^origin\//, ""),
  });
}

export function detectGitContext(cwd: string, env: Env = process.env): GitContext {
  const fromEnv = gitContextFromEnv(env, (path) => JSON.parse(readFileSync(path, "utf8")));
  return fromEnv.branch ? fromEnv : gitContextFromRepo(cwd);
}
