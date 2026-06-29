import {
  MemoryType,
  MEMORY_TYPES,
  writeFile,
  generateIndex,
  isInitialized,
} from "../store/file-store.js";
import { ToolDef, today, timestamp, slugify, str, strArray } from "./util.js";

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
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for retrieval.",
      },
      supersedes: {
        type: "string",
        description:
          "Optional filename of a prior decision this one replaces (decisions only).",
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

    // Sessions are date-keyed and appended to across a single day.
    if (type === "sessions") {
      const filename = `${today()}.md`;
      const block =
        `\n## ${timestamp()} — ${title}\n\n` +
        (tags.length ? `_tags: ${tags.join(", ")}_\n\n` : "") +
        `${content}\n`;
      writeFile(type, filename, block, { append: true }, projectRoot);
      generateIndex(projectRoot);
      return `✔ Appended to sessions/${filename}\n\nRemember to: git add .repomem/ && git commit`;
    }

    const filename = `${today()}-${slugify(title)}.md`;
    const fm: string[] = ["---", `date: ${today()}`];
    if (tags.length) fm.push(`tags: [${tags.join(", ")}]`);
    if (supersedes) fm.push(`supersedes: ${supersedes}`);
    fm.push("---", "");

    const body = `# ${title}\n\n${content}\n`;
    writeFile(type, filename, fm.join("\n") + body, {}, projectRoot);
    generateIndex(projectRoot);

    const note = supersedes ? ` (supersedes ${supersedes})` : "";
    return `✔ Saved ${type}/${filename}${note}\n\nRemember to: git add .repomem/ && git commit`;
  },
};

// Re-export for callers that want the canonical type list.
export { MEMORY_TYPES };
