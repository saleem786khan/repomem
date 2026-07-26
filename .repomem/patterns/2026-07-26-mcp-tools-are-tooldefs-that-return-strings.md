---
date: 2026-07-26
summary: Every MCP tool is a ToolDef with a sync handler(args, projectRoot) returning a plain string — errors included.
tags: [mcp, conventions]
---
# MCP tools are ToolDefs that return strings

To add a tool: create `src/tools/mem-<name>.ts` exporting a `ToolDef`
(`{ name, description, inputSchema, handler }`), then add it to the `TOOLS` array in
`src/index.ts`. Nothing else registers it.

Conventions the existing six all follow:
- The handler is **synchronous** and returns a `string` — never a structured object.
  `src/index.ts` wraps the return in MCP `content`; thrown errors become `isError`.
- Failure is a returned string starting with `✖`, not an exception. Every tool guards
  with `isInitialized(projectRoot)` first and returns
  `"✖ .repomem/ not found. Run \`repomem init\` in your project first."`
- Args are untyped `Record<string, unknown>` — coerce through `str()` / `strArray()`
  from `src/tools/util.ts` rather than trusting the client.
- `projectRoot` is passed in (resolved once by `findProjectRoot()`), never read from
  `process.cwd()` inside a tool. Tests depend on this to run against temp dirs.
- Writes end with the nudge `"Remember to: git add .repomem/ && git commit"`.

Related: [[memory-filenames-encode-date-and-slug]]
