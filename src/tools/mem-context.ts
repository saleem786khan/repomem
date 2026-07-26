import {
  listFiles,
  readFile,
  counts,
  isInitialized,
  summaryOf,
  MemoryType,
} from "../store/file-store.js";
import { loadConfig } from "../config/config.js";
import { ToolDef } from "./util.js";

/** Strip YAML front matter for cleaner inlining. */
function body(raw: string): string {
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const after = raw.indexOf("\n", end + 1);
      return after !== -1 ? raw.slice(after + 1).trim() : "";
    }
  }
  return raw.trim();
}

function firstHeading(raw: string, fallback: string): string {
  const m = raw.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

// A session file accumulates every handoff appended during one day, so inlining
// it whole makes session-start context grow without bound. Above this many lines
// we keep only the forward-looking part.
const SESSION_INLINE_MAX_LINES = 24;
const SESSION_SECTION_RE = /^\*\*(Done|Next|Blockers):\*\*\s*$/;

/**
 * The part of the newest session worth inlining: its most recent handoff block,
 * and — once that runs long — the summary plus `Next`/`Blockers` only. `Done` is
 * history the next session can pull with mem_get; `Next` is why we inline at all.
 */
function latestSessionEntry(raw: string): string {
  const text = body(raw);
  const cut = text.lastIndexOf("\n## ");
  const block = (cut === -1 ? text : text.slice(cut + 1)).trim();

  const lines = block.split("\n");
  if (lines.length <= SESSION_INLINE_MAX_LINES) return block;

  const kept: string[] = [];
  let section: string | null = null;
  for (const line of lines) {
    const m = line.match(SESSION_SECTION_RE);
    if (m) section = m[1];
    if (section === "Done") continue;
    kept.push(line);
  }
  return (
    kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() +
    "\n\n_Trimmed — full session via mem_get._"
  );
}

/** "0917 auth-refactor" from 2026-07-26-0917-auth-refactor.md; filename otherwise. */
function sessionLabel(filename: string): string {
  const m = filename.match(/^\d{4}-\d{2}-\d{2}-(\d{4})-(.+)\.md$/);
  return m ? `${m[1]} ${m[2]}` : filename.replace(/\.md$/, "");
}

/** A scalar front-matter field, or "". */
function fmField(raw: string, key: string): string {
  const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : "";
}

function readNewest(
  type: MemoryType,
  projectRoot: string,
  limit: number
): { filename: string; raw: string }[] {
  return listFiles(type, projectRoot)
    .slice(0, limit)
    .map((filename) => ({ filename, raw: readFile(type, filename, projectRoot) ?? "" }));
}

export const memContext: ToolDef = {
  name: "mem_context",
  description:
    "Assemble a full project context packet at the start of a session: the latest " +
    "session notes, all patterns, open issues, the 5 most recent decisions, and " +
    "workspace context. Call this first so you don't have to re-explain the project. " +
    "Set brief=true for a one-paragraph summary.",
  inputSchema: {
    type: "object",
    properties: {
      brief: {
        type: "boolean",
        description: "Return a compact one-paragraph summary instead of the full packet.",
      },
    },
  },
  handler(args, projectRoot) {
    if (!isInitialized(projectRoot)) {
      return "✖ .repomem/ not found. Run `repomem init` in your project first.";
    }
    const config = loadConfig(projectRoot);
    const c = counts(projectRoot);

    if (args.brief === true) {
      const latestSession = readNewest("sessions", projectRoot, 1)[0];
      const last = latestSession
        ? firstHeading(latestSession.raw, latestSession.filename)
        : "no sessions yet";
      return (
        `${config.project}: ${c.decisions} decisions, ${c.patterns} patterns, ` +
        `${c.issues} issues, ${c.sessions} sessions. Last session: ${last}.`
      );
    }

    // Full packet, but token-lean: the latest session's most recent handoff is
    // inlined (it holds the "what's next"); everything else is a one-line summary
    // the agent can expand on demand with mem_get. Keeps session-start small.
    const out: string[] = [];
    out.push(`# Context for ${config.project}`, "");

    // Latest session — most recent handoff block, trimmed when it runs long.
    const sessions = readNewest("sessions", projectRoot, 6);
    const session = sessions[0];
    out.push("## Last session");
    if (session) {
      const agent = fmField(session.raw, "agent");
      out.push(
        `### ${sessionLabel(session.filename)}${agent ? ` (${agent})` : ""}  ·  sessions/${session.filename}`
      );
      out.push("");
      out.push(latestSessionEntry(session.raw));
    } else {
      out.push("_none yet_");
    }
    out.push("");

    // Other sessions from the same day — parallel agents or teammates. Named,
    // not inlined: knowing they happened matters, reading them all does not.
    const day = session ? session.filename.slice(0, 10) : "";
    const alsoToday = sessions.slice(1).filter((s) => s.filename.startsWith(day));
    if (alsoToday.length) {
      out.push("## Also today");
      for (const s of alsoToday) {
        const agent = fmField(s.raw, "agent");
        out.push(
          `- ${sessionLabel(s.filename)}${agent ? ` (${agent})` : ""} — ${summaryOf(s.raw, s.filename)}`
        );
      }
      out.push("");
    }

    const summaryList = (type: MemoryType, heading: string, limit: number) => {
      out.push(`## ${heading}`);
      const entries = readNewest(type, projectRoot, limit);
      if (entries.length === 0) out.push("_none yet_");
      for (const e of entries) {
        out.push(`- ${firstHeading(e.raw, e.filename)} — ${summaryOf(e.raw, e.filename)}  (${type}/${e.filename})`);
      }
      out.push("");
    };

    summaryList("decisions", "Recent decisions", 5);
    summaryList("patterns", "Patterns", 100);
    summaryList("issues", "Known issues", 100);

    out.push("_Expand any entry with mem_get(\"type/filename\"). Search with mem_search._");

    // Workspace pointer.
    if (config.workspace || config.linked.length) {
      out.push("");
      out.push("## Linked context");
      if (config.workspace) out.push(`- workspace: ${config.workspace}`);
      for (const l of config.linked) {
        out.push(`- ${l.repo}${l.relation ? ` (${l.relation})` : ""}`);
      }
      out.push("_Use mem_search with linked=true to search these._");
    }

    return out.join("\n").trim();
  },
};
