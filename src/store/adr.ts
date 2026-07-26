/**
 * Import Architecture Decision Records that a repo already has.
 *
 * A project with docs/adr/0001-use-postgres.md is not a project without
 * decisions — it is a project whose decisions repomem cannot see. These are
 * already structured and already authored, so they are copied in directly. No
 * model, no distillation, no judgement required.
 *
 * Prose docs (README, ARCHITECTURE) still need an agent to distil — that is what
 * mem_prime is for. This handles only the part that is already decision-shaped.
 */
import * as fs from "fs";
import * as path from "path";

import { listFiles, readFile, writeFile, MemoryType } from "./file-store.js";

// Where ADRs conventionally live. Checked in order; all matches are imported.
const ADR_DIRS = [
  "docs/adr",
  "docs/adrs",
  "docs/decisions",
  "docs/architecture/decisions",
  "adr",
  "adrs",
  "decisions",
  "rfcs",
  "docs/rfcs",
];

const MAX_ADRS = 50;
const MAX_BODY_CHARS = 8000;

export interface AdrCandidate {
  /** Repo-relative source path. */
  rel: string;
  title: string;
  status: string;
  date: string;
  body: string;
}

/** First markdown H1, else a title derived from the filename. */
function titleOf(raw: string, filename: string): string {
  const h1 = raw.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return filename
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_]/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

/** MADR and Nygard both record a status line; missing is fine. */
function statusOf(raw: string): string {
  const fm = raw.match(/^status:\s*(.+)$/im);
  if (fm) return fm[1].trim().replace(/^["']|["']$/g, "");
  const heading = raw.match(/^##\s*Status\s*\n+([^\n#]+)/im);
  return heading ? heading[1].trim() : "";
}

function dateOf(raw: string, filePath: string): string {
  const fm = raw.match(/^date:\s*(\d{4}-\d{2}-\d{2})/im);
  if (fm) return fm[1];
  const inText = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (inText) return inText[1];
  try {
    return new Date(fs.statSync(filePath).mtime).toISOString().slice(0, 10);
  } catch {
    return "1970-01-01";
  }
}

/** Strip YAML front matter so the imported body starts at real content. */
function stripFrontMatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  const after = raw.indexOf("\n", end + 1);
  return after === -1 ? "" : raw.slice(after + 1);
}

/** Find ADR-shaped markdown files anywhere the ecosystem conventionally puts them. */
export function findAdrs(projectRoot: string): AdrCandidate[] {
  const found: AdrCandidate[] = [];
  const seen = new Set<string>();

  for (const dir of ADR_DIRS) {
    const abs = path.join(projectRoot, dir);
    let entries: string[];
    try {
      entries = fs.readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (found.length >= MAX_ADRS) return found;
      if (!/\.md$/i.test(name)) continue;
      // Index and template files are scaffolding, not decisions.
      if (/^(readme|index|template|_template|0000)/i.test(name)) continue;

      const filePath = path.join(abs, name);
      const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
      if (!raw.trim()) continue;

      const rel = path.join(dir, name).replace(/\\/g, "/");
      if (seen.has(rel)) continue;
      seen.add(rel);

      found.push({
        rel,
        title: titleOf(raw, name),
        status: statusOf(raw),
        date: dateOf(raw, filePath),
        body: stripFrontMatter(raw).trim().slice(0, MAX_BODY_CHARS),
      });
    }
  }
  return found;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "adr"
  );
}

/** Source paths already imported, read back from `source:` front matter. */
function importedSources(projectRoot: string): Set<string> {
  const sources = new Set<string>();
  for (const filename of listFiles("decisions" as MemoryType, projectRoot)) {
    const raw = readFile("decisions" as MemoryType, filename, projectRoot) ?? "";
    const m = raw.match(/^source:\s*(.+)$/m);
    if (m) sources.add(m[1].trim());
  }
  return sources;
}

export interface AdrImportResult {
  imported: string[];
  skipped: number;
}

/**
 * Copy discovered ADRs into decisions/. Each imported entry records `source:`,
 * so re-running is safe: an ADR already imported is skipped rather than
 * duplicated. Entries are marked `generated: true` — they are derived, and a
 * human editing them would lose the edit on the next import.
 */
export function importAdrs(projectRoot: string): AdrImportResult {
  const already = importedSources(projectRoot);
  const imported: string[] = [];
  let skipped = 0;

  for (const adr of findAdrs(projectRoot)) {
    if (already.has(adr.rel)) {
      skipped += 1;
      continue;
    }
    const filename = `${adr.date}-${slugify(adr.title)}.md`;
    const summary = adr.status
      ? `${adr.status} — imported from ${adr.rel}`
      : `Imported from ${adr.rel}`;

    const front = [
      "---",
      `date: ${adr.date}`,
      `summary: ${summary}`,
      "tags: [adr, imported]",
      `source: ${adr.rel}`,
      "generated: true",
      "---",
      "",
    ].join("\n");

    writeFile(
      "decisions" as MemoryType,
      filename,
      `${front}# ${adr.title}\n\n${adr.body}\n`,
      {},
      projectRoot
    );
    imported.push(`decisions/${filename}`);
  }

  return { imported, skipped };
}
