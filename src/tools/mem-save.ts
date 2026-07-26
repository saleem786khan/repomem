import * as fs from "fs";
import * as path from "path";

import {
  MemoryType,
  MEMORY_TYPES,
  writeFile,
  generateIndex,
  getRepomemRoot,
  isInitialized,
} from "../store/file-store.js";
import { ToolDef, today, timestamp, slugify, str, strArray } from "./util.js";
import { nameSession, reserveSessionFile, sessionFrontMatter } from "./session.js";

const TYPE_ALIASES: Record<string, MemoryType> = {
  decision: "decisions",
  decisions: "decisions",
  session: "sessions",
  sessions: "sessions",
  pattern: "patterns",
  patterns: "patterns",
  issue: "issues",
  issues: "issues",
};

/**
 * Write the session file's front matter the first time it is touched. Later
 * writes just append blocks, so the header reflects when the session opened.
 */
export function ensureSessionHeader(
  filename: string,
  summary: string,
  projectRoot: string
): void {
  const filePath = path.join(getRepomemRoot(projectRoot), "sessions", filename);
  if (fs.existsSync(filePath)) return;
  writeFile("sessions", filename, sessionFrontMatter(summary), {}, projectRoot);
}

export const memSave: ToolDef = {
  name: "mem_save",
  description:
    "Save a memory to .repomem/. type is one of decision|session|pattern|issue. " +
    "Use this to capture architectural decisions, reusable patterns, known issues, " +
    "or session notes so they persist with the repo and travel to teammates.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["decision", "session", "pattern", "issue"],
        description: "Kind of memory to save.",
      },
      title: { type: "string", description: "Short title for this memory." },
      content: { type: "string", description: "The memory body, in markdown." },
      summary: {
        type: "string",
        description:
          "Optional one-line summary. Surfaced by mem_context/mem_search so agents " +
          "can scan without loading the full body. Auto-derived when omitted.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for retrieval.",
      },
      links: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional slugs of related memories to link (e.g. 'use-postgres'). " +
          "Renders as [[wikilinks]] so context can traverse related entries.",
      },
      supersedes: {
        type: "string",
        description:
          "Optional filename of a prior decision this one replaces (decisions only).",
      },
      session: {
        type: "string",
        description:
          "Optional name for the running session (sessions only), e.g. 'auth-refactor'. " +
          "Names the session file so parallel sessions stay separate and findable. " +
          "Set it once; later saves reuse it.",
      },
    },
    required: ["type", "title", "content"],
  },
  handler(args, projectRoot) {
    if (!isInitialized(projectRoot)) {
      return "✖ .repomem/ not found. Run `repomem init` in your project first.";
    }

    const rawType = str(args.type).toLowerCase();
    const type = TYPE_ALIASES[rawType];
    if (!type) {
      return `✖ Unknown type "${str(args.type)}". Use one of: decision, session, pattern, issue.`;
    }

    const title = str(args.title);
    const content = str(args.content);
    if (!title) return "✖ A title is required.";
    if (!content) return "✖ Content is required.";

    const tags = strArray(args.tags);
    const supersedes = str(args.supersedes);
    const summary = str(args.summary);
    const links = strArray(args.links);
    const linkLine = links.length
      ? `\nRelated: ${links.map((l) => `[[${slugify(l)}]]`).join(" ")}\n`
      : "";

    // One file per session, appended to as the session goes. Named so that
    // parallel sessions never share a file — see ./session.ts.
    if (type === "sessions") {
      const sessionName = str(args.session);
      const filename = sessionName
        ? nameSession(sessionName, projectRoot)
        : reserveSessionFile(projectRoot);
      ensureSessionHeader(filename, summary || title, projectRoot);

      const block =
        `\n## ${timestamp()} — ${title}\n\n` +
        (tags.length ? `_tags: ${tags.join(", ")}_\n\n` : "") +
        `${content}\n${linkLine}`;
      writeFile(type, filename, block, { append: true }, projectRoot);
      generateIndex(projectRoot);
      return `✔ Appended to sessions/${filename}\n\nRemember to: git add .repomem/ && git commit`;
    }

    const filename = `${today()}-${slugify(title)}.md`;
    const fm: string[] = ["---", `date: ${today()}`];
    if (summary) fm.push(`summary: ${summary.replace(/\n+/g, " ").trim()}`);
    if (tags.length) fm.push(`tags: [${tags.join(", ")}]`);
    if (supersedes) fm.push(`supersedes: ${supersedes}`);
    fm.push("---", "");

    const body = `# ${title}\n\n${content}\n${linkLine}`;
    writeFile(type, filename, fm.join("\n") + body, {}, projectRoot);
    generateIndex(projectRoot);

    const note = supersedes ? ` (supersedes ${supersedes})` : "";
    return `✔ Saved ${type}/${filename}${note}\n\nRemember to: git add .repomem/ && git commit`;
  },
};

// Re-export for callers that want the canonical type list.
export { MEMORY_TYPES };
