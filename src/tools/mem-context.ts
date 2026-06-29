import {
  listFiles,
  readFile,
  counts,
  isInitialized,
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

    const out: string[] = [];
    out.push(`# Context for ${config.project}`, "");

    // Latest session.
    const session = readNewest("sessions", projectRoot, 1)[0];
    out.push("## Last session");
    out.push(session ? `### ${session.filename}\n\n${body(session.raw)}` : "_none yet_");
    out.push("");

    // Recent decisions (max 5).
    out.push("## Recent decisions");
    const decisions = readNewest("decisions", projectRoot, 5);
    if (decisions.length === 0) out.push("_none yet_");
    for (const d of decisions) {
      out.push(`### ${firstHeading(d.raw, d.filename)}  (${d.filename})`);
      out.push(body(d.raw));
      out.push("");
    }

    // All patterns.
    out.push("## Patterns");
    const patterns = readNewest("patterns", projectRoot, 100);
    if (patterns.length === 0) out.push("_none yet_");
    for (const p of patterns) {
      out.push(`### ${firstHeading(p.raw, p.filename)}`);
      out.push(body(p.raw));
      out.push("");
    }

    // Open issues.
    out.push("## Known issues");
    const issues = readNewest("issues", projectRoot, 100);
    if (issues.length === 0) out.push("_none yet_");
    for (const i of issues) {
      out.push(`### ${firstHeading(i.raw, i.filename)}`);
      out.push(body(i.raw));
      out.push("");
    }

    // Workspace pointer.
    if (config.workspace || config.linked.length) {
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
