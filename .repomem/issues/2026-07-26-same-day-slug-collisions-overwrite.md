---
date: 2026-07-26
summary: Two same-day saves whose titles slugify identically silently overwrite each other — slugify truncates at 60 chars.
tags: [data-loss, mem-save]
---
# Same-day slug collisions overwrite silently

`mem_save` builds the filename as `${today()}-${slugify(title)}.md` and calls
`writeFile` **without** `append` for decisions, patterns, and issues — an existing file
at that path is replaced with no warning and no backup.

Two ways to hit it:
1. Saving twice on the same day with the same (or trivially reworded) title.
2. `slugify` truncates to 60 chars, so two long titles sharing a 60-char prefix
   collapse to the same slug — e.g. two "Decision about how the ... pipeline handles
   X / Y" entries written the same day.

`importBundle` has the same overwrite-without-asking behaviour by design.

Guard: prefer distinct, short titles; check `.repomem/REPOMEM.md` before re-saving a
similar entry. A real fix would suffix `-2` on collision inside `mem_save`.

Related: [[memory-filenames-encode-date-and-slug]]
