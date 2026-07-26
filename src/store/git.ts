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

/** Current HEAD, or null in an empty repo or outside one. */
export function headHash(projectRoot: string): string | null {
  return git(["rev-parse", "HEAD"], projectRoot);
}

function isKnownCommit(ref: string, projectRoot: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], projectRoot) !== null;
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
 * it), or — far better — since the commit `sinceRef` when one is known.
 *
 * Prefer the ref. `--since` resolves to minute granularity, so a commit made in
 * the same minute as the marker falls inside the window every time it is
 * consulted and gets reported as new forever. `sinceRef..HEAD` is exact.
 *
 * With neither available, commits are matched by time alone, so two sessions
 * running in parallel each report the same ones — time is the only signal there
 * is without asking agents to tag their own work.
 */
export function activitySince(
  since: string,
  projectRoot: string,
  sinceRef?: string
): GitActivity | null {
  if (!isGitRepo(projectRoot)) return null;

  const useRef = sinceRef && isKnownCommit(sinceRef, projectRoot);
  const log = git(
    useRef
      ? ["log", `${sinceRef}..HEAD`, "--no-merges", "--format=%h %s"]
      : ["log", `--since=${since}`, "--no-merges", "--format=%h %s"],
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

// How much history to sample when inferring conventions. Enough to be
// representative, small enough that scanning a huge repo stays instant.
const CONVENTION_SAMPLE = 200;
const HOTSPOT_SAMPLE = 300;
const TOP_HOTSPOTS = 8;

const CONVENTIONAL_COMMIT =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?:\s/;

export interface RepoConventions {
  /** Commits sampled. 0 means an empty repo or no git. */
  sampled: number;
  /** Share of sampled subjects following Conventional Commits, 0–1. */
  conventionalShare: number;
  /** Most-used commit types, most frequent first. */
  topTypes: string[];
  /** Most recent release tags, newest first. */
  tags: string[];
  /** Files changed most often — where an agent should tread carefully. */
  hotspots: string[];
}

/**
 * Conventions a repo demonstrates rather than documents: how commits are
 * written, how releases are tagged, and which files churn. All inferred from
 * history, so there is nothing for a human to have kept up to date.
 */
export function repoConventions(projectRoot: string): RepoConventions | null {
  if (!isGitRepo(projectRoot)) return null;

  const log = git(
    ["log", `-n${CONVENTION_SAMPLE}`, "--no-merges", "--format=%s"],
    projectRoot
  );
  const subjects = log ? log.split("\n").filter(Boolean) : [];

  const types = new Map<string, number>();
  let conventional = 0;
  for (const subject of subjects) {
    const m = subject.match(CONVENTIONAL_COMMIT);
    if (!m) continue;
    conventional += 1;
    types.set(m[1], (types.get(m[1]) ?? 0) + 1);
  }

  const tagOut = git(["tag", "--sort=-creatordate"], projectRoot);
  const tags = tagOut ? tagOut.split("\n").filter(Boolean).slice(0, 3) : [];

  // --name-only with an empty format yields just the touched paths.
  const names = git(
    ["log", `-n${HOTSPOT_SAMPLE}`, "--no-merges", "--name-only", "--format="],
    projectRoot
  );
  const churn = new Map<string, number>();
  for (const file of (names ? names.split("\n") : []).map((f) => f.trim())) {
    if (!file || file.startsWith(".repomem/")) continue;
    churn.set(file, (churn.get(file) ?? 0) + 1);
  }

  return {
    sampled: subjects.length,
    conventionalShare: subjects.length ? conventional / subjects.length : 0,
    topTypes: [...types.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 5),
    tags,
    hotspots: [...churn.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_HOTSPOTS)
      .map(([file, n]) => `${file} (${n})`),
  };
}
