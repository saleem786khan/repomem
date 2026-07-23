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
