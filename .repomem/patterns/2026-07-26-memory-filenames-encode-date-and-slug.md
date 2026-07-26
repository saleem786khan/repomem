---
date: 2026-07-26
summary: Sessions are one append-only file per day; decisions/patterns/issues are YYYY-MM-DD-slug.md with front matter.
tags: [storage, conventions]
---
# Memory filenames encode date and slug

Two shapes, both produced by `mem_save`:

- **sessions** → `YYYY-MM-DD.md`, one per day, *appended* to. Each entry is a
  `## HH:MM — Title` block. No front matter.
- **decisions / patterns / issues** → `YYYY-MM-DD-<slug>.md`, written whole, with
  `---` front matter carrying `date`, optional `summary`, `tags`, `supersedes`.

The date prefix is load-bearing, not cosmetic:
- `listFiles` sorts by name and reverses — filename order *is* newest-first order.
- `docDateMs` parses the prefix for the search recency boost, falling back to mtime.
- `resolveLink` strips the prefix to get a slug, which is what `[[wikilinks]]` match
  against (exact slug, exact filename, or a *unique* substring).

So: `[[use-postgres]]` resolves regardless of which day it was written, and a link is
silently dropped when it matches two entries ambiguously.

Related: [[mcp-tools-are-tooldefs-that-return-strings]] [[same-day-slug-collisions-overwrite]]
