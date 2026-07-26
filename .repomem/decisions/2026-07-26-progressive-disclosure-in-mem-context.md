---
date: 2026-07-26
summary: mem_context returns one-line summaries only; agents expand single entries with mem_get.
tags: [context, tokens, api]
---
# Progressive disclosure in mem_context

`mem_context` deliberately does **not** return memory bodies. It returns one-line
summaries (`summary:` front matter, else the first prose line — see `summaryOf` in
`src/store/file-store.ts`). The agent expands only what it needs via `mem_get`.

Why: the tool runs at the start of every session. If it dumped full bodies, a repo
with 50 memories would burn thousands of tokens before the first user message, which
defeats the point of having memory at all.

Implications for anything added later:
- Any new memory should carry a real `summary:` — it is the only thing most sessions
  will ever see.
- `[[wikilinks]]` exist so the summary layer can hint at related entries without
  inlining them; `relatedOf` resolves them to titles, not bodies.

Related: [[memory-lives-in-the-repo-as-plain-markdown]]
