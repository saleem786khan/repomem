# Contributing to repomem

repomem is being built in public. Contributions are welcome at any stage —
bug reports, feature ideas, docs, and code.

## Getting started

```bash
git clone https://github.com/saleem786khan/repomem
cd repomem
npm install
npm run build
npm test
```

- `npm run build` — compile TypeScript to `dist/`
- `npm test` — build, then run the test suite (`node --test`)
- `npm run dev` — run the CLI from source via ts-node (e.g. `npm run dev -- status`)

## Project layout

```
src/
  index.ts          MCP server entry (stdio) — exports startServer()
  cli.ts            bin entry: init / setup / status / sync / import / pull; no args → MCP server
  config/config.ts  loads repomem.config.json, finds the project root
  store/file-store.ts  local disk store: read/write/search/index + import
  store/remote.ts   remote linked repos: parse github specs, fetch .repomem/ from the GitHub API
  tools/            the 4 MCP tools (mem_save, mem_search, mem_context, mem_handoff)
test/               node:test suite, run against the compiled dist/
```

## Architecture rules

These keep the codebase easy to evolve — please follow them in PRs:

1. **Filesystem access lives in the store layer (`src/store/`).** Tools contain
   logic only and never touch disk; `file-store.ts` owns the local `.repomem/`
   store and `remote.ts` owns fetching remote repos. This keeps the storage
   backend swappable later.
2. **Tools return plain text, never JSON blobs.** Agents read text naturally.
3. **No bare `@modelcontextprotocol/sdk` imports** — the package's root CJS
   entry is missing. Always import from explicit subpaths
   (`@modelcontextprotocol/sdk/server/index.js`, `.../server/stdio.js`,
   `.../types.js`).
4. **Handle a missing `.repomem/` gracefully** — return a helpful message
   pointing at `repomem init`, never crash.

## Testing

Every new tool or store function should come with a test in
`test/repomem.test.js`. Tests run against the compiled `dist/` output and use
isolated temp directories — see `makeProject()` for the pattern.

## Pull requests

- Keep changes focused; one concern per PR.
- Run `npm test` before pushing.
- Describe the user-facing change and why it matters.

Good first issues will be labelled as the project grows. If you have the exact
problem repomem solves, opening an issue describing your setup is just as
valuable as code.
