import { readProjectDocs, counts, isInitialized } from "../store/file-store.js";
import { ToolDef } from "./util.js";

export const memPrime: ToolDef = {
  name: "mem_prime",
  description:
    "Bootstrap memory for a project that already has lots of context. Gathers " +
    "existing docs (CLAUDE.md, AGENTS.md, README, docs/**) and returns them with " +
    "instructions to distil durable decisions, patterns, and issues into memory " +
    "via mem_save. Run once when adopting repomem on an existing repo.",
  inputSchema: { type: "object", properties: {} },
  handler(_args, projectRoot) {
    if (!isInitialized(projectRoot)) {
      return "✖ .repomem/ not found. Run `repomem init` in your project first.";
    }

    const existing = counts(projectRoot);
    const total = existing.decisions + existing.patterns + existing.issues + existing.sessions;
    const docs = readProjectDocs(projectRoot);

    if (docs.length === 0) {
      return (
        "No source docs found to prime from (looked for CLAUDE.md, AGENTS.md, " +
        "GEMINI.md, README.md, docs/**.md).\n\n" +
        "Nothing to bootstrap automatically — save memories as you work with mem_save."
      );
    }

    const out: string[] = [];
    out.push("# repomem priming packet");
    out.push("");
    out.push(
      total > 0
        ? `This project already has ${total} memory ${total === 1 ? "entry" : "entries"}. Only add what is missing — do not duplicate.`
        : "This project has no memory yet. Seed it from the sources below."
    );
    out.push("");
    out.push("## Instructions");
    out.push(
      "Read the sources below and extract DURABLE, reusable project knowledge. " +
        "For each item, call mem_save with the right type:"
    );
    out.push("- decision — an architectural choice and *why* (include a `supersedes` if it replaces one)");
    out.push("- pattern — a convention/idiom to follow in this codebase");
    out.push("- issue — a known gotcha or do-not-repeat mistake");
    out.push("");
    out.push(
      "Keep each entry short and add a one-line `summary`. Link related entries with " +
        "`links`. Skip transient details, changelog noise, and anything obvious from the code."
    );
    out.push("");
    out.push("## Sources");
    for (const doc of docs) {
      out.push("", `### ${doc.rel}`, "", "```", doc.text.trimEnd(), "```");
    }
    return out.join("\n");
  },
};
