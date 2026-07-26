/**
 * Per-session identity for the sessions/ memory type.
 *
 * A session used to be identified by its date alone, so everything written on
 * one day landed in one appended file. Two agents — or two teammates — working
 * the same day interleaved into a single unreadable narrative and conflicted on
 * every merge. Each session now owns one file:
 *
 *     sessions/YYYY-MM-DD-HHMM-<name>.md
 *
 * The timestamp is the session's *start*, so it stays put across appends, and
 * being zero-padded it makes filename order chronological order.
 *
 * The MCP server is stdio-spawned per client session, so module state here lives
 * exactly as long as the session it describes.
 */
import * as fs from "fs";
import * as path from "path";

import { getRepomemRoot } from "../store/file-store.js";
import { clock, slugify, timestamp, today } from "./util.js";

export const DEFAULT_SESSION_NAME = "untitled";
export const UNKNOWN_AGENT = "unknown";

export interface SessionState {
  /** YYYY-MM-DD the session started. */
  date: string;
  /** HHMM the session started. */
  time: string;
  /** Human name for the session; slugified into the filename. */
  name: string;
  /** MCP client that opened the session, e.g. "claude-code". */
  agent: string;
  /** "YYYY-MM-DD HH:MM" for the front matter. */
  startedAt: string;
  /** Filename once reserved on disk — fixed for the rest of the session. */
  filename: string | null;
}

let state: SessionState | null = null;

/** The current session, started lazily on first use. */
export function sessionState(): SessionState {
  if (!state) {
    state = {
      date: today(),
      time: clock(),
      name: DEFAULT_SESSION_NAME,
      agent: UNKNOWN_AGENT,
      startedAt: timestamp(),
      filename: null,
    };
  }
  return state;
}

/** Record which agent connected — taken from the MCP `initialize` clientInfo. */
export function setSessionAgent(agent: string): void {
  const trimmed = agent.trim();
  if (trimmed) sessionState().agent = trimmed;
}

function sessionsDir(projectRoot: string): string {
  return path.join(getRepomemRoot(projectRoot), "sessions");
}

/**
 * Candidate filename for a name, stepping past any file another session already
 * owns. Two sessions starting in the same minute would otherwise land on the
 * same path and silently braid together — the exact failure this design removes.
 */
function freeFilename(name: string, projectRoot: string, ignore: string | null): string {
  const s = sessionState();
  const base = `${s.date}-${s.time}-${slugify(name)}`;
  const dir = sessionsDir(projectRoot);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base}.md` : `${base}-${n}.md`;
    if (candidate === ignore) return candidate;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/**
 * The file this session writes to, chosen once and then fixed. Call before any
 * session write.
 */
export function reserveSessionFile(projectRoot: string): string {
  const s = sessionState();
  if (!s.filename) s.filename = freeFilename(s.name, projectRoot, null);
  return s.filename;
}

/**
 * Adopt a name for the running session. If the file was already created under
 * the old name it is renamed, so one session always maps to exactly one file.
 * Returns the current filename.
 */
export function nameSession(name: string, projectRoot: string): string {
  const s = sessionState();
  const wanted = name.trim();
  if (!wanted || slugify(wanted) === slugify(s.name)) return reserveSessionFile(projectRoot);

  const previous = s.filename;
  s.name = wanted;
  const next = freeFilename(wanted, projectRoot, previous);

  if (previous && previous !== next) {
    const dir = sessionsDir(projectRoot);
    try {
      fs.renameSync(path.join(dir, previous), path.join(dir, next));
    } catch {
      /* a locked or vanished file is not worth failing a save over */
    }
  }
  s.filename = next;
  return next;
}

/**
 * The YAML front matter for a session file. Written once, when the file is
 * created — sessions previously had none, which is why they were the only type
 * mem_context could not summarise.
 */
export function sessionFrontMatter(summary: string, s: SessionState = sessionState()): string {
  const lines = ["---", `date: ${s.date}`, `started: ${s.startedAt}`, `session: ${s.name}`];
  if (s.agent !== UNKNOWN_AGENT) lines.push(`agent: ${s.agent}`);
  if (summary) lines.push(`summary: ${summary.replace(/\n+/g, " ").trim()}`);
  lines.push("---", "");
  return lines.join("\n");
}

/** Reset session identity. Tests only — each test needs a clean session. */
export function resetSession(): void {
  state = null;
}
