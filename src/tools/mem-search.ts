import { searchFiles, searchAllRepos, isInitialized } from "../store/file-store.js";
import { ToolDef, str } from "./util.js";

export const memSearch: ToolDef = {
  name: "mem_search",
  description:
    "Search across all saved memory (decisions, sessions, patterns, issues), " +
    "ranked by relevance (TF-IDF) and recency. Set linked=true to also search " +
    "linked repos (local paths and remote GitHub repos pulled via `repomem pull`) " +
    "and the workspace declared in repomem.config.json. Returns the top matches " +
    "with a short excerpt each, labelled by source scope.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search terms." },
      linked: {
        type: "boolean",
        description: "Also search linked repos and workspace. Default false.",
      },
    },
    required: ["query"],
  },
  handler(args, projectRoot) {
    if (!isInitialized(projectRoot)) {
      return "✖ .repomem/ not found. Run `repomem init` in your project first.";
    }
    const query = str(args.query);
    if (!query) return "✖ A search query is required.";

    const includeLinked = args.linked === true;
    const results = includeLinked
      ? searchAllRepos(query, projectRoot)
      : searchFiles(query, projectRoot);

    if (results.length === 0) {
      return `No memory found for "${query}".`;
    }

    const lines = [`Found ${results.length} match(es) for "${query}":`, ""];
    for (const r of results) {
      lines.push(`${r.scope} ${r.title}  ·  ${r.file}`);
      lines.push(`   ${r.excerpt}`);
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  },
};
