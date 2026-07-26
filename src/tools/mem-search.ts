import {
  searchFiles,
  searchAllRepos,
  blendSemantic,
  isInitialized,
} from "../store/file-store.js";
import { loadConfig } from "../config/config.js";
import { semanticScores } from "../store/embeddings.js";
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
    const lexical = includeLinked
      ? searchAllRepos(query, projectRoot)
      : searchFiles(query, projectRoot);

    const semantic = loadConfig(projectRoot).semantic;
    if (!semantic) return render(lexical, query);

    // Only this branch is async, so search stays synchronous for everyone who
    // has not turned semantic search on.
    const blend = Math.min(1, Math.max(0, semantic.blend ?? 0.5));
    return semanticScores(query, projectRoot, semantic)
      .then((scores) => render(blendSemantic(lexical, scores, projectRoot, blend), query))
      .catch(() => render(lexical, query));
  },
};

function render(results: { scope: string; title: string; file: string; excerpt: string; related: string[] }[], query: string): string {
  if (results.length === 0) return `No memory found for "${query}".`;

  const lines = [`Found ${results.length} match(es) for "${query}":`, ""];
  for (const r of results) {
    lines.push(`${r.scope} ${r.title}  ·  ${r.file}`);
    lines.push(`   ${r.excerpt}`);
    if (r.related.length) lines.push(`   → related: ${r.related.join(", ")}`);
    lines.push("");
  }
  lines.push('_Expand any entry with mem_get("type/filename")._');
  return lines.join("\n").trimEnd();
}
