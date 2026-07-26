---
date: 2026-07-26
summary: Search is BM25 over raw markdown with an exponential recency boost — no embeddings, zero extra deps.
tags: [search, ranking]
---
# BM25 + recency ranking instead of embeddings

`searchInRoot` scores with BM25 (`k1=1.5`, `b=0.75`) and multiplies by a recency
boost (`1 + 0.5 * exp(-ageDays / 30)`), so yesterday's session outranks a year-old
note when both match equally well. Document dates come from the `YYYY-MM-DD` filename
prefix, falling back to mtime.

Why not embeddings: they would add a model dependency, a cache to invalidate, and
either a cloud call or a large local download — all of which break the "plain files,
no infra" promise. Semantic search stays on the roadmap as an *optional, off by
default* layer.

Trade-off accepted: matching is substring-based, not tokenised. See
[[search-matches-substrings-not-words]].

Related: [[memory-lives-in-the-repo-as-plain-markdown]] [[search-matches-substrings-not-words]]
