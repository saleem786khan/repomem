---
date: 2026-07-26
summary: Remote linked repos are read via the GitHub API into a gitignored .repomem/.cache/ — never git-cloned.
tags: [multi-repo, remote]
---
# Remote linked repos are fetched, not cloned

`linked` entries in `repomem.config.json` may be local paths or `github:owner/name#ref`.
For remotes, `repomem pull` fetches only the `.repomem/` subtree through the GitHub
API into `.repomem/.cache/<slug>/` (`src/store/remote.ts`, `cmdPull` in `src/cli.ts`).

Why: cloning a sibling microservice just to read four markdown folders is wasteful and
often impossible (no disk, no credentials for the full repo). Memory is small; fetch
the memory, not the code.

Details that matter:
- The cache is a *project-root-shaped* dir, so `searchInRoot` treats it like any other
  root — one code path for local, linked, remote, and workspace scopes.
- `ensureCacheGitignore` writes `.repomem/.cache/.gitignore` with `*` before the first
  fetch, so pulled copies never get committed.
- `GITHUB_TOKEN` / `GH_TOKEN` is used for private repos and rate limits.
- Pull is explicit and manual — there is no background refresh.

Related: [[memory-lives-in-the-repo-as-plain-markdown]]
