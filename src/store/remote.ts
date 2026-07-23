import * as fs from "fs";
import * as path from "path";

/**
 * Remote linked-repo support: read another repo's .repomem/ from GitHub without
 * cloning it. A remote is fetched into a local cache (see file-store) so that
 * search stays synchronous and works offline once pulled.
 */

export interface RemoteRef {
  owner: string;
  name: string;
  ref: string; // branch, tag, or commit — "HEAD" means the default branch
}

/**
 * Parse a `linked` entry into a RemoteRef, or return null when it is a local
 * path (the existing behaviour). Recognised remote forms:
 *   github:owner/repo
 *   github:owner/repo#ref
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/ref
 *   git@github.com:owner/repo.git
 */
export function parseRemote(spec: string): RemoteRef | null {
  const s = spec.trim();

  // github:owner/repo[#ref]
  let m = s.match(/^github:([^/\s]+)\/([^#\s]+?)(?:#(.+))?$/i);
  if (m) return ref(m[1], m[2], m[3]);

  // https://github.com/owner/repo[/tree/ref][...]
  m = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:\/tree\/([^/\s#]+))?(?:[/#?].*)?$/i);
  if (m) return ref(m[1], m[2], m[3]);

  // git@github.com:owner/repo.git
  m = s.match(/^git@github\.com:([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i);
  if (m) return ref(m[1], m[2], undefined);

  return null;
}

function ref(owner: string, name: string, r?: string): RemoteRef {
  return { owner, name: name.replace(/\.git$/i, ""), ref: r && r.trim() ? r.trim() : "HEAD" };
}

/** A filesystem-safe cache directory name for a remote. */
export function remoteSlug(r: RemoteRef): string {
  const raw = `${r.owner}-${r.name}${r.ref === "HEAD" ? "" : "-" + r.ref}`;
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

const MEMORY_DIR_RE = /^\.repomem\/(decisions|sessions|patterns|issues)\/.+\.md$/;

/**
 * Fetch a remote repo's .repomem/ memory files into `destRepomemDir` (which
 * should be the `.repomem` directory inside a cache root). Returns the number
 * of files written. Uses the GitHub API and honours a token for private repos
 * and higher rate limits.
 */
export async function fetchRemoteRepomem(
  r: RemoteRef,
  destRepomemDir: string,
  token?: string
): Promise<number> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "repomem",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const treeUrl = `https://api.github.com/repos/${r.owner}/${r.name}/git/trees/${encodeURIComponent(
    r.ref
  )}?recursive=1`;
  const treeRes = await fetch(treeUrl, { headers });
  if (!treeRes.ok) {
    throw new Error(
      `GitHub API ${treeRes.status} for ${r.owner}/${r.name}@${r.ref}` +
        (treeRes.status === 404
          ? " — repo/ref not found (or private without a token)."
          : treeRes.status === 403
          ? " — rate limited; set GITHUB_TOKEN."
          : "")
    );
  }
  const tree = (await treeRes.json()) as { tree?: TreeEntry[]; truncated?: boolean };
  const entries = (tree.tree ?? []).filter(
    (e) => e.type === "blob" && MEMORY_DIR_RE.test(e.path)
  );

  let written = 0;
  for (const entry of entries) {
    const blobRes = await fetch(
      `https://api.github.com/repos/${r.owner}/${r.name}/git/blobs/${entry.sha}`,
      { headers }
    );
    if (!blobRes.ok) continue;
    const blob = (await blobRes.json()) as { content?: string; encoding?: string };
    const content =
      blob.encoding === "base64" && blob.content
        ? Buffer.from(blob.content, "base64").toString("utf8")
        : blob.content ?? "";

    const rel = entry.path.slice(".repomem/".length);
    const dest = path.join(destRepomemDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf8");
    written++;
  }
  return written;
}
