---
date: 2026-07-26
summary: Search counts raw substring occurrences, so "auth" matches "author" and short query terms produce noisy hits.
tags: [search, gotcha]
---
# Search matches substrings, not words

`countTerm` in `src/store/file-store.ts` walks `haystack.indexOf(term)` over the
lower-cased file text. There is no tokenisation, stemming, or word-boundary check.

Practical effects:
- `mem_search("auth")` hits every "author", "authorised", "unauthorized".
- `mem_search("cat")` hits "category", "concatenate".
- Conversely, plurals do not unify: "pattern" does not match "patterns" as a *term*
  (though it does substring-match inside it, which is why it usually still works).
- Short terms inflate BM25 tf and can outrank a genuinely relevant entry.

This is a deliberate trade against pulling in a tokeniser — see
[[bm25-recency-ranking-instead-of-embeddings]]. When searching, prefer distinctive
multi-word queries over short fragments.

Related: [[bm25-recency-ranking-instead-of-embeddings]]
