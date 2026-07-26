/**
 * Optional semantic search — off unless configured, and never bundled.
 *
 * The obvious way to add embeddings is to depend on a local model runtime and
 * download ~100MB on install. That would trade away the property the whole
 * design rests on: plain files, no infra, nothing to provision. So repomem ships
 * the cache format, the vector maths, and the blend — and no model at all.
 *
 * The provider is always yours: an Ollama endpoint, any OpenAI-compatible
 * endpoint, or an arbitrary command. All three are reachable with Node built-ins,
 * so the dependency list stays empty and semantic search costs nothing to anyone
 * who does not turn it on.
 *
 * Vectors live in .repomem/.cache/ (gitignored) keyed by content hash: memory is
 * markdown that travels in git, and a re-derivable float array is not memory.
 */
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { SemanticConfig } from "../config/config.js";
import { getRepomemRoot, listFiles, readFile, MEMORY_TYPES } from "./file-store.js";

const CACHE_FILE = "embeddings.json";
const REQUEST_TIMEOUT_MS = 20_000;
/** Below this cosine similarity an entry is noise, not a weak match. */
const SIMILARITY_FLOOR = 0.2;

export interface EmbeddingCache {
  /** Which provider and model produced these vectors; a change invalidates all. */
  signature: string;
  entries: Record<string, { hash: string; vector: number[] }>;
}

function cachePath(projectRoot: string): string {
  return path.join(getRepomemRoot(projectRoot), ".cache", CACHE_FILE);
}

function hashOf(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function signatureOf(config: SemanticConfig): string {
  return [config.provider, config.model ?? "", config.url ?? "", config.command ?? ""].join("|");
}

export function readCache(projectRoot: string): EmbeddingCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(projectRoot), "utf8")) as EmbeddingCache;
    if (parsed && parsed.entries) return parsed;
  } catch {
    /* absent or unreadable — treated as no cache */
  }
  return null;
}

function writeCache(projectRoot: string, cache: EmbeddingCache): void {
  const dir = path.dirname(cachePath(projectRoot));
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "# repomem local cache — do not commit\n*\n", "utf8");
  }
  fs.writeFileSync(cachePath(projectRoot), JSON.stringify(cache), "utf8");
}

/** Pull an embedding out of whichever shape the provider answered with. */
function extractVector(payload: unknown): number[] | null {
  const body = payload as Record<string, unknown>;
  if (Array.isArray(body)) return body.every((n) => typeof n === "number") ? (body as number[]) : null;
  if (Array.isArray(body?.embedding)) return body.embedding as number[];
  if (Array.isArray(body?.data)) {
    const first = (body.data as Record<string, unknown>[])[0];
    if (Array.isArray(first?.embedding)) return first.embedding as number[];
  }
  return null;
}

async function embedViaHttp(text: string, config: SemanticConfig): Promise<number[]> {
  const isOllama = config.provider === "ollama";
  const url =
    config.url ?? (isOllama ? "http://localhost:11434/api/embeddings" : "");
  if (!url) throw new Error("semantic.url is required for an openai-compatible provider");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKeyEnv && process.env[config.apiKeyEnv]
        ? { authorization: `Bearer ${process.env[config.apiKeyEnv]}` }
        : {}),
    },
    body: JSON.stringify(
      isOllama
        ? { model: config.model, prompt: text }
        : { model: config.model, input: text }
    ),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);

  const vector = extractVector(await response.json());
  if (!vector) throw new Error(`${url} returned no recognisable embedding`);
  return vector;
}

function embedViaCommand(text: string, config: SemanticConfig): number[] {
  if (!config.command) throw new Error("semantic.command is required for the command provider");
  const out = execFileSync(config.command, config.args ?? [], {
    input: text,
    encoding: "utf8",
    timeout: REQUEST_TIMEOUT_MS,
    windowsHide: true,
  });
  const vector = extractVector(JSON.parse(out));
  if (!vector) throw new Error(`${config.command} returned no recognisable embedding`);
  return vector;
}

export async function embed(text: string, config: SemanticConfig): Promise<number[]> {
  return config.provider === "command"
    ? embedViaCommand(text, config)
    : embedViaHttp(text, config);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface IndexResult {
  embedded: number;
  reused: number;
  removed: number;
  failed: string[];
}

/**
 * Bring the vector cache up to date. Only entries whose content hash changed are
 * re-embedded, so a second run over an unchanged repo makes no provider calls.
 */
export async function buildIndex(
  projectRoot: string,
  config: SemanticConfig
): Promise<IndexResult> {
  const signature = signatureOf(config);
  const existing = readCache(projectRoot);
  // A different provider or model produces vectors that cannot be compared with
  // the old ones, so the cache is rebuilt rather than mixed.
  const previous = existing?.signature === signature ? existing.entries : {};

  const entries: EmbeddingCache["entries"] = {};
  const failed: string[] = [];
  let embedded = 0;
  let reused = 0;

  for (const type of MEMORY_TYPES) {
    for (const filename of listFiles(type, projectRoot)) {
      const file = `${type}/${filename}`;
      const raw = readFile(type, filename, projectRoot);
      if (raw == null) continue;

      const hash = hashOf(raw);
      const cached = previous[file];
      if (cached && cached.hash === hash) {
        entries[file] = cached;
        reused += 1;
        continue;
      }
      try {
        entries[file] = { hash, vector: await embed(raw, config) };
        embedded += 1;
      } catch (err) {
        failed.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  writeCache(projectRoot, { signature, entries });
  return {
    embedded,
    reused,
    removed: Math.max(0, Object.keys(previous).length - reused),
    failed,
  };
}

/**
 * Cosine similarity of every cached entry against the query, keyed "type/filename".
 *
 * Returns an empty map — never throws — when semantic search is off, the cache is
 * missing or stale, or the provider is unreachable. Search degrading to BM25 is
 * always better than search failing.
 */
export async function semanticScores(
  query: string,
  projectRoot: string,
  config: SemanticConfig
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const cache = readCache(projectRoot);
  if (!cache || cache.signature !== signatureOf(config)) return scores;

  let queryVector: number[];
  try {
    queryVector = await embed(query, config);
  } catch {
    return scores;
  }

  for (const [file, entry] of Object.entries(cache.entries)) {
    const score = cosine(queryVector, entry.vector);
    if (score >= SIMILARITY_FLOOR) scores.set(file, score);
  }
  return scores;
}

/** Scale scores to 0–1 so lexical and semantic ranks can be blended fairly. */
export function normalise(scores: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const value of scores.values()) max = Math.max(max, value);
  if (max <= 0) return new Map();
  const out = new Map<string, number>();
  for (const [key, value] of scores) out.set(key, value / max);
  return out;
}
