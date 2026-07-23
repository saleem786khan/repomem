"use strict";
// Tests run against the compiled output in dist/ (the actual shipped artifact).
// Run with: npm test   (builds first, then `node --test`)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { execFileSync } = require("node:child_process");

const store = require("../dist/store/file-store.js");
const remote = require("../dist/store/remote.js");
const config = require("../dist/config/config.js");
const util = require("../dist/tools/util.js");
const { memSave } = require("../dist/tools/mem-save.js");
const { memSearch } = require("../dist/tools/mem-search.js");
const { memContext } = require("../dist/tools/mem-context.js");
const { memHandoff } = require("../dist/tools/mem-handoff.js");
const { memGet } = require("../dist/tools/mem-get.js");
const { memPrime } = require("../dist/tools/mem-prime.js");

/** Make an isolated, initialised project root in a temp dir. */
function makeProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-test-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: name || "@acme/test-svc" })
  );
  fs.mkdirSync(path.join(root, ".repomem"), { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------
test("util.slugify produces kebab and clamps length", () => {
  assert.equal(util.slugify("Use Postgres for the Ledger!"), "use-postgres-for-the-ledger");
  assert.equal(util.slugify("   "), "untitled");
  assert.ok(util.slugify("a".repeat(200)).length <= 60);
});

test("util.today is YYYY-MM-DD", () => {
  assert.match(util.today(), /^\d{4}-\d{2}-\d{2}$/);
});

test("util.strArray handles arrays, csv strings, and junk", () => {
  assert.deepEqual(util.strArray(["a", " b ", ""]), ["a", "b"]);
  assert.deepEqual(util.strArray("x, y ,z"), ["x", "y", "z"]);
  assert.deepEqual(util.strArray(undefined), []);
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
test("config.deriveProjectName strips npm scope", () => {
  const root = makeProject("@acme/payments-service");
  assert.equal(config.deriveProjectName(root), "payments-service");
});

test("config.loadConfig falls back gracefully when file missing", () => {
  const root = makeProject("@acme/widget");
  const cfg = config.loadConfig(root);
  assert.equal(cfg.project, "widget");
  assert.deepEqual(cfg.linked, []);
});

test("config.findProjectRoot walks up to the .repomem dir", () => {
  const root = makeProject();
  const nested = path.join(root, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(config.findProjectRoot(nested), fs.realpathSync(root));
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------
test("store.isInitialized reflects presence of .repomem", () => {
  const root = makeProject();
  assert.equal(store.isInitialized(root), true);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-bare-"));
  assert.equal(store.isInitialized(bare), false);
});

test("store write/list/read round-trips and sorts newest-first", () => {
  const root = makeProject();
  store.writeFile("decisions", "2026-01-01-a.md", "# A\n", {}, root);
  store.writeFile("decisions", "2026-06-01-b.md", "# B\n", {}, root);
  const files = store.listFiles("decisions", root);
  assert.deepEqual(files, ["2026-06-01-b.md", "2026-01-01-a.md"]);
  assert.match(store.readFile("decisions", "2026-01-01-a.md", root), /# A/);
  assert.equal(store.readFile("decisions", "missing.md", root), null);
});

test("store.searchFiles scores, caps at 10, and strips front matter from excerpt", () => {
  const root = makeProject();
  for (let i = 0; i < 12; i++) {
    store.writeFile(
      "patterns",
      `2026-06-${String(i + 1).padStart(2, "0")}-p.md`,
      `---\ndate: 2026-06-01\n---\n# Pattern ${i}\nuse zod for validation\n`,
      {},
      root
    );
  }
  const results = store.searchFiles("zod validation", root);
  assert.ok(results.length <= 10, "capped at 10");
  assert.ok(results.length > 0);
  assert.equal(results[0].scope, "[current]");
  assert.ok(!results[0].excerpt.includes("---"), "excerpt has no front matter");
  assert.ok(results.every((r) => r.score > 0));
});

test("store.searchAllRepos labels linked repos by scope", () => {
  const root = makeProject("@acme/payments");
  store.writeFile("decisions", "2026-06-01-p.md", "# Pay\nuse stripe webhooks\n", {}, root);

  // A sibling linked repo with its own memory.
  const linkedRoot = path.join(path.dirname(root), "auth-" + path.basename(root));
  fs.mkdirSync(path.join(linkedRoot, ".repomem"), { recursive: true });
  store.writeFile("patterns", "2026-06-01-a.md", "# Auth\nuse stripe customer ids\n", {}, linkedRoot);

  fs.writeFileSync(
    path.join(root, "repomem.config.json"),
    JSON.stringify({
      project: "payments",
      linked: [{ repo: path.relative(root, linkedRoot), relation: "depends-on" }],
    })
  );

  const results = store.searchAllRepos("stripe", root);
  const scopes = results.map((r) => r.scope);
  assert.ok(scopes.includes("[current]"));
  assert.ok(scopes.some((s) => s.startsWith("[linked:")), "linked scope present");
});

test("store.generateIndex writes REPOMEM.md listing each entry", () => {
  const root = makeProject("@acme/widget");
  store.writeFile("decisions", "2026-06-01-x.md", "# Decision X\nbody\n", {}, root);
  const indexPath = store.generateIndex(root);
  assert.ok(indexPath && fs.existsSync(indexPath));
  const idx = fs.readFileSync(indexPath, "utf8");
  assert.match(idx, /widget — repomem index/);
  assert.match(idx, /\[Decision X\]\(decisions\/2026-06-01-x\.md\)/);
});

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------
test("mem_save guards against an uninitialised project", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-bare-"));
  const out = memSave.handler({ type: "decision", title: "x", content: "y" }, bare);
  assert.match(out, /repomem init/);
});

test("mem_save writes a decision with front matter + supersedes", () => {
  const root = makeProject();
  const out = memSave.handler(
    {
      type: "decision",
      title: "Use Postgres for ledger",
      content: "ACID guarantees.",
      tags: ["db"],
      supersedes: "2025-01-01-old.md",
    },
    root
  );
  assert.match(out, /Saved decisions\/2026-.*-use-postgres-for-ledger\.md/);
  assert.match(out, /supersedes 2025-01-01-old\.md/);
  const files = store.listFiles("decisions", root);
  const raw = store.readFile("decisions", files[0], root);
  assert.match(raw, /^---/);
  assert.match(raw, /tags: \[db\]/);
  assert.match(raw, /supersedes: 2025-01-01-old\.md/);
  assert.match(raw, /# Use Postgres for ledger/);
});

test("mem_save appends sessions for the same day into one file", () => {
  const root = makeProject();
  memSave.handler({ type: "session", title: "Morning", content: "did A" }, root);
  memSave.handler({ type: "session", title: "Afternoon", content: "did B" }, root);
  const files = store.listFiles("sessions", root);
  assert.equal(files.length, 1, "one session file per day");
  const raw = store.readFile("sessions", files[0], root);
  assert.match(raw, /Morning/);
  assert.match(raw, /Afternoon/);
});

test("mem_save rejects unknown type", () => {
  const root = makeProject();
  const out = memSave.handler({ type: "nonsense", title: "x", content: "y" }, root);
  assert.match(out, /Unknown type/);
});

test("mem_search returns ranked hits and a not-found message", () => {
  const root = makeProject();
  memSave.handler({ type: "issue", title: "Flaky CI", content: "retry the docker build" }, root);
  const hit = memSearch.handler({ query: "docker build" }, root);
  assert.match(hit, /Found 1 match/);
  assert.match(hit, /\[current\]/);
  const miss = memSearch.handler({ query: "kubernetes helm" }, root);
  assert.match(miss, /No memory found/);
});

test("mem_context brief and full assemble a packet", () => {
  const root = makeProject("@acme/widget");
  memSave.handler({ type: "decision", title: "Pick X", content: "because" }, root);
  memSave.handler({ type: "pattern", title: "Repo pattern", content: "funnel IO" }, root);
  memSave.handler({ type: "issue", title: "Gotcha", content: "watch out" }, root);

  const brief = memContext.handler({ brief: true }, root);
  assert.match(brief, /widget: 1 decisions, 1 patterns, 1 issues/);

  const full = memContext.handler({}, root);
  assert.match(full, /# Context for widget/);
  assert.match(full, /## Recent decisions/);
  assert.match(full, /Pick X/);
  assert.match(full, /## Patterns/);
  assert.match(full, /Repo pattern/);
  assert.match(full, /## Known issues/);
  assert.match(full, /Gotcha/);
});

test("mem_handoff writes structured handoff and commit reminder", () => {
  const root = makeProject();
  const out = memHandoff.handler(
    {
      summary: "Built the store layer",
      done: ["file-store.ts", "config.ts"],
      next: ["wire MCP server"],
      blockers: ["zod v4 compat"],
    },
    root
  );
  assert.match(out, /Handoff written to sessions\//);
  assert.match(out, /git add \.repomem/);
  const files = store.listFiles("sessions", root);
  const raw = store.readFile("sessions", files[0], root);
  assert.match(raw, /Handoff/);
  assert.match(raw, /\*\*Done:\*\*/);
  assert.match(raw, /- file-store\.ts/);
  assert.match(raw, /\*\*Next:\*\*/);
  assert.match(raw, /\*\*Blockers:\*\*/);
});

test("mem_handoff requires a summary", () => {
  const root = makeProject();
  const out = memHandoff.handler({}, root);
  assert.match(out, /summary is required/);
});

// ---------------------------------------------------------------------------
// cli setup — runs the shipped CLI as a subprocess and checks the files each
// agent actually reads for project-scoped MCP servers.
// ---------------------------------------------------------------------------
const CLI = path.join(__dirname, "..", "dist", "cli.js");
function runCli(root, ...args) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
}

/** Run the CLI without throwing; return { code, out } where out = stdout+stderr. */
function cliResult(root, ...args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}

test("cli setup claude-code writes .mcp.json at repo root (not .claude/)", () => {
  const root = makeProject();
  runCli(root, "setup", "claude-code");
  assert.ok(!fs.existsSync(path.join(root, ".claude", "mcp.json")), "must not use .claude/mcp.json");
  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.equal(cfg.mcpServers.repomem.command, "npx");
  assert.deepEqual(cfg.mcpServers.repomem.args, ["@saleem11kh/repomem"]);
});

test("cli setup codex writes TOML and is idempotent", () => {
  const root = makeProject();
  runCli(root, "setup", "codex");
  const tomlPath = path.join(root, ".codex", "config.toml");
  const toml = fs.readFileSync(tomlPath, "utf8");
  assert.match(toml, /^\[mcp_servers\.repomem\]/m);
  assert.match(toml, /command = "npx"/);
  assert.match(toml, /args = \["@saleem11kh\/repomem"\]/);
  // second run must not duplicate the block
  const second = runCli(root, "setup", "codex");
  assert.match(second, /already configured/);
  assert.equal(fs.readFileSync(tomlPath, "utf8").match(/\[mcp_servers\.repomem\]/g).length, 1);
});

test("cli setup codex preserves existing TOML config", () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  const tomlPath = path.join(root, ".codex", "config.toml");
  fs.writeFileSync(tomlPath, 'model = "gpt-5"\n');
  runCli(root, "setup", "codex");
  const toml = fs.readFileSync(tomlPath, "utf8");
  assert.match(toml, /model = "gpt-5"/, "must keep pre-existing config");
  assert.match(toml, /\[mcp_servers\.repomem\]/, "must add repomem block");
});

test("cli setup rejects an unknown agent", () => {
  const root = makeProject();
  assert.throws(() => runCli(root, "setup", "notanagent"));
});

// ---------------------------------------------------------------------------
// search ranking — TF-IDF + recency
// ---------------------------------------------------------------------------
test("search ranks the rare, discriminating term above common-term spam", () => {
  const root = makeProject();
  for (let i = 0; i < 6; i++) {
    store.writeFile("patterns", `2026-06-0${i + 1}-common.md`, "# c\nthe the the the service the", {}, root);
  }
  store.writeFile("decisions", "2026-06-01-rare.md", "# Rare\nthe kafka broker", {}, root);
  const results = store.searchFiles("the kafka", root);
  assert.ok(results[0].file.includes("rare"), "doc with rare term must rank first");
});

test("search applies a recency boost to newer memory", () => {
  const root = makeProject();
  store.writeFile("sessions", "2020-01-01-old.md", "# old\nrefactor the auth module", {}, root);
  store.writeFile("sessions", "2026-07-01-new.md", "# new\nrefactor the auth module", {}, root);
  const results = store.searchFiles("refactor auth", root);
  assert.ok(results[0].file.includes("new"), "newer of two equal matches must rank first");
});

// ---------------------------------------------------------------------------
// import — inverse of `repomem sync`
// ---------------------------------------------------------------------------
test("importBundle round-trips a sync export back into .repomem/", () => {
  const root = makeProject();
  const bundle = [
    "# repomem export — demo",
    "",
    "## decisions",
    "",
    "### decisions/2026-06-01-pg.md",
    "",
    "# Use Postgres",
    "ACID for the ledger.",
    "",
    "### patterns/2026-06-02-zod.md",
    "",
    "# Validate with zod",
    "",
  ].join("\n");
  const written = store.importBundle(bundle, root);
  assert.deepEqual(written.sort(), ["decisions/2026-06-01-pg.md", "patterns/2026-06-02-zod.md"]);
  const pg = store.readFile("decisions", "2026-06-01-pg.md", root);
  assert.match(pg, /^# Use Postgres/, "no leading blank line, front matter preserved");
  assert.match(pg, /ACID for the ledger\./);
});

test("importBundle ignores unrecognised sections", () => {
  const root = makeProject();
  const written = store.importBundle("### notes/foo.md\n\nhello\n", root);
  assert.deepEqual(written, []);
});

// ---------------------------------------------------------------------------
// remote linked repos
// ---------------------------------------------------------------------------
test("remote.parseRemote recognises github specs and rejects local paths", () => {
  assert.deepEqual(remote.parseRemote("github:acme/auth"), { owner: "acme", name: "auth", ref: "HEAD" });
  assert.deepEqual(remote.parseRemote("github:acme/auth#dev"), { owner: "acme", name: "auth", ref: "dev" });
  assert.deepEqual(remote.parseRemote("https://github.com/acme/auth/tree/main"), {
    owner: "acme",
    name: "auth",
    ref: "main",
  });
  assert.equal(remote.parseRemote("../auth-service"), null);
  assert.equal(remote.parseRemote("./local"), null);
});

test("searchAllRepos searches a pulled remote's cache with a [remote:] scope", () => {
  const root = makeProject("@acme/payments");
  store.writeFile("decisions", "2026-06-01-p.md", "# Pay\nuse stripe webhooks", {}, root);
  const ref = remote.parseRemote("github:acme/auth");
  const cacheRoot = store.remoteCacheRoot(root, ref);
  store.writeFile("patterns", "2026-06-01-a.md", "# Auth\nstripe customer ids", {}, cacheRoot);

  const cfg = { project: "payments", linked: [{ repo: "github:acme/auth" }] };
  const results = store.searchAllRepos("stripe", root, cfg);
  const scopes = results.map((r) => r.scope);
  assert.ok(scopes.includes("[current]"));
  assert.ok(scopes.includes("[remote:auth]"), "remote scope present");
});

test("fetchRemoteRepomem writes .repomem/ md files from the GitHub API", async () => {
  const savedFetch = global.fetch;
  const blob = Buffer.from("# Auth decision\nuse jwt\n", "utf8").toString("base64");
  global.fetch = async (url) => {
    if (String(url).includes("/git/trees/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tree: [
            { path: ".repomem/decisions/2026-06-01-a.md", type: "blob", sha: "sha1" },
            { path: "README.md", type: "blob", sha: "sha2" }, // must be ignored
            { path: ".repomem/decisions", type: "tree", sha: "sha3" }, // dir, ignored
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ content: blob, encoding: "base64" }) };
  };
  try {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-remote-"));
    const destRepomem = path.join(dest, ".repomem");
    const count = await remote.fetchRemoteRepomem({ owner: "acme", name: "auth", ref: "HEAD" }, destRepomem);
    assert.equal(count, 1, "only the one .repomem/*.md blob is written");
    const written = fs.readFileSync(path.join(destRepomem, "decisions", "2026-06-01-a.md"), "utf8");
    assert.match(written, /use jwt/);
  } finally {
    global.fetch = savedFetch;
  }
});

// ---------------------------------------------------------------------------
// summaries, mem_get, wikilink graph, mem_prime
// ---------------------------------------------------------------------------
test("mem_save writes a summary front-matter field and renders links as [[wikilinks]]", () => {
  const root = makeProject();
  memSave.handler(
    {
      type: "pattern",
      title: "Funnel IO",
      content: "All disk access via file-store.",
      summary: "Centralize filesystem access in one module.",
      links: ["Use Postgres for ledger"],
    },
    root
  );
  const raw = store.readFile("patterns", store.listFiles("patterns", root)[0], root);
  assert.match(raw, /summary: Centralize filesystem access in one module\./);
  assert.match(raw, /\[\[use-postgres-for-ledger\]\]/, "links become slugged wikilinks");
});

test("summaryOf prefers front matter, else first prose line", () => {
  assert.equal(
    store.summaryOf("---\nsummary: Explicit one.\n---\n# T\nbody text", "x.md"),
    "Explicit one."
  );
  assert.equal(store.summaryOf("# Title\nFirst prose line here.", "x.md"), "First prose line here.");
});

test("mem_context returns one-line summaries, not full bodies (token-lean)", () => {
  const root = makeProject("@acme/widget");
  memSave.handler(
    { type: "pattern", title: "Repo pattern", content: "LONG_BODY_MARKER should not appear", summary: "short summary" },
    root
  );
  const full = memContext.handler({}, root);
  assert.match(full, /## Patterns/);
  assert.match(full, /Repo pattern — short summary/);
  assert.ok(!full.includes("LONG_BODY_MARKER"), "full body must not be inlined");
  assert.match(full, /mem_get/, "points at mem_get to expand");
});

test("mem_get resolves by type/filename and by [[wikilink]] slug, listing related", () => {
  const root = makeProject();
  memSave.handler({ type: "decision", title: "Use Postgres for ledger", content: "ACID." }, root);
  memSave.handler(
    { type: "pattern", title: "Funnel IO", content: "via store", links: ["use-postgres-for-ledger"] },
    root
  );
  const dfile = store.listFiles("decisions", root)[0];

  const byPath = memGet.handler({ file: `decisions/${dfile}` }, root);
  assert.match(byPath, /# Use Postgres for ledger/);

  const bySlug = memGet.handler({ file: "funnel-io" }, root);
  assert.match(bySlug, /# Funnel IO/);
  assert.match(bySlug, /Related entries/);
  assert.match(bySlug, /Use Postgres for ledger/);

  assert.match(memGet.handler({ file: "nope-xyz" }, root), /No memory entry matches/);
});

test("wikilink resolveLink and relatedOf traverse links", () => {
  const root = makeProject();
  memSave.handler({ type: "decision", title: "Use Postgres for ledger", content: "ACID." }, root);
  const hit = store.resolveLink("use-postgres-for-ledger", root);
  assert.equal(hit.type, "decisions");
  assert.match(hit.title, /Use Postgres for ledger/);
  const related = store.relatedOf("see [[use-postgres-for-ledger]]", root);
  assert.equal(related.length, 1);
});

test("mem_search surfaces related wikilinks", () => {
  const root = makeProject();
  memSave.handler({ type: "decision", title: "Use Postgres for ledger", content: "ACID." }, root);
  memSave.handler(
    { type: "pattern", title: "Funnel IO", content: "route disk access via store", links: ["use-postgres-for-ledger"] },
    root
  );
  const out = memSearch.handler({ query: "disk access" }, root);
  assert.match(out, /→ related: Use Postgres for ledger/);
});

test("mem_prime bundles existing project docs with instructions", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Demo\nUse Postgres for the ledger.\n");
  const out = memPrime.handler({}, root);
  assert.match(out, /priming packet/);
  assert.match(out, /## Sources/);
  assert.match(out, /CLAUDE\.md/);
  assert.match(out, /Use Postgres for the ledger/);
});

test("mem_prime reports when there is nothing to prime from", () => {
  const root = makeProject();
  const out = memPrime.handler({}, root);
  assert.match(out, /No source docs found/);
});

test("mem_get and mem_prime guard an uninitialised project", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-bare-"));
  assert.match(memGet.handler({ file: "x" }, bare), /repomem init/);
  assert.match(memPrime.handler({}, bare), /repomem init/);
});

// ===========================================================================
// END-TO-END — drive the real shipped artifacts as subprocesses:
//   * the MCP server over stdio JSON-RPC (how agents call it)
//   * the CLI binary (how humans call it)
// ===========================================================================

/**
 * Run a full MCP session: initialize, then one tools/call per entry in `calls`.
 * Returns the text of each tool result, in order. Drives dist/cli.js (no args →
 * MCP server) exactly as an agent would.
 */
function mcp(root, calls) {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    },
    ...calls.map((c, i) => ({
      jsonrpc: "2.0",
      id: i + 2,
      method: "tools/call",
      params: { name: c.name, arguments: c.arguments || {} },
    })),
  ];
  const input = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const out = execFileSync(process.execPath, [CLI], {
    cwd: root,
    input,
    encoding: "utf8",
    timeout: 20000,
  });
  const byId = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.id != null) byId.set(j.id, j);
    } catch {
      /* non-JSON stray line */
    }
  }
  return calls.map((_, i) => {
    const resp = byId.get(i + 2);
    if (!resp) return { text: "", isError: true, missing: true };
    const text = resp.result?.content?.[0]?.text ?? "";
    return { text, isError: resp.result?.isError === true };
  });
}

function initProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-e2e-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: name || "e2e-svc" }));
  runCli(root, "init");
  return root;
}

test("e2e MCP: initialize + tools/list exposes all six tools", () => {
  const root = initProject();
  const input =
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
    "\n";
  const out = execFileSync(process.execPath, [CLI], { cwd: root, input, encoding: "utf8", timeout: 20000 });
  const listResp = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((j) => j && j.id === 2);
  const names = listResp.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["mem_context", "mem_get", "mem_handoff", "mem_prime", "mem_save", "mem_search"]);
});

test("e2e MCP: full save → context → search → get → handoff workflow", () => {
  const root = initProject("@acme/shop");
  const [save, ctx, search, get, handoff] = mcp(root, [
    {
      name: "mem_save",
      arguments: {
        type: "decision",
        title: "Use Postgres for ledger",
        content: "ACID guarantees for money.",
        summary: "Postgres over Mongo for the ledger.",
      },
    },
    { name: "mem_context", arguments: {} },
    { name: "mem_search", arguments: { query: "postgres ledger" } },
    { name: "mem_get", arguments: { file: "use-postgres-for-ledger" } },
    { name: "mem_handoff", arguments: { summary: "wired the store", next: ["ship it"] } },
  ]);

  assert.match(save.text, /Saved decisions\/.*use-postgres-for-ledger\.md/);
  assert.match(ctx.text, /# Context for shop/);
  assert.match(ctx.text, /Use Postgres for ledger — Postgres over Mongo/);
  assert.ok(!ctx.text.includes("ACID guarantees for money"), "context must not inline full body");
  assert.match(search.text, /Found 1 match/);
  assert.match(get.text, /ACID guarantees for money/, "mem_get expands the full body");
  assert.match(handoff.text, /Handoff written to sessions\//);

  // The handoff actually persisted a session file on disk.
  assert.equal(store.listFiles("sessions", root).length, 1);
});

test("e2e MCP: unknown tool and uninitialised project are handled, not crashed", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-e2e-bare-"));
  fs.writeFileSync(path.join(bare, "package.json"), "{}");
  const [ctx] = mcp(bare, [{ name: "mem_context", arguments: {} }]);
  assert.match(ctx.text, /repomem init/);

  const root = initProject();
  const [unknown] = mcp(root, [{ name: "no_such_tool", arguments: {} }]);
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown tool/);
});

test("e2e CLI: init → save (via MCP) → status → sync → import round-trips across repos", () => {
  const a = initProject("@acme/alpha");
  mcp(a, [
    { name: "mem_save", arguments: { type: "decision", title: "Pick Redis", content: "cache layer", summary: "Redis for cache" } },
    { name: "mem_save", arguments: { type: "pattern", title: "Retry with jitter", content: "backoff + jitter" } },
  ]);

  const status = runCli(a, "status");
  assert.match(status, /alpha/);
  assert.match(status, /decisions\s+1/);
  assert.match(status, /patterns\s+1/);

  const bundle = runCli(a, "sync");
  assert.match(bundle, /## decisions/);
  assert.match(bundle, /Pick Redis/);

  // Import the bundle (via stdin) into a fresh repo.
  const b = initProject("@acme/beta");
  const bundlePath = path.join(b, "bundle.md");
  fs.writeFileSync(bundlePath, bundle);
  const imported = runCli(b, "import", "bundle.md");
  assert.match(imported, /Imported 2 file/);
  assert.equal(store.listFiles("decisions", b).length, 1);
  assert.equal(store.listFiles("patterns", b).length, 1);
  const pg = store.readFile("decisions", store.listFiles("decisions", b)[0], b);
  assert.match(pg, /summary: Redis for cache/, "front matter survives the round-trip");
});

test("e2e CLI: subcommands guard, help, and pull-with-no-remotes behave", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-e2e-guard-"));
  fs.writeFileSync(path.join(bare, "package.json"), "{}");

  const status = cliResult(bare, "status");
  assert.equal(status.code, 1, "status exits non-zero when uninitialised");
  assert.match(status.out, /repomem init/);

  const sync = cliResult(bare, "sync");
  assert.equal(sync.code, 1, "sync exits non-zero when uninitialised");
  assert.match(sync.out, /repomem init/);

  const help = runCli(bare, "help");
  for (const cmd of ["init", "setup", "status", "sync", "import", "pull"]) {
    assert.match(help, new RegExp(`\\b${cmd}\\b`), `help lists ${cmd}`);
  }

  const root = initProject();
  const pull = runCli(root, "pull");
  assert.match(pull, /No remote linked repos/);
});
