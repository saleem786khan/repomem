"use strict";
// Tests run against the compiled output in dist/ (the actual shipped artifact).
// Run with: npm test   (builds first, then `node --test`)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../dist/store/file-store.js");
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
