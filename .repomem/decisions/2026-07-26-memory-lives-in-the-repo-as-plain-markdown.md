---
date: 2026-07-26
summary: Memory is plain markdown under .repomem/ in the repo — no DB, no cloud, no vendor lock-in.
tags: [architecture, storage]
---
# Memory lives in the repo as plain markdown

The founding constraint: **memory belongs to the project, not the tool.** Everything
is markdown files under `.repomem/{decisions,sessions,patterns,issues}/`, committed
with the code.

Why:
- `git commit` shares memory with the whole team; `git clone` onboards a new teammate.
- Switching agents (Claude Code → Cursor → Codex) keeps the same memory, because it
  was never stored in the agent.
- No database means no migration, no daemon, no server to run, and the files stay
  reviewable in a PR diff.

Consequence: every read path is `fs.readdirSync` + `fs.readFileSync` over the type
dirs (`src/store/file-store.ts`). There is no index to keep in sync — `REPOMEM.md` is
regenerated from scratch on every write.

Related: [[bm25-recency-ranking-instead-of-embeddings]] [[memory-filenames-encode-date-and-slug]]
