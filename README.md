<div align="center">

# repomem

**Git-native memory for AI coding agents.**

`.repomem/` lives in your repo. Commits with your code. Clones with your team.  
Works with Claude Code, Cursor, Gemini CLI, Codex — any MCP-compatible agent.

[![npm](https://img.shields.io/npm/v/@saleem11kh/repomem?color=7F77DD&label=npm)](https://www.npmjs.com/package/@saleem11kh/repomem)
[![license](https://img.shields.io/badge/license-MIT-1D9E75)](./LICENSE)
[![status](https://img.shields.io/badge/status-early%20development-amber)](https://github.com/saleem786khan/repomem)

</div>

---

## The problem

Every AI coding session starts from zero.

You spend the first 10–15 minutes re-explaining your folder structure, your deployment order, what your team decided last week, which patterns to use, which ones to avoid. Your teammate picks up your work and has no idea what Claude was told. You switch from Claude Code to Cursor and lose all context. You start a new session on a different machine and rediscover everything from scratch.

CLAUDE.md helps — but it's static. It doesn't capture what was done yesterday, decisions made mid-session, or work-in-progress state. claude-mem and Engram are personal — they don't sync with your team and don't travel with the repo.

**The root problem: memory lives in the tool, not in the project.**

---

## The solution

repomem puts memory where code already lives — in the git repo.

```
your-project/
└── .repomem/
    ├── decisions/     ← architectural choices + why
    ├── sessions/      ← what was done, what's next
    ├── patterns/      ← reusable conventions for this codebase
    ├── issues/        ← known gotchas, do-not-repeat mistakes
    ├── project.md     ← auto-generated profile: stack, commands, layout
    └── REPOMEM.md     ← auto-generated index of everything above
```

Plain markdown files. No database. No cloud. No vendor lock-in.

`git add .repomem/ && git commit` → your whole team has the memory.  
`git clone` → new teammate inherits full project context on day one.  
Switch agents → same memory, because it's in the repo, not the tool.

---

## Quick start

```bash
# 1. Install
npm install -g @saleem11kh/repomem

# 2. Scaffold .repomem/ in your project
cd your-project
repomem init

# 3. Wire it to your agent
repomem setup claude-code     # or: cursor | gemini | codex

# 4. Restart the agent, then approve the server when prompted
```

**Step 4 is not optional.** MCP servers are loaded when the agent starts, so a server
wired mid-session does not exist in that session. Claude Code additionally requires
you to approve any server declared in a project's `.mcp.json` the first time you
launch with it.

Verify with `/mcp` — you should see `repomem` connected with six tools. There are no
slash commands to look for; MCP servers contribute **tools**, which never appear in
the `/` menu.

---

## Usage

### The six tools

Your agent calls these; you don't type them.

| Tool | Arguments | What it does |
|---|---|---|
| `mem_context` | `task?`, `budget?`, `brief?` | Session-start packet: the project profile, the last session, plus one-line summaries of decisions, patterns, and issues. Call it first. |
| `mem_get` | `file` | Expand one entry in full — by `type/filename`, bare filename, or `[[wikilink]]` slug. |
| `mem_search` | `query`, `linked?` | BM25 + recency ranked search across all memory, blended with semantic similarity when enabled. `linked=true` also searches linked repos and the workspace. |
| `mem_save` | `type`, `title`, `content`, `summary?`, `tags?`, `links?`, `supersedes?`, `session?` | Write a `decision`, `pattern`, `issue`, or `session` note. |
| `mem_handoff` | `summary`, `done?`, `next?`, `blockers?`, `session?`, `git?` | Close out a session so the next one picks up exactly where you left off. Fills in what changed from git. |
| `mem_prime` | — | Bootstrap memory on an existing repo from its `CLAUDE.md` / `README.md` / `docs/`. Run once when adopting. |

### Progressive disclosure — why context stays small

`mem_context` deliberately returns **one-line summaries**, not full bodies. It runs at
the start of every session; if it dumped everything, a repo with 50 memories would
burn thousands of tokens before your first message. See
[Capping the packet](#capping-the-packet) for hard limits.

```
## Recent decisions
- BM25 + recency ranking instead of embeddings — Search is BM25 over raw markdown
  with an exponential recency boost — no embeddings, zero extra deps.
  (decisions/2026-07-26-bm25-recency-ranking-instead-of-embeddings.md)
```

The agent expands only what it needs with `mem_get`. This is why **every entry should
have a `summary`** — it's the only thing most future sessions will ever read.

### Scoping context to the task

Recency is a decent default on a young repo and a poor one on a mature repo — the
decision that bears on today's work is rarely the newest. Tell `mem_context` what the
session is about and it ranks by relevance instead:

```js
mem_context({ task: "add rate limiting to the payments API" })
```

It uses the same BM25 + recency scoring as `mem_search`, so search and context can
never disagree about what matters. Entries that don't match the task aren't hidden —
they keep a zero score and fall back to recency order behind the ones that do. The
headings change to **Relevant decisions / patterns / issues**, because "Recent" would
be a lie once the list is relevance-ordered.

### Capping the packet

```js
mem_context({ task: "rate limiting", budget: 800 })
```

`budget` is an approximate token ceiling for the whole packet. The budget is split so
the prelude can't eat it: **25%** to the project profile, **35%** to the last session,
the remainder to memory entries. Without that split, a tight budget produced a packet
with a profile, a session, and no memory in it at all.

Entries are then shed lowest-relevance first until the rendered packet actually fits —
measured, not estimated. Whatever is dropped is always declared:

```
_9 further entries not shown (token budget 800) — find them with mem_search._
```

Below roughly 290 tokens a full packet cannot be built at all, so it degrades to the
brief one-line summary plus what a packet would have cost, rather than quietly
overshooting.

Even with no budget set, each type is capped at **20** entries — previously the cap
was 100, which on a long-lived repo was no cap at all.

### Semantic search (optional, off by default)

BM25 is precise when you know the vocabulary and useless when you don't — searching
`cmd` will never find an entry that only says `npx shim`. Embeddings close that gap.

**repomem ships no model and adds no dependency.** Bundling a local runtime would
mean a ~100MB download on install and infrastructure to provision, which is exactly
what this project exists to avoid. The provider is always something you already run:

```jsonc
// repomem.config.json — Ollama, the common local setup
{
  "semantic": { "provider": "ollama", "model": "nomic-embed-text" }
}
```

```jsonc
// …or any OpenAI-compatible endpoint
{
  "semantic": {
    "provider": "openai-compatible",
    "url": "https://api.example.com/v1/embeddings",
    "model": "text-embedding-3-small",
    "apiKeyEnv": "EMBEDDINGS_API_KEY"
  }
}
```

```jsonc
// …or anything at all: reads text on stdin, prints a JSON array of floats
{
  "semantic": { "provider": "command", "command": "./my-embedder.sh" }
}
```

Then build the index:

```bash
repomem embed          # ✔ Vector cache updated — 12 embedded, 0 reused
```

Re-run it after adding memory. Only entries whose content hash changed are
re-embedded, so a second run over an unchanged repo makes no provider calls at all.

**How results combine.** Semantic scores are blended with BM25, not substituted for
it — `blend` (default `0.5`) is the semantic share. Entries only the vector index
found are appended, so a semantic hit can surface memory lexical search could never
reach. Both score sets are normalised to 0–1 first so neither dominates by scale.

**It never breaks search.** No config, a missing cache, a stale cache from a
different model, an unreachable provider, a provider that crashes — all degrade
silently to plain BM25. Search failing is always worse than search being less clever.

**Vectors are not memory.** The cache lives in `.repomem/.cache/` and is gitignored.
Memory is markdown that travels in git; a re-derivable float array is a local build
artifact, and committing one would put a model's output in your repo's history.

Check the state any time:

```console
$ repomem status
  semantic   ollama (nomic-embed-text) — 12 vector(s)
```

### A normal session

**At the start**, the agent calls `mem_context` and immediately knows what was worked
on last, the key decisions and why, the conventions for this codebase, and known
gotchas.

**During work**, you capture things as they happen:

> "Save that as a decision — include why we rejected the alternative."

**At the end:**

> "Run mem_handoff."

Then commit. Nothing is shared with your team until you do:

```bash
git add .repomem/ && git commit -m "chore: update memory"
```

### Making it automatic

The default flow depends on you remembering to ask. To remove that:

```bash
repomem setup claude-code --hooks
```

This installs two lifecycle hooks in `.claude/settings.json`, merging with whatever
is already there:

| Hook | Runs | Effect |
|---|---|---|
| `SessionStart` | `repomem context` | Every session opens warm — the profile, last session, and memory summaries load without the agent choosing to |

| `SessionEnd` | `repomem capture` | What changed is recorded whether or not anyone asked |

`repomem capture` writes a session file from git alone — no model, no tokens. It is
careful about noise:

- **Commits are events**, so anything in the window is new and always recorded.
- **Uncommitted files are state** — they survive from one capture to the next. They
  are recorded once, then only again when the file set actually changes. Otherwise
  hooking capture to every session end would fill `sessions/` with near-identical
  files.
- Nothing changed means **nothing is written at all**.
- The summary says outright that no human wrote it, rather than inventing intent it
  cannot know: *"No summary was written by hand, so the intent behind this work is not
  recorded."*

A marker under `.repomem/.cache/` (gitignored) tracks the window between runs.

Edit the `SessionStart` command to `repomem context --budget 600` if you want a hard
ceiling on what gets injected into every session.

Both commands no-op silently outside a repomem project, so the hooks are safe to
install globally — a session in an unrelated repo is unaffected.

Hooks are a Claude Code feature. Cursor, Gemini CLI, and Codex have no equivalent
session lifecycle, so `--hooks` warns and skips for them. You can still wire
`repomem capture` to a shell alias, a cron, or a git hook.

⚠️ An auto-captured session records *what* changed, never *why*. It is a floor, not a
replacement for asking your agent to save a decision — that judgement is the part
worth keeping.

### What to say

repomem has no slash commands. You talk to your agent normally; it picks the tool.

| You want | Say |
|---|---|
| Load context | *"What's in repomem for this project?"* |
| Capture a choice | *"Save that as a decision, with why we rejected X"* |
| Capture a convention | *"Save that as a pattern"* |
| Capture a gotcha | *"Save that as an issue, with the guard against it"* |
| Replace a stale decision | *"Save this as a decision that supersedes `<filename>`"* |
| Sweep the whole session | *"Update repomem with what we did — skip anything obvious from the code"* |
| Close out | *"Run mem_handoff"* |
| Recall | *"Search repomem for how we handle retries"* |

Adding **"skip anything obvious from the code"** matters — otherwise you accumulate
entries restating function signatures, and the signal-to-noise ratio that makes memory
worth loading degrades.

### Adopting on an existing project

`repomem init` scans the repo as it scaffolds — no agent, no model, no API key:

```console
$ repomem init
✔ Created repomem.config.json (project: payments-service)
✔ Initialised .repomem/ with decisions, sessions, patterns, issues

✔ Wrote .repomem/project.md — 4 stack signal(s), 6 command(s), 9 top-level dir(s), git conventions
  stack: Node.js + TypeScript, Express, Jest, Docker
✔ Imported 12 ADR(s) into decisions/
```

Two things happen automatically.

**A project profile** is written to `.repomem/project.md` and inlined at the top of
every `mem_context` packet — the stack, how to build/test/lint, entry points, the
directory layout, CI workflows, plus conventions inferred from git history (commit
style, release tags, and the files that churn most). This is what an agent otherwise
rediscovers by globbing the tree at the start of every session.

**Existing ADRs are imported.** If your repo has `docs/adr/`, `adr/`,
`docs/decisions/`, or `rfcs/`, those files are already decision-shaped and are copied
straight into `decisions/` — title, status, and date preserved. Each records its
`source:`, so re-running skips what's already there instead of duplicating it.

Regenerate either at any time:

```bash
repomem scan     # refresh project.md, import any new ADRs
```

**Prose docs still need judgement**, and that's what `mem_prime` is for. It gathers
`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `README.md`, and `docs/**.md` and returns them
with instructions to distil them into memory. Either ask your agent to call it, or
pipe it from the shell:

```bash
repomem prime                    # print the packet
repomem prime | your-agent       # or hand it straight to something
```

> "Call `mem_prime`, then save what it surfaces as decisions, patterns, and issues."

It **writes nothing itself** — distilling prose needs a model. Re-running is safe: it
reads the existing count first and is told not to duplicate.

If your project has no docs at all, the higher-value move is to point the agent at the
code:

> "Read the source under `src/`, then save what you learned as decisions, patterns,
> and issues. Give every entry a one-line summary and cross-link related entries."

Aim for 5–12 entries. Fewer and `mem_context` says nothing useful; many more in one
sitting and quality drops.

### Handoffs are half-derived

`mem_handoff` does not rely on the agent remembering what it touched. Since the
session knows when it started, repomem asks git directly:

```markdown
## 2026-07-26 14:30 — Handoff

Reworked how sessions are identified.

_branch: master_

**Committed this session:**
- 1038eb6 fix(cli): route MCP config through cmd.exe on Windows
- ce365ab chore(repomem): record the Windows MCP spawn gotcha

**Still uncommitted:**
- M src/tools/mem-context.ts
- ?? src/store/git.ts

**Next:**
- push the tag
```

The agent supplies only what git cannot know — *why*, and *what's next*. Commits and
uncommitted files are facts, and deriving them is both cheaper and more reliable than
asking a model to recall them.

Notes:
- Changes under `.repomem/` are filtered out; the handoff is writing there as it runs.
- Long lists are capped at 20 with an explicit `…and N more`, never silently truncated.
- Non-git projects, missing `git`, and empty repos all degrade quietly to a handoff
  with no git detail. Pass `git: false` to skip it deliberately.
- Commits are matched by *time*, so parallel sessions each report the same commits.
  Time is the only signal available without asking agents to tag their own work.

### Sessions and parallel agents

Each session owns one file:

```
.repomem/sessions/2026-07-26-0917-windows-mcp-fix.md
.repomem/sessions/2026-07-26-1430-auth-refactor.md
```

`YYYY-MM-DD-HHMM-<name>.md`, where the timestamp is when the session *started* — so it
stays put as the session appends, and because it's zero-padded, filename order is
chronological order.

Name a session by passing `session` to `mem_save` or `mem_handoff` (*"run mem_handoff,
call this session auth-refactor"*). Unnamed sessions are `untitled`; naming one later
renames the file in place, so one session always maps to one file.

This matters most when **more than one session runs at once** — two terminals, two
agents, or two teammates:

- Separate files mean no interleaving and **no git merge conflicts**
- Sessions are linkable: a decision can point at `[[auth-refactor]]`
- `mem_context` inlines the newest session and lists the others under **Also today**,
  so parallel work is visible without being loaded in full
- The connecting agent is recorded automatically (`agent: claude-code`), taken from the
  MCP handshake — so parallel sessions from different tools are tellable apart

### Anatomy of a memory file

```markdown
---
date: 2026-07-26
summary: Search is BM25 over raw markdown with a recency boost — no embeddings.
tags: [search, ranking]
---
# BM25 + recency ranking instead of embeddings

Why not embeddings: they add a model dependency and a cache to invalidate, which
breaks the "plain files, no infra" promise.

Related: [[memory-lives-in-the-repo-as-plain-markdown]]
```

- **`summary`** — the one line `mem_context` and `mem_search` show. Always set it.
- **`tags`** — free-form, for retrieval.
- **`supersedes`** — on a decision, the filename it replaces. Keeps the history.
- **`[[wikilinks]]`** — resolve by slug regardless of date prefix. `mem_search` and
  `mem_context` traverse them and show `→ related:`, so linked entries travel together.

Filenames are `YYYY-MM-DD-<slug>.md`. The date prefix is load-bearing: it drives
newest-first ordering and the search recency boost.

### Editing and correcting

There's no update tool. Two paths:

- **Superseding a decision** — `mem_save` with `supersedes: <filename>` records the
  replacement and keeps the history. This is the intended path.
- **Fixing a mistake** — just edit the markdown file. It's plain text in your repo.

⚠️ Saving twice on the same day with the same title **overwrites silently** — the
filename is `date-slug` and `slugify` truncates at 60 characters, so two long titles
sharing a prefix collide. Use short, distinct titles.

---

## CLI reference

```
repomem                      Start the MCP server (stdio) — how agents invoke it
repomem init                 Scaffold .repomem/, then scan the repo
repomem scan                 Regenerate .repomem/project.md and import new ADRs
repomem prime                Print the priming packet for an agent to distil
repomem embed                Build the semantic vector cache (opt-in)
repomem context              Print the session-start memory packet
                             [--brief] [--task <what>] [--budget <tokens>]
repomem capture              Record what changed since the last capture
repomem setup <agent>        Wire repomem into claude-code | cursor | gemini | codex
repomem setup <agent> --hooks
                             …and install session hooks (Claude Code only)
repomem status               Show memory counts, configured agents, linked repos
repomem sync                 Export all memory to stdout
repomem import [file]        Import a sync bundle (file or stdin) into .repomem/
repomem pull                 Fetch remote linked repos' memory from GitHub
repomem help                 Show this help
```

`init` is idempotent — re-running it regenerates `REPOMEM.md` without touching config.

`sync` and `import` are inverses, for airgapped transfer:

```bash
repomem sync > bundle.md          # on the connected machine
repomem import bundle.md          # on the airgapped one
```

Where `setup` writes each agent's config:

| Agent | File |
|---|---|
| Claude Code | `.mcp.json` (repo root — **not** `.claude/mcp.json`) |
| Cursor | `.cursor/mcp.json` |
| Gemini CLI | `.gemini/settings.json` |
| Codex | `.codex/config.toml` |

On Windows the generated command is wrapped in `cmd /c`, because agents spawn MCP
servers without a shell and `npx` is a `.cmd` shim there. That makes the generated
config **host-specific** — a teammate on macOS or Linux should re-run `repomem setup`
to rewrite it.

---

## Multi-repo

Working across microservices? Declare related repos in `repomem.config.json`:

```jsonc
{
  "project": "payments-service",
  "workspace": "../repomem-workspace",
  "linked": [
    { "repo": "../auth-service",          "relation": "depends-on" },
    { "repo": "../shared-lib",            "relation": "consumes"   },
    { "repo": "github:acme/billing-svc",  "relation": "depends-on" }
  ]
}
```

Linked repos can be **local paths** or **remote GitHub repos** (`github:owner/name`,
optionally `#ref`). For remotes, run `repomem pull` once — it fetches only their
`.repomem/` subtree through the GitHub API into a local, gitignored cache. No full
clone. Set `GITHUB_TOKEN`/`GH_TOKEN` for private repos and higher rate limits.

Then `mem_search` with `linked=true` searches current + linked + remote + workspace,
ranked together and labelled by source:

```
[current] [linked:auth-service] [remote:billing-svc] [workspace]
```

Pull is explicit and manual — nothing refreshes in the background.

---

## Troubleshooting

**"I don't see any repomem commands."**  
Expected. MCP servers contribute tools, not slash commands. Check `/mcp` instead — it
should list `repomem` as connected with six tools.

**`/mcp` shows repomem as failed or missing.**  
Three causes, in order of likelihood:
1. You haven't restarted the agent since running `repomem setup`.
2. The project's `.mcp.json` was never approved — the prompt only fires at startup.
3. You're on Windows with a config generated by repomem ≤ 0.3.0, which used a bare
   `npx` command that cannot be spawned without a shell. Re-run `repomem setup`.

**Tools appear but every call says `.repomem/ not found`.**  
The server resolves the project root by walking up for `.repomem/` or
`repomem.config.json`. Run `repomem init` at the repo root.

**Working on repomem itself?** Point `.mcp.json` at your local build so you exercise
your changes rather than the published package:

```json
{ "mcpServers": { "repomem": { "command": "node", "args": ["dist/cli.js"] } } }
```

---

## Compared to alternatives

| | repomem | Engram | claude-mem | CLAUDE.md |
|---|---|---|---|---|
| Git-committed | ✅ | ❌ | ❌ | ✅ |
| Team-shared on clone | ✅ | ❌ | ❌ | ✅ |
| Captures session work | ✅ | ✅ | ✅ | ❌ |
| Multi-repo support | ✅ | ❌ | ❌ | ❌ |
| Multi-agent (any MCP) | ✅ | ✅ | ❌ | ✅ |
| No cloud / no vendor | ✅ | ❌ | ✅ | ✅ |
| Plain markdown files | ✅ | ❌ | ❌ | ✅ |

---

## Roadmap

- [x] `repomem init` — scaffold `.repomem/` in any project
- [x] Six MCP tools (`mem_save`, `mem_search`, `mem_context`, `mem_get`, `mem_handoff`, `mem_prime`)
- [x] Claude Code, Cursor, Gemini CLI, and Codex wiring
- [x] Multi-repo `linked` support — local paths and remote GitHub repos
- [x] Workspace scope (cross-org shared memory repo)
- [x] `repomem sync` / `import` for airgapped transfer
- [x] BM25 + recency search ranking
- [x] Progressive disclosure — `mem_context` summaries + `mem_get` to expand
- [x] `[[wikilink]]` graph between memories
- [x] `mem_prime` — bootstrap memory from an existing repo's docs
- [x] One file per session, with names, timestamps, and agent attribution
- [x] Git-derived handoffs — "what changed" comes from commits, not recollection
- [x] `init` learns the repo — stack, commands, layout, ADRs, and git conventions, without an LLM
- [x] `repomem prime` as a CLI, so onboarding can be scripted end-to-end
- [x] Auto-capture hooks, so memory does not depend on remembering to ask
- [x] Task-scoped `mem_context` and a token budget, for repos with lots of memory
- [x] Optional semantic search layer (off by default, bring-your-own provider)

---

## Status

**v0.3.1 — working.** `init`, `setup`, `status`, `sync`, `import`, `pull`, and six MCP
tools are implemented and covered by tests. Context is token-lean by default, memories
cross-link with `[[wikilinks]]`, `mem_prime` bootstraps an existing repo from its docs,
and multi-repo search spans local paths, pulled GitHub remotes, and a shared workspace.

**On `master`, not yet published:** one file per session
(`YYYY-MM-DD-HHMM-<name>.md`) with front matter, session naming, agent attribution
from the MCP handshake, `mem_context` listing parallel same-day sessions, and
git-derived handoffs. Landing in v0.4.

**On automation:** `repomem setup claude-code --hooks` makes memory load and record
itself. What remains manual is the part that needs judgement — capturing *why* a
decision was made. An auto-captured session is a floor, not a substitute.

If this solves a problem you have, **star the repo** — it helps validate that this is
worth building and tells me which features to prioritise.

Have this exact problem on your team? Open an
[issue](https://github.com/saleem786khan/repomem/issues) describing your setup — I'm
using real use cases to shape the roadmap.

---

## Contributing

repomem is being built in public. Contributions welcome at any stage.

```bash
git clone https://github.com/saleem786khan/repomem
cd repomem
npm install
npm test        # builds, then runs the suite
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get involved.

---

## License

MIT — see [LICENSE](./LICENSE)

---

<div align="center">
Built by <a href="https://github.com/saleem786khan">Saleem Khan</a> — Solutions Architect with 11 years of enterprise delivery,  
tired of re-explaining the same project to Claude every single morning.
</div>
