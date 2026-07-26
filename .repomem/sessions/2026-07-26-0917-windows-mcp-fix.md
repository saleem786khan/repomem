---
date: 2026-07-26
started: 2026-07-26 09:17
session: windows-mcp-fix
agent: claude-code
summary: Dogfooded repomem on its own repo, fixed the Windows MCP spawn bug, released v0.3.1.
---

## 2026-07-26 09:17 — Handoff

Adopted repomem on its own repo (dogfooding), then found and shipped a fix for a
Windows bug that made `repomem setup` produce an MCP config no agent could spawn.
Released v0.3.1 to npm.

**Done:**
- `repomem init` + `setup claude-code` on this repo; seeded 9 memories (4 decisions, 2 patterns, 3 issues) by reading `src/` rather than the docs — committed as 162dcdd
- Diagnosed "no repomem commands in Claude Code" as two separate causes: MCP contributes tools not slash commands (so an empty `/` menu is expected), and the `.mcp.json` server was never approved (`enabledMcpjsonServers: []` in `~/.claude.json`)
- Found the real blocker by measuring spawn behaviour: `spawn("npx", …)` and `spawn("repomem", …)` both fail ENOENT on win32; `cmd /c npx …` and `node dist/cli.js` succeed
- Replaced `MCP_COMMAND`/`MCP_ARGS` with an exported `mcpEntry(platform)` in `src/cli.ts`; both the JSON and Codex TOML writers use it; `cmdSetup` warns the entry is host-specific — 1038eb6
- Guarded `main()` with `require.main === module` so tests can import `mcpEntry` without executing the CLI
- Updated the two tests that hard-coded `"npx"`; added a unit test pinning both platform branches. 46/46 pass
- Pointed this repo's own `.mcp.json` at `node dist/cli.js` so dogfooding exercises the local build, not the published package — ce365ab
- Released v0.3.1: bumped `package.json` and the hardcoded `VERSION` in `src/index.ts`, tagged `v0.3.1`, published to npm — df493eb

**Next:**
- `git push origin master --follow-tags` — master and the v0.3.1 tag are local only, so GitHub is behind npm
- Make `repomem setup` detect and repair a stale bare-`npx` entry; upgrading the package does not fix an already-broken `.mcp.json`, and existing Windows users have no signal that theirs is wrong
- Add a `repomem prime` CLI command so onboarding can be scripted end-to-end (see [[mem-prime-has-no-cli-equivalent]])
- De-duplicate the version constant — `require("../package.json").version` in `src/index.ts`, needs `resolveJsonModule` (see [[version-is-duplicated-across-package-json-and-index-ts]])
- Consider a `CLAUDE.md` telling the agent to call `mem_context` at session start and `mem_save` before finishing; the repo has none, so every session starts cold and `mem_prime` has only README and CONTRIBUTING to read

**Blockers:**
- Claude Code has not been restarted since `.mcp.json` was written, so the repomem MCP tools are still not loaded — every memory this session was written to disk by hand in `mem_save`'s format, not via the tools. Restart and check `/mcp` shows `repomem — connected` with 6 tools before relying on them
- Post-publish `npm view` verification was blocked by the sandbox classifier; publish output confirmed `+ @saleem11kh/repomem@0.3.1` but this was not independently checked

Related: [[mcp-configs-must-route-through-cmd-exe-on-windows]] [[version-is-duplicated-across-package-json-and-index-ts]]
