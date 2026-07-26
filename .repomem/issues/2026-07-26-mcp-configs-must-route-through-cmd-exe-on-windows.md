---
date: 2026-07-26
summary: Agents spawn MCP servers without a shell, so a bare `npx`/`repomem` command fails with ENOENT on Windows — the entry must go through `cmd /c`.
tags: [windows, mcp, setup]
---
# MCP configs must route through cmd.exe on Windows

MCP clients launch servers with a bare `spawn()` and **no shell**. On Windows the
`npx` and `repomem` binaries are `.cmd` shims, which such a spawn cannot resolve.
Measured on win32:

```
spawn("npx", ["@saleem11kh/repomem"])   -> ERROR ENOENT
spawn("repomem", [])                    -> ERROR ENOENT   (global install present)
spawn("cmd", ["/c","npx",PKG])          -> OK
spawn("node", ["dist/cli.js"])          -> OK
```

The failure is **silent from the user's side** — the agent shows the server as
failed/disconnected and no tools appear, with nothing pointing at the config. The
symptom people report is "I don't see any repomem commands", which is doubly
confusing because MCP contributes *tools*, not slash commands, so an empty `/` menu
is expected even when everything works. `/mcp` is the only place server health shows.

`mcpEntry(platform)` in `src/cli.ts` now branches on `process.platform` and emits the
`cmd /c` form on win32. Consequences to remember:

- **The generated config is host-specific.** A Windows dev commits a `cmd /c` entry
  that will not run on a teammate's Mac. `cmdSetup` prints a warning saying to re-run
  `repomem setup` there. A `.mcp.json` in a mixed-OS team is not portable.
- **When developing repomem itself, prefer `{"command":"node","args":["dist/cli.js"]}`** —
  it spawns directly on every platform *and* runs the local build rather than the
  published npm package, so changes to `src/` are actually exercised.
- Project-scoped `.mcp.json` servers also need explicit approval on first launch
  (tracked in `~/.claude.json` as `enabledMcpjsonServers`). Wiring a server mid-session
  never takes effect; the approval prompt only fires at agent startup.

Related: [[mem-prime-has-no-cli-equivalent]] [[mcp-tools-are-tooldefs-that-return-strings]]
