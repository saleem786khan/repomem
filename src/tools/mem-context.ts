import {
  listFiles,
  readFile,
  counts,
  isInitialized,
  isRetired,
  scoreEntries,
  summaryOf,
  MemoryType,
} from "../store/file-store.js";
import { loadConfig } from "../config/config.js";
import { readProfile } from "../store/profile.js";
import { ToolDef } from "./util.js";

// The profile is the cheapest thing in the packet and the most reused — stack,
// commands, layout. A typical one runs ~30 lines including churn hotspots, so
// the cap sits above that; it exists to stop a sprawling monorepo dominating.
const PROFILE_MAX_LINES = 45;

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

// Rough enough to budget with: ~4 characters per token for English prose.
const CHARS_PER_TOKEN = 4;

// Ceiling per type even with no budget set. Patterns and issues were previously
// capped at 100, which is no cap at all — a long-lived repo turned the packet
// into a wall of text, defeating the point of loading it every session.
const MAX_ENTRIES_PER_TYPE = 20;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * How a budget is split before entries get what's left.
 *
 * Without these, the profile and session — which are emitted first — consume the
 * whole budget on a tight setting and the packet arrives with no memory in it at
 * all. That is the least useful trade available: the caller asked for context and
 * got a directory listing.
 */
const PROFILE_SHARE = 0.25;
const SESSION_SHARE = 0.35;

/** Drop whole lines from the end until the text fits, then say that it was cut. */
function trimToTokens(text: string, maxTokens: number, note: string): string {
  if (maxTokens <= 0 || estimateTokens(text) <= maxTokens) return text;
  const lines = text.split("\n");
  while (lines.length > 1 && estimateTokens(lines.join("\n") + note) > maxTokens) {
    lines.pop();
  }
  return lines.join("\n").trimEnd() + "\n\n" + note;
}

/**
 * Types that appear as summary lists, in display order. Headings differ by mode
 * because "Recent decisions" is a lie once the list is ordered by relevance.
 */
const LISTED: { type: MemoryType; heading: string; taskHeading: string }[] = [
  { type: "decisions", heading: "Recent decisions", taskHeading: "Relevant decisions" },
  { type: "patterns", heading: "Patterns", taskHeading: "Relevant patterns" },
  { type: "issues", heading: "Known issues", taskHeading: "Relevant issues" },
];

interface Candidate {
  type: MemoryType;
  filename: string;
  line: string;
  score: number;
  /** Filename, used as the recency tiebreak when scores match. */
  order: string;
}

/**
 * Every listed entry as a one-line candidate, ranked.
 *
 * With a `task`, ranking is BM25 relevance to that task — the same scoring
 * mem_search uses — so a packet carries what bears on the work at hand rather
 * than whatever happens to be newest. Entries that do not match the task keep a
 * zero score and fall back to recency order, so nothing is hidden outright;
 * it is only pushed down.
 *
 * Retired entries — superseded decisions, resolved issues — are excluded and
 * counted instead: a packet loaded every session must not keep re-teaching
 * knowledge the repo has already moved past.
 */
function rankCandidates(
  task: string,
  projectRoot: string
): { candidates: Candidate[]; retired: number } {
  const scores = new Map<string, number>();
  if (task) {
    for (const entry of scoreEntries(task, projectRoot)) {
      scores.set(entry.file, entry.score);
    }
  }

  let retired = 0;
  const candidates: Candidate[] = [];
  for (const { type } of LISTED) {
    for (const filename of listFiles(type, projectRoot)) {
      const raw = readFile(type, filename, projectRoot) ?? "";
      if (isRetired(raw)) {
        retired++;
        continue;
      }
      candidates.push({
        type,
        filename,
        line: `- ${firstHeading(raw, filename)} — ${summaryOf(raw, filename)}  (${type}/${filename})`,
        score: scores.get(`${type}/${filename}`) ?? 0,
        order: filename,
      });
    }
  }

  candidates.sort((a, b) =>
    b.score === a.score ? b.order.localeCompare(a.order) : b.score - a.score
  );
  return { candidates, retired };
}

export const memContext: ToolDef = {
  name: "mem_context",
  description:
    "Assemble a project context packet at the start of a session: the project " +
    "profile (stack, commands, layout), the latest session's handoff, and one-line " +
    "summaries of decisions, patterns, and issues. Call this first so you don't have " +
    "to re-explain the project. Pass task='what you are about to do' to rank memory " +
    "by relevance instead of recency, and budget=<tokens> to cap the packet. " +
    "Set brief=true for a one-paragraph summary.",
  inputSchema: {
    type: "object",
    properties: {
      brief: {
        type: "boolean",
        description: "Return a compact one-paragraph summary instead of the full packet.",
      },
      task: {
        type: "string",
        description:
          "What this session is about, e.g. 'add rate limiting to the payments API'. " +
          "Ranks memory by relevance to it instead of by recency — worth setting on " +
          "any repo with more than a handful of entries.",
      },
      budget: {
        type: "number",
        description:
          "Approximate token ceiling for the packet. Entries past the ceiling are " +
          "dropped lowest-relevance first, and the count dropped is always reported.",
      },
    },
  },
  handler(args, projectRoot) {
    if (!isInitialized(projectRoot)) {
      return "✖ .repomem/ not found. Run `repomem init` in your project first.";
    }
    const config = loadConfig(projectRoot);
    const c = counts(projectRoot);

    const brief = () => {
      const latestSession = readNewest("sessions", projectRoot, 1)[0];
      const last = latestSession
        ? firstHeading(latestSession.raw, latestSession.filename)
        : "no sessions yet";
      return (
        `${config.project}: ${c.decisions} decisions, ${c.patterns} patterns, ` +
        `${c.issues} issues, ${c.sessions} sessions. Last session: ${last}.`
      );
    };

    if (args.brief === true) return brief();

    // Full packet, but token-lean: the latest session's most recent handoff is
    // inlined (it holds the "what's next"); everything else is a one-line summary
    // the agent can expand on demand with mem_get. Keeps session-start small.
    const task = typeof args.task === "string" ? args.task.trim() : "";
    const budget = typeof args.budget === "number" && args.budget > 0 ? args.budget : 0;

    const out: string[] = [];
    out.push(`# Context for ${config.project}`, "");

    // Project profile first: stack, commands, layout. Without it an agent
    // re-derives the same facts by globbing the tree every single session.
    const profile = readProfile(projectRoot);
    if (profile) {
      const lines = profile
        .split("\n")
        .filter((l) => !l.startsWith("# ") && !l.startsWith("_Auto-generated"))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .split("\n");
      const note = "_Profile trimmed — full text in .repomem/project.md._";
      let text = lines.slice(0, PROFILE_MAX_LINES).join("\n");
      if (lines.length > PROFILE_MAX_LINES) text += `\n\n${note}`;
      if (budget) text = trimToTokens(text, budget * PROFILE_SHARE, note);
      out.push(text, "");
    }

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
      const entry = latestSessionEntry(session.raw);
      out.push(
        budget
          ? trimToTokens(entry, budget * SESSION_SHARE, "_Trimmed — full session via mem_get._")
          : entry
      );
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

    // The prelude is capped by its shares above, so what's left here is real —
    // provided the structural text still to come is also paid for. Headings and
    // closing notes are emitted after the entries are chosen, so reserve them
    // now or the packet overshoots by however much they cost.
    const { candidates: ranked, retired } = rankCandidates(task, projectRoot);

    // The per-type cap binds during selection, not at render time: capping while
    // printing would drop entries that were never counted as dropped.
    const eligible: Candidate[] = [];
    const perType = new Map<MemoryType, number>();
    for (const candidate of ranked) {
      if ((perType.get(candidate.type) ?? 0) >= MAX_ENTRIES_PER_TYPE) continue;
      perType.set(candidate.type, (perType.get(candidate.type) ?? 0) + 1);
      eligible.push(candidate);
    }

    const prelude = out.slice();
    const render = (kept: Candidate[]): string => {
      const lines = prelude.slice();
      const dropped = ranked.length - kept.length;
      if (task) lines.push(`_Ranked by relevance to: ${task}_`, "");

      for (const { type, heading, taskHeading } of LISTED) {
        const forType = kept.filter((k) => k.type === type);
        lines.push(`## ${task ? taskHeading : heading}`);
        if (forType.length === 0) {
          lines.push(c[type] === 0 ? "_none yet_" : "_none fit the budget — see below_");
        }
        for (const entry of forType) lines.push(entry.line);
        lines.push("");
      }

      // Never truncate silently: a packet that omits things without saying so
      // reads as "this is everything", which is worse than being verbose.
      if (dropped > 0) {
        lines.push(
          `_${dropped} further ${dropped === 1 ? "entry" : "entries"} not shown` +
            `${budget ? ` (token budget ${budget})` : ""} — find them with mem_search._`
        );
      }
      if (retired > 0) {
        lines.push(
          `_${retired} retired ${retired === 1 ? "entry" : "entries"} (superseded or ` +
            "resolved) hidden — mem_search still finds them._"
        );
      }
      lines.push('_Expand any entry with mem_get("type/filename"). Search with mem_search._');

      if (config.workspace || config.linked.length) {
        lines.push("", "## Linked context");
        if (config.workspace) lines.push(`- workspace: ${config.workspace}`);
        for (const l of config.linked) {
          lines.push(`- ${l.repo}${l.relation ? ` (${l.relation})` : ""}`);
        }
        lines.push("_Use mem_search with linked=true to search these._");
      }
      return lines.join("\n").trim();
    };

    // Measure the real packet and shed the lowest-ranked entry until it fits.
    // Estimating the cost of headings, placeholders, and separators up front got
    // this wrong by ~13 tokens and silently degraded whole packets to the brief
    // form; rendering and measuring cannot drift the same way.
    let kept = eligible;
    let packet = render(kept);
    while (budget && kept.length > 0 && estimateTokens(packet) > budget) {
      kept = kept.slice(0, kept.length - 1);
      packet = render(kept);
    }

    // A packet has a floor — header, a slice of profile and session, headings,
    // notes. Below it, honour the budget by degrading to the brief form rather
    // than quietly handing back more than was asked for.
    if (budget && estimateTokens(packet) > budget) {
      return (
        brief() +
        `\n\n_A full packet needs ~${estimateTokens(packet)} tokens but the budget was ` +
        `${budget}. Raise it, or use mem_search for specifics._`
      );
    }

    return packet;
  },
};
