/**
 * Read-only git introspection, used to fill in what a session actually did.
 *
 * The agent is an unreliable and expensive narrator: asking it to recall every
 * file it touched costs tokens and still misses things. Git already holds the
 * ground truth, so the factual half of a handoff is derived rather than dictated.
 *
 * Everything here fails soft. A project with no git, no commits, or no git
 * binary at all must still be able to write a handoff.
 */
import { execFileSync } from "child_process";

const GIT_TIMEOUT_MS = 5000;
const MAX_COMMITS = 20;
const MAX_CHANGED = 20;

/** Run a git command, returning trimmed stdout or null on any failure. */
function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      // stderr is discarded: "not a git repository" is an expected outcome here.
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    // Trailing only: `status --porcelain` encodes state in leading columns, so
    // trimming the front would shift the first line's path by a character.
    return out.replace(/\s+$/, "");
  } catch {
    return null;
  }
}

export function isGitRepo(projectRoot: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], projectRoot) === "true";
}

export interface GitActivity {
  branch: string | null;
  /** "abc1234 subject" for each commit since the session began. */
  commits: string[];
  /** "M src/x.ts" for each uncommitted change. */
  changed: string[];
  /** Commits beyond MAX_COMMITS — reported, never silently dropped. */
  moreCommits: number;
  /** Changed files beyond MAX_CHANGED. */
  moreChanged: number;
}

/**
 * What happened in this repo since `since` ("YYYY-MM-DD HH:MM", as git parses
 * it). Returns null when the project is not a git repo.
 *
 * Note: commits are filtered by time, not by session, so two sessions running in
 * parallel will each report the same commits. Time is the only signal available
 * without asking the agent to tag its own work.
 */
export function activitySince(since: string, projectRoot: string): GitActivity | null {
  if (!isGitRepo(projectRoot)) return null;

  const log = git(
    ["log", `--since=${since}`, "--no-merges", "--format=%h %s"],
    projectRoot
  );
  const allCommits = log ? log.split("\n").filter(Boolean) : [];

  const status = git(["status", "--porcelain"], projectRoot);
  const allChanged = (status ? status.split("\n") : [])
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2).trim(), file: line.slice(3).trim() }))
    // Writing the handoff dirties .repomem/ itself; listing that back is noise.
    .filter(({ file }) => !file.startsWith(".repomem/") && !file.startsWith(".repomem\\"))
    .map(({ code, file }) => `${code} ${file}`);

  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], projectRoot),
    commits: allCommits.slice(0, MAX_COMMITS),
    changed: allChanged.slice(0, MAX_CHANGED),
    moreCommits: Math.max(0, allCommits.length - MAX_COMMITS),
    moreChanged: Math.max(0, allChanged.length - MAX_CHANGED),
  };
}
