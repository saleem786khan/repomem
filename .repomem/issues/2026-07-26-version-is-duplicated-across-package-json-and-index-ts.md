---
date: 2026-07-26
summary: The version string lives in both package.json and a hardcoded VERSION const in src/index.ts — bump one and the MCP server misreports itself.
tags: [release, maintenance]
---
# Version is duplicated across package.json and index.ts

`src/index.ts` declares `const VERSION = "0.3.1"` and passes it to the MCP `Server`
constructor and the ready log. `package.json` carries the same number independently.
Nothing checks that they agree.

Bump only `package.json` (which is what `npm version` does) and the published server
reports the previous version over the wire — to every connected agent, in
`initialize` responses, silently. No test catches it: the e2e MCP tests assert the
tool list, not `serverInfo.version`.

This was caught by hand during the v0.3.1 release. It will not be caught next time.

Fix: `require("../package.json").version` in `src/index.ts` (dist sits one level down,
and npm always includes package.json in the tarball regardless of the `files` array).
Needs `resolveJsonModule` in `tsconfig.json`. Alternative: assert the two match in a
test — cheaper, and fails loudly at release time.

Related: [[mcp-configs-must-route-through-cmd-exe-on-windows]]
