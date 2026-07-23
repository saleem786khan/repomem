import {
  MEMORY_TYPES,
  MemoryType,
  readFile,
  resolveLink,
  relatedOf,
  isInitialized,
} from "../store/file-store.js";
import { ToolDef, str } from "./util.js";

/** Resolve a "type/filename", bare filename, or [[slug]] to a concrete entry. */
function resolve(
  ref: string,
  projectRoot: string
): { type: MemoryType; filename: string } | null {
  const cleaned = ref.replace(/^\[\[|\]\]$/g, "").trim();
  if (cleaned.includes("/")) {
    const [type, filename] = cleaned.split("/", 2);
    if ((MEMORY_TYPES as string[]).includes(type) && filename) {
      return { type: type as MemoryType, filename };
    }
  }
  const hit = resolveLink(cleaned, projectRoot);
  return hit ? { type: hit.type, filename: hit.filename } : null;
}

export const memGet: ToolDef = {
  name: "mem_get",
  description:
    "Fetch the full text of a single memory entry by its file (e.g. " +
    "'decisions/2026-06-01-use-postgres.md'), bare filename, or [[wikilink]] slug. " +
    "Use after mem_context or mem_search to expand only the entries you actually " +
    "need — this keeps context small.",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "type/filename, a bare filename, or a [[wikilink]] slug.",
      },
    },
    required: ["file"],
  },
  handler(args, projectRoot) {
    if (!isInitialized(projectRoot)) {
      return "✖ .repomem/ not found. Run `repomem init` in your project first.";
    }
    const ref = str(args.file);
    if (!ref) return "✖ A file reference is required.";

    const target = resolve(ref, projectRoot);
    if (!target) return `✖ No memory entry matches "${ref}".`;

    const raw = readFile(target.type, target.filename, projectRoot);
    if (raw == null) return `✖ Could not read ${target.type}/${target.filename}.`;

    const related = relatedOf(raw, projectRoot);
    const out = [`# ${target.type}/${target.filename}`, "", raw.trim()];
    if (related.length) {
      out.push("", "---", "Related entries (fetch with mem_get):");
      for (const r of related) out.push(`- ${r.title}  ·  ${r.type}/${r.filename}`);
    }
    return out.join("\n");
  },
};
