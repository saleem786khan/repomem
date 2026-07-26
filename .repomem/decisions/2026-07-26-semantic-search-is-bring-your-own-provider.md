---
date: 2026-07-26
summary: Semantic search is optional and never bundles a model — the embedding provider is always one the user already runs.
tags: [search, embeddings, dependencies]
supersedes: 2026-07-26-bm25-recency-ranking-instead-of-embeddings.md
---
# Semantic search is bring-your-own-provider

Refines [[bm25-recency-ranking-instead-of-embeddings]]. That entry rejected embeddings
outright to avoid a model dependency. The rejection was of *bundling* a model, not of
semantic search — so semantic search is now available, and repomem still ships no
model and still has zero runtime dependencies.

repomem provides the cache format, the cosine maths, and the blend. The provider is
configured, never installed:

- `ollama` — an endpoint you already run, reached with Node's built-in `fetch`
- `openai-compatible` — any `/embeddings` endpoint, token from an env var
- `command` — any executable reading text on stdin and printing a JSON array

Load-bearing consequences:

- **Off unless configured.** No `semantic` block means no embedding calls, no cache,
  and `mem_search` stays synchronous. Only that one branch is async — which is why
  `ToolDef.handler` returns `string | Promise<string>` rather than always a promise.
- **Blended, not substituted.** BM25 is precise when the caller knows the vocabulary;
  embeddings recall entries sharing no words with the query. Both are normalised to
  0–1 before mixing so neither dominates by scale.
- **Every failure degrades to BM25.** Missing cache, stale signature, unreachable or
  crashing provider — all fall back silently. Search failing is worse than search
  being less clever.
- **Vectors are not memory.** The cache lives in gitignored `.repomem/.cache/`, keyed
  by content hash. Memory is markdown that travels in git; a re-derivable float array
  is a build artifact, and committing one puts a model's output in the repo's history.
- Changing provider or model changes the cache signature and forces a full rebuild —
  vectors from different models are not comparable.

Related: [[bm25-recency-ranking-instead-of-embeddings]] [[memory-lives-in-the-repo-as-plain-markdown]]
