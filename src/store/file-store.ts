import * as fs from "fs";
import * as path from "path";
import { findProjectRoot, loadConfig, RepomemConfig } from "../config/config.js";
import { parseRemote, remoteSlug, RemoteRef } from "./remote.js";

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

// Recency boost: a fresh doc can score up to (1 + RECENCY_WEIGHT)× a stale one,
// decaying with a ~RECENCY_HALFLIFE_DAYS half-life. Keeps yesterday's session
// ahead of a year-old note when both match equally well.
const RECENCY_WEIGHT = 0.5;
const RECENCY_HALFLIFE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Doc {
  file: string;
  type: MemoryType;
  filename: string;
  raw: string;
  counts: Map<string, number>;
  length: number;
  dateMs: number;
}

/** Best-effort timestamp for a memory: leading YYYY-MM-DD in the name, else mtime. */
function docDateMs(type: MemoryType, filename: string, projectRoot: string): number {
  const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (!Number.isNaN(t)) return t;
  }
  try {
    return fs.statSync(path.join(getRepomemRoot(projectRoot), type, filename)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Count non-overlapping occurrences of `term` in `haystack` (already lower-cased). */
function countTerm(haystack: string, term: string): number {
  let n = 0;
  let idx = haystack.indexOf(term);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(term, idx + term.length);
  }
  return n;
}

/**
 * Full-text search across all memory types in a single project root, ranked by
 * TF-IDF (rarer query terms weigh more), normalised for document length, with a
 * recency boost. Case-insensitive over plain-markdown stores.
 */
function searchInRoot(
  query: string,
  scope: string,
  projectRoot: string
): SearchResult[] {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0)
    ),
  ];
  if (terms.length === 0) return [];

  // Pass 1: load matching docs and per-term frequencies.
  const docs: Doc[] = [];
  for (const type of MEMORY_TYPES) {
    for (const filename of listFiles(type, projectRoot)) {
      const raw = readFile(type, filename, projectRoot);
      if (raw == null) continue;
      const haystack = raw.toLowerCase();
      const counts = new Map<string, number>();
      let total = 0;
      for (const term of terms) {
        const c = countTerm(haystack, term);
        if (c > 0) counts.set(term, c);
        total += c;
      }
      if (total === 0) continue;
      docs.push({
        file: `${type}/${filename}`,
        type,
        filename,
        raw,
        counts,
        length: haystack.split(/\s+/).filter(Boolean).length || 1,
        dateMs: docDateMs(type, filename, projectRoot),
      });
    }
  }
  if (docs.length === 0) return [];

  // Pass 2: document frequency per term across the matched corpus.
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docs.length;
  const now = Date.now();

  // Pass 3: score = Σ (sublinear-tf × idf), length-normalised, × recency boost.
  // Sublinear tf (1 + ln tf) stops a doc that merely repeats a common term from
  // outranking one that actually contains the rare, discriminating term.
  const results: SearchResult[] = [];
  for (const doc of docs) {
    let score = 0;
    for (const [term, tf] of doc.counts) {
      const idf = Math.log(1 + n / (1 + (df.get(term) ?? 0)));
      score += (1 + Math.log(tf)) * idf;
    }
    score /= 1 + Math.log(1 + doc.length); // dampen long documents
    const ageDays = doc.dateMs > 0 ? Math.max(0, (now - doc.dateMs) / DAY_MS) : Infinity;
    const recency = 1 + RECENCY_WEIGHT * Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS);
    score *= recency;
    if (score <= 0) continue;

    const { body } = splitFrontMatter(doc.raw);
    results.push({
      file: doc.file,
      scope,
      title: titleOf(doc.raw, doc.filename),
      excerpt: makeExcerpt(body, terms),
      score,
    });
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

/** Cache root for a pulled remote repo — a project-root-shaped dir under .repomem/.cache/. */
export function remoteCacheRoot(projectRoot: string, r: RemoteRef): string {
  return path.join(getRepomemRoot(projectRoot), ".cache", remoteSlug(r));
}

export function searchAllRepos(
  query: string,
  projectRoot: string = findProjectRoot(),
  config: RepomemConfig = loadConfig(projectRoot)
): SearchResult[] {
  const all: SearchResult[] = [];
  all.push(...searchInRoot(query, "[current]", projectRoot));

  for (const link of config.linked) {
    const remote = parseRemote(link.repo);
    if (remote) {
      // Remote repo: search the local cache populated by `repomem pull`.
      const cacheRoot = remoteCacheRoot(projectRoot, remote);
      if (isInitialized(cacheRoot)) {
        all.push(...searchInRoot(query, `[remote:${remote.name}]`, cacheRoot));
      }
      continue;
    }
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

const SECTION_RE = /^###\s+(decisions|sessions|patterns|issues)\/(.+\.md)\s*$/;

/**
 * Parse a `repomem sync` export bundle and write its files back into .repomem/.
 * The inverse of the CLI's export format — used for airgapped transfer. Returns
 * the list of `type/filename` entries written. Existing files are overwritten.
 */
export function importBundle(
  text: string,
  projectRoot: string = findProjectRoot()
): string[] {
  const lines = text.split(/\r?\n/);
  const written: string[] = [];
  let current: { type: MemoryType; filename: string; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const content =
      current.body.join("\n").replace(/^(?:[ \t]*\n)+/, "").replace(/\s*$/, "") + "\n";
    writeFile(current.type, current.filename, content, {}, projectRoot);
    written.push(`${current.type}/${current.filename}`);
    current = null;
  };

  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) {
      flush();
      current = { type: m[1] as MemoryType, filename: m[2].trim(), body: [] };
      continue;
    }
    // Skip the bundle title and per-type headers when between sections.
    if (!current && (line.startsWith("# ") || line.startsWith("## "))) continue;
    if (current) current.body.push(line);
  }
  flush();
  return written;
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
