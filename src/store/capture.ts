/**
 * Unattended session capture.
 *
 * repomem's oldest gap is that nothing is recorded unless someone remembers to
 * ask. MCP servers are passive, so the fix cannot live in the server — it has to
 * be something the harness fires. `repomem capture` is that something: a
 * standalone command an agent hook (or a cron, or a shell alias) can run to
 * record what happened, with no model in the loop.
 *
 * It runs in its own process, so it has no session to measure from. A marker
 * under .repomem/.cache/ records when it last ran, and that becomes the window.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { getRepomemRoot } from "./file-store.js";
import { activitySince, headHash } from "./git.js";

const MARKER = "last-capture.json";
/** First run has no marker. Look back far enough to catch a day's work. */
const COLD_START_HOURS = 12;

function cacheDir(projectRoot: string): string {
  return path.join(getRepomemRoot(projectRoot), ".cache");
}

/** Format for git's --since and our own front matter: "YYYY-MM-DD HH:MM". */
function stamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export interface CaptureMarker {
  at: string;
  /** Digest of the uncommitted file set at the last capture. */
  fingerprint: string;
  /**
   * HEAD at the last capture. Commits are counted as `head..HEAD`, which is
   * exact — `--since` only resolves to the minute, so a commit made in the same
   * minute as the marker looks new on every later run.
   */
  head?: string;
}

export function readMarker(projectRoot: string): CaptureMarker {
  try {
    const raw = fs.readFileSync(path.join(cacheDir(projectRoot), MARKER), "utf8");
    const parsed = JSON.parse(raw) as Partial<CaptureMarker>;
    if (parsed.at) {
      return { at: parsed.at, fingerprint: parsed.fingerprint ?? "", head: parsed.head };
    }
  } catch {
    /* never captured here, or the marker is unreadable */
  }
  return {
    at: stamp(new Date(Date.now() - COLD_START_HOURS * 60 * 60 * 1000)),
    fingerprint: "",
  };
}

/**
 * Record that capture ran. The cache is gitignored — a marker is local state
 * about this machine, not memory to share with the team.
 */
export function writeMarker(projectRoot: string, marker: CaptureMarker): void {
  const dir = cacheDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "# repomem local cache — do not commit\n*\n", "utf8");
  }
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(marker, null, 2) + "\n", "utf8");
}

function fingerprintOf(changed: string[]): string {
  if (!changed.length) return "";
  return crypto.createHash("sha1").update([...changed].sort().join("\n")).digest("hex");
}

export interface CapturePlan {
  since: string;
  summary: string;
  /** False when there is nothing new — capture must then write nothing at all. */
  worthWriting: boolean;
  /** Marker to persist once the capture has been written. */
  marker: CaptureMarker;
}

/**
 * What an unattended capture would record.
 *
 * Commits are events: anything inside the window is new by definition. Uncommitted
 * files are *state* — they survive from one capture to the next, so writing a
 * session every time any exist would fill sessions/ with near-identical files.
 * They therefore only justify a capture when the set has actually changed, which
 * is what the fingerprint tracks.
 *
 * A summary assembled from git facts is a poor substitute for one written with
 * judgement, so it says so plainly rather than pretending to understand the work.
 */
export function planCapture(projectRoot: string, now: Date = new Date()): CapturePlan {
  const previous = readMarker(projectRoot);
  const activity = activitySince(previous.at, projectRoot, previous.head);
  const fingerprint = fingerprintOf(activity?.changed ?? []);
  const marker: CaptureMarker = {
    at: stamp(now),
    fingerprint,
    head: headHash(projectRoot) ?? undefined,
  };

  if (!activity) return { since: previous.at, summary: "", worthWriting: false, marker };

  const newCommits = activity.commits.length > 0;
  const changedSet = activity.changed.length > 0 && fingerprint !== previous.fingerprint;
  if (!newCommits && !changedSet) {
    return { since: previous.at, summary: "", worthWriting: false, marker };
  }

  const parts: string[] = [];
  if (activity.commits.length) {
    const n = activity.commits.length + activity.moreCommits;
    parts.push(`${n} commit${n === 1 ? "" : "s"}`);
  }
  if (activity.changed.length) {
    const n = activity.changed.length + activity.moreChanged;
    parts.push(`${n} file${n === 1 ? "" : "s"} left uncommitted`);
  }

  return {
    since: previous.at,
    summary:
      `Auto-captured from git — ${parts.join(", ")}` +
      `${activity.branch ? ` on ${activity.branch}` : ""}. ` +
      "No summary was written by hand, so the intent behind this work is not recorded.",
    worthWriting: true,
    marker,
  };
}
