---
date: 2026-07-26
summary: mem_prime is MCP-only, so adopting repomem on an existing repo needs a running agent — init/setup alone seed nothing.
tags: [onboarding, cli, gap]
status: resolved
---
# mem_prime has no CLI equivalent

`repomem init` and `repomem setup <agent>` are CLI commands, but `mem_prime` — the
step that actually bootstraps memory from `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` /
`README.md` / `docs/**.md` — exists only as an MCP tool (`src/tools/mem-prime.ts`).

Consequences:
- Onboarding cannot be scripted end-to-end. The user must restart the agent, then ask
  it to call `mem_prime`, then let it write entries via `mem_save`.
- `mem_prime` returns *instructions plus source text*; it never writes files itself.
  With no agent in the loop, nothing happens.
- Anyone reading the README's Quick Start reasonably expects `init` to leave them with
  populated memory. It leaves them with empty dirs.

Fix if it comes up: add a `repomem prime` command in `src/cli.ts` that prints the same
packet to stdout, so it can be piped into any agent.

Related: [[mcp-tools-are-tooldefs-that-return-strings]]
