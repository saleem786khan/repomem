import * as fs from "fs";
import * as path from "path";
import { findProjectRoot, loadConfig, RepomemConfig } from "../config/config.js";

export type MemoryType = "decisions" | "sessions" | "patterns" | "issues";

export const MEMORY_TYPES: MemoryType[] = [
  "decisions",
  "sessions",
  "patterns",
  "issues",
];

export const REPOMEM_DIR = ".repomem";
export const INDEX_FILENAME = "REPOMEM.md";

export interface SearchResult {
  file: string;
  scope: string; // [current] | [linked:name] | [workspace]
  title: string;
  excerpt: string;
  score: number;
}

/** Absolute path to the .repomem/ dir for a given project root. */
export function getRepomemRoot(projectRoot: string = findProjectRoot()): string {
  return path.join(projectRoot, REPOMEM_DIR);
}

/** True if .repomem/ exists at the project root. */
export function isInitialized(projectRoot: string = findProjectRoot()): boolean {
  return fs.existsSync(getRepomemRoot(projectRoot));
}

/**
 * List relative file paths (from .repomem/) of a given memory type, sorted
 * newest-first by filename. Returns [] when uninitialised or empty.
 */
export function listFiles(
  type: MemoryType,
  projectRoot: string = findProjectRoot()
): string[] {
  const dir = path.join(getRepomemRoot(projectRoot), type);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Read a memory file by type + filename. Returns null when missing. */
export function readFile(
  type: MemoryType,
  filename: string,
  projectRoot: string = findProjectRoot()
): string | null {
  const filePath = path.join(getRepomemRoot(projectRoot), type, filename);
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write (or append) a memory file. Creates the type dir if needed.
 * Returns the absolute path written.
 */
export function writeFile(
  type: MemoryType,
  filename: string,
  content: string,
  opts: { append?: boolean } = {},
  projectRoot: string = findProjectRoot()
): string {
  const dir = path.join(getRepomemRoot(projectRoot), type);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  if (opts.append && fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, content, "utf8");
  } else {
    fs.writeFileSync(filePath, content, "utf8");
  }
  return filePath;
}

/** Strip YAML front matter and return { meta, body }. */
function splitFrontMatter(raw: string): { body: string } {
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const after = raw.indexOf("\n", end + 1);
      return { body: after !== -1 ? raw.slice(after + 1) : "" };
    }
  }
  return { body: raw };
}

/** Best-effort title: first markdown H1, else the filename. */
function titleOf(raw: string, filename: string): string {
  const m = raw.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : filename.replace(/\.md$/, "");
}

/**
 * Full-text search across all memory types in a single project root.
 * Naive case-insensitive term scoring — good enough for plain-markdown stores.
 */
function searchInRoot(
  query: string,
  scope: string,
  projectRoot: string
): SearchResult[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  const results: SearchResult[] = [];
  for (const type of MEMORY_TYPES) {
    for (const filename of listFiles(type, projectRoot)) {
      const raw = readFile(type, filename, projectRoot);
      if (raw == null) continue;
      const haystack = raw.toLowerCase();
      let score = 0;
      for (const term of terms) {
        let idx = haystack.indexOf(term);
        while (idx !== -1) {
          score += 1;
          idx = haystack.indexOf(term, idx + term.length);
        }
      }
      if (score === 0) continue;

      const { body } = splitFrontMatter(raw);
      const excerpt = makeExcerpt(body, terms);
      results.push({
        file: `${type}/${filename}`,
        scope,
        title: titleOf(raw, filename),
        excerpt,
        score,
      });
    }
  }
  return results;
}

/** Pull a short window of text around the first matched term. */
function makeExcerpt(body: string, terms: string[]): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let pos = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  if (pos === -1) return flat.slice(0, 160);
  const start = Math.max(0, pos - 60);
  const end = Math.min(flat.length, pos + 100);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

/**
 * Search the current repo and, when `includeLinked`, all linked repos and the
 * workspace declared in repomem.config.json. Returns max 10 results, ranked.
 */
export function searchFiles(
  query: string,
  projectRoot: string = findProjectRoot()
): SearchResult[] {
  return searchInRoot(query, "[current]", projectRoot)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

export function searchAllRepos(
  query: string,
  projectRoot: string = findProjectRoot(),
  config: RepomemConfig = loadConfig(projectRoot)
): SearchResult[] {
  const all: SearchResult[] = [];
  all.push(...searchInRoot(query, "[current]", projectRoot));

  for (const link of config.linked) {
    const linkedRoot = path.resolve(projectRoot, link.repo);
    if (isInitialized(linkedRoot)) {
      const name = path.basename(linkedRoot);
      all.push(...searchInRoot(query, `[linked:${name}]`, linkedRoot));
    }
  }

  if (config.workspace) {
    const wsRoot = path.resolve(projectRoot, config.workspace);
    if (isInitialized(wsRoot)) {
      all.push(...searchInRoot(query, "[workspace]", wsRoot));
    }
  }

  return all.sort((a, b) => b.score - a.score).slice(0, 10);
}

/** Counts of each memory type — used by `status` and the index. */
export function counts(
  projectRoot: string = findProjectRoot()
): Record<MemoryType, number> {
  const out = {} as Record<MemoryType, number>;
  for (const type of MEMORY_TYPES) out[type] = listFiles(type, projectRoot).length;
  return out;
}

/**
 * Regenerate REPOMEM.md — a human- and agent-readable index of everything in
 * .repomem/. Returns the absolute path written, or null when uninitialised.
 */
export function generateIndex(
  projectRoot: string = findProjectRoot()
): string | null {
  if (!isInitialized(projectRoot)) return null;
  const config = loadConfig(projectRoot);
  const lines: string[] = [];
  lines.push(`# ${config.project} — repomem index`);
  lines.push("");
  lines.push("_Auto-generated by repomem. Do not edit by hand._");
  lines.push("");

  for (const type of MEMORY_TYPES) {
    const files = listFiles(type, projectRoot);
    lines.push(`## ${type} (${files.length})`);
    if (files.length === 0) {
      lines.push("");
      lines.push("_none yet_");
    } else {
      for (const filename of files) {
        const raw = readFile(type, filename, projectRoot) ?? "";
        lines.push(`- [${titleOf(raw, filename)}](${type}/${filename})`);
      }
    }
    lines.push("");
  }

  const indexPath = path.join(getRepomemRoot(projectRoot), INDEX_FILENAME);
  fs.writeFileSync(indexPath, lines.join("\n"), "utf8");
  return indexPath;
}
