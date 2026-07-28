---
date: 2026-07-28
summary: Retired memory (superseded/resolved) is demoted everywhere; repomem review reports staleness.
---
# Memory lifecycle is first-class

Memory has an end of life, not just a beginning. supersedes now stamps superseded-by on the old entry, a new resolves arg closes issues (status: resolved + resolved-by), retired entries are hidden from mem_context (counted, never silent), demoted x0.25 in search and labelled, and mem_get banners them. repomem review is the scheduled half of review cadence: a report of aging entries, long-open issues, broken wikilinks and unstamped supersedes claims. Shipped in v0.6.0.
