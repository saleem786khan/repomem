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

const session = require("../dist/tools/session.js");

test("mem_save appends within one session to a single file", () => {
  session.resetSession();
  const root = makeProject();
  memSave.handler({ type: "session", title: "Morning", content: "did A" }, root);
  memSave.handler({ type: "session", title: "Afternoon", content: "did B" }, root);
  const files = store.listFiles("sessions", root);
  assert.equal(files.length, 1, "one file per session, not per write");
  const raw = store.readFile("sessions", files[0], root);
  assert.match(raw, /Morning/);
  assert.match(raw, /Afternoon/);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}-\d{4}-/, "filename carries the start time");
});

test("session files are named, and naming renames the file in place", () => {
  session.resetSession();
  const root = makeProject();
  memSave.handler({ type: "session", title: "Start", content: "poking around" }, root);
  const before = store.listFiles("sessions", root);
  assert.match(before[0], /-untitled\.md$/, "unnamed sessions fall back to untitled");

  memSave.handler(
    { type: "session", title: "Now I know", content: "it is the auth work", session: "auth-refactor" },
    root
  );
  const after = store.listFiles("sessions", root);
  assert.equal(after.length, 1, "renamed, not duplicated");
  assert.match(after[0], /-auth-refactor\.md$/);
  const raw = store.readFile("sessions", after[0], root);
  assert.match(raw, /poking around/, "content written before the rename survives");
  assert.match(raw, /it is the auth work/);
});

test("parallel sessions on one day get separate files, even in the same minute", () => {
  const root = makeProject();
  session.resetSession();
  memHandoff.handler({ summary: "agent one work", session: "auth-refactor" }, root);
  session.resetSession(); // a second session starting alongside the first
  memHandoff.handler({ summary: "agent two work", session: "auth-refactor" }, root);

  const files = store.listFiles("sessions", root);
  assert.equal(files.length, 2, "two sessions must never share a file");
  const bodies = files.map((f) => store.readFile("sessions", f, root));
  assert.equal(
    bodies.filter((b) => b.includes("agent one work")).length,
    1,
    "each session's work lands in exactly one file"
  );
  assert.ok(
    bodies.some((b) => b.includes("agent two work")),
    "the colliding session must still be written"
  );
});

test("session front matter records name, start, and connected agent", () => {
  session.resetSession();
  session.setSessionAgent("claude-code");
  const root = makeProject();
  memHandoff.handler({ summary: "shipped the thing", session: "release-work" }, root);

  const raw = store.readFile("sessions", store.listFiles("sessions", root)[0], root);
  assert.match(raw, /^---/, "sessions now carry front matter like every other type");
  assert.match(raw, /session: release-work/);
  assert.match(raw, /agent: claude-code/);
  assert.match(raw, /started: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(raw, /summary: shipped the thing/);
  assert.equal(
    store.summaryOf(raw, "x.md"),
    "shipped the thing",
    "the summary field makes sessions summarisable"
  );
});

test("mem_context names parallel sessions without inlining them", () => {
  const root = makeProject();
  session.resetSession();
  memHandoff.handler({ summary: "the auth work", session: "auth-refactor" }, root);
  session.resetSession();
  memHandoff.handler({ summary: "the docs work", session: "docs-pass" }, root);

  const full = memContext.handler({}, root);
  assert.match(full, /## Also today/, "parallel sessions must be visible");
  const [inlined, alsoToday] = full.split("## Also today");
  assert.match(alsoToday, /auth-refactor|docs-pass/);
  // Exactly one session is inlined; the other appears only as a one-liner.
  assert.ok(
    (inlined.match(/the auth work/) ? 1 : 0) + (inlined.match(/the docs work/) ? 1 : 0) === 1,
    "only the newest session is inlined"
  );
});

test("[[wikilinks]] resolve to a timed session file", () => {
  session.resetSession();
  const root = makeProject();
  memHandoff.handler({ summary: "the auth work", session: "auth-refactor" }, root);
  const hit = store.resolveLink("auth-refactor", root);
  assert.ok(hit, "the HHMM prefix must not break slug resolution");
  assert.equal(hit.type, "sessions");
});

test("listFiles orders a timed session after a legacy whole-day file", () => {
  const root = makeProject();
  // `-` sorts before `.`, so a raw name sort would call the legacy file newer.
  store.writeFile("sessions", "2026-07-26.md", "# legacy day file\n", {}, root);
  store.writeFile("sessions", "2026-07-26-0917-morning.md", "# timed\n", {}, root);
  assert.equal(
    store.listFiles("sessions", root)[0],
    "2026-07-26-0917-morning.md",
    "a timed session that day is newer than the legacy day file"
  );
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

test("mem_context inlines only the newest handoff block, not the whole day", () => {
  const root = makeProject();
  memHandoff.handler({ summary: "morning work", next: ["ship the thing"] }, root);
  memHandoff.handler({ summary: "afternoon work", next: ["review the PR"] }, root);

  const full = memContext.handler({}, root);
  assert.match(full, /afternoon work/, "must carry the newest handoff");
  assert.ok(!full.includes("morning work"), "must not inline earlier handoffs from the same day");
});

test("mem_context drops Done from a long session but keeps Next and Blockers", () => {
  const root = makeProject();
  memHandoff.handler(
    {
      summary: "a very busy day",
      done: Array.from({ length: 30 }, (_, i) => `finished task ${i}`),
      next: ["the one thing that matters"],
      blockers: ["waiting on review"],
    },
    root
  );

  const full = memContext.handler({}, root);
  assert.match(full, /a very busy day/, "keeps the summary");
  assert.match(full, /the one thing that matters/, "keeps Next");
  assert.match(full, /waiting on review/, "keeps Blockers");
  assert.ok(!full.includes("finished task 0"), "drops the Done history");
  assert.match(full, /Trimmed — full session via mem_get/);

  // The untrimmed file is still there in full for mem_get to expand.
  const raw = fs.readFileSync(
    path.join(root, ".repomem", "sessions", fs.readdirSync(path.join(root, ".repomem", "sessions"))[0]),
    "utf8"
  );
  assert.match(raw, /finished task 0/, "the session file itself must keep everything");
});

// ---------------------------------------------------------------------------
// task-scoped context and token budgets
// ---------------------------------------------------------------------------

/**
 * A project where recency and relevance genuinely disagree: the entry that
 * matters is the OLDEST, so anything ranking by date buries it. Dates are
 * written into filenames directly — entries saved through mem_save all share
 * today's date, which makes "recency" collapse into alphabetical order.
 */
function makeBusyProject() {
  const root = makeProject();
  const write = (type, date, slug, title, summary, body) =>
    store.writeFile(
      type,
      `${date}-${slug}.md`,
      `---\ndate: ${date}\nsummary: ${summary}\n---\n# ${title}\n\n${body}\n`,
      {},
      root
    );

  write("issues", "2020-01-01", "windows-spawn-fails", "Windows spawn fails",
    "npx cannot be spawned on Windows", "npx is a cmd shim and ENOENTs");
  write("decisions", "2020-01-02", "use-postgres", "Use Postgres",
    "Postgres for transactions", "we need transactions");
  write("patterns", "2020-01-03", "funnel-io", "Funnel IO through the store",
    "IO goes through the store layer", "all reads go via file-store");

  // Enough padding that a half-size budget still leaves room for entries —
  // below roughly 150 tokens the packet floor dominates and the budget path
  // degrades to the brief form instead, which is a different behaviour.
  for (let i = 0; i < 18; i++) {
    write("issues", `2026-07-${String(i + 1).padStart(2, "0")}`, `filler-${i}`,
      `Filler issue ${i}`, `padding number ${i} about unrelated kittens and weather`,
      "unrelated padding about kittens");
  }
  return root;
}

test("mem_context ranks by relevance when given a task", () => {
  const root = makeBusyProject();

  const byRecency = memContext.handler({}, root);
  const recencyIssues = byRecency.split("## Known issues")[1];
  assert.ok(
    !recencyIssues.split("\n").slice(1, 3).join(" ").includes("Windows spawn"),
    "without a task the oldest entry is nowhere near the top"
  );

  const byTask = memContext.handler({ task: "windows spawn ENOENT npx" }, root);
  assert.match(byTask, /_Ranked by relevance to: windows spawn ENOENT npx_/);
  assert.match(byTask, /## Relevant issues/, "headings must not claim recency order");
  const taskIssues = byTask.split("## Relevant issues")[1];
  assert.match(
    taskIssues.split("\n")[1],
    /Windows spawn fails/,
    "the entry that bears on the task must lead"
  );
});

test("mem_context respects a token budget and reports what it dropped", () => {
  const root = makeBusyProject();
  const full = memContext.handler({}, root);
  const fullTokens = Math.ceil(full.length / 4);

  const budget = Math.floor(fullTokens / 2);
  const capped = memContext.handler({ task: "windows spawn", budget }, root);
  assert.ok(
    Math.ceil(capped.length / 4) <= budget,
    `packet must fit the budget (${Math.ceil(capped.length / 4)} > ${budget})`
  );
  assert.match(capped, /further entries not shown \(token budget/, "no silent truncation");
  assert.match(capped, /Windows spawn fails/, "what survives must be the most relevant");
});

test("mem_context falls back to the brief form when the budget is below the floor", () => {
  const root = makeBusyProject();
  const tiny = memContext.handler({ budget: 60 }, root);
  assert.match(tiny, /decisions, .* patterns, .* issues/, "degrades to the one-line summary");
  assert.match(tiny, /A full packet needs ~\d+ tokens but the budget was 60/);
  assert.ok(!tiny.includes("## Known issues"), "no half-built packet");
});

test("mem_context caps entries per type even with no budget", () => {
  const root = makeProject();
  for (let i = 0; i < 30; i++) {
    memSave.handler({ type: "issue", title: `Issue number ${i}`, content: "x" }, root);
  }
  const full = memContext.handler({}, root);
  const listed = (full.split("## Known issues")[1] || "").match(/^- /gm) || [];
  assert.ok(listed.length <= 20, `issues must be capped, got ${listed.length}`);
  assert.match(full, /further entries not shown/, "the cap must be declared");
});

test("scoreEntries is the single ranking used by search and context", () => {
  const root = makeBusyProject();
  const scored = store.scoreEntries("windows spawn ENOENT", root);
  assert.ok(scored.length > 0);
  assert.match(scored[0].filename, /windows-spawn-fails/);
  for (let i = 1; i < scored.length; i++) {
    assert.ok(scored[i - 1].score >= scored[i].score, "must come back sorted");
  }
  // The same ranking must drive mem_search's top hit.
  const searched = memSearch.handler({ query: "windows spawn ENOENT" }, root);
  assert.match(searched.split("\n")[2], /Windows spawn fails/);
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
// git-derived handoffs — the factual half of a handoff comes from the repo, not
// from the agent's recollection.
// ---------------------------------------------------------------------------

/** An initialised project that is also a real git repo with one old commit. */
function makeGitProject() {
  const root = makeProject();
  const run = (args, extraEnv) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...extraEnv },
    });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "old.txt"), "old\n");
  run(["add", "."]);
  // Backdated so it falls outside any session window.
  const old = "2020-01-01T00:00:00";
  run(["commit", "-q", "-m", "chore: ancient history"], {
    GIT_AUTHOR_DATE: old,
    GIT_COMMITTER_DATE: old,
  });
  return { root, run };
}

test("mem_handoff fills Committed from commits made since the session began", () => {
  session.resetSession();
  const { root, run } = makeGitProject();
  fs.writeFileSync(path.join(root, "feature.txt"), "new\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "feat: add the feature"]);

  const raw = store.readFile(
    "sessions",
    (memHandoff.handler({ summary: "did the work" }, root),
    store.listFiles("sessions", root)[0]),
    root
  );
  assert.match(raw, /\*\*Committed this session:\*\*/);
  assert.match(raw, /feat: add the feature/);
  assert.ok(
    !raw.includes("ancient history"),
    "commits from before the session must not be claimed"
  );
});

test("mem_handoff lists uncommitted work but ignores its own .repomem writes", () => {
  session.resetSession();
  const { root } = makeGitProject();
  fs.writeFileSync(path.join(root, "wip.txt"), "half done\n");

  memHandoff.handler({ summary: "left things in flight" }, root);
  const raw = store.readFile("sessions", store.listFiles("sessions", root)[0], root);
  const uncommitted = raw.split("**Still uncommitted:**")[1] || "";
  assert.match(raw, /\*\*Still uncommitted:\*\*/);
  assert.match(uncommitted, /wip\.txt/);
  // Matched loosely on purpose: a leading-space parsing bug once turned
  // ".repomem/…" into "repomem/…", which slipped past a `.repomem/` check.
  assert.ok(!/repomem/i.test(uncommitted), "the handoff must not report itself as churn");
});

test("git status parsing keeps the leading status columns intact", () => {
  const gitStore = require("../dist/store/git.js");
  const { root } = makeGitProject();
  fs.writeFileSync(path.join(root, "a-sorts-first.txt"), "x\n");
  fs.writeFileSync(path.join(root, "z-sorts-last.txt"), "y\n");
  const activity = gitStore.activitySince("2019-01-01 00:00", root);
  for (const entry of activity.changed) {
    assert.match(
      entry,
      /^[A-Z?!]{1,2} \S/,
      `every entry needs its status code and a whole path, got "${entry}"`
    );
  }
  assert.ok(
    activity.changed.some((e) => e.endsWith("a-sorts-first.txt")),
    "the first porcelain line must survive parsing with its path intact"
  );
});

test("mem_handoff records the branch", () => {
  session.resetSession();
  const { root, run } = makeGitProject();
  run(["checkout", "-q", "-b", "feature/auth"]);
  memHandoff.handler({ summary: "on a branch" }, root);
  const raw = store.readFile("sessions", store.listFiles("sessions", root)[0], root);
  assert.match(raw, /_branch: feature\/auth_/);
});

test("mem_handoff git detail can be switched off", () => {
  session.resetSession();
  const { root } = makeGitProject();
  fs.writeFileSync(path.join(root, "wip.txt"), "half done\n");
  memHandoff.handler({ summary: "no git detail please", git: false }, root);
  const raw = store.readFile("sessions", store.listFiles("sessions", root)[0], root);
  assert.ok(!raw.includes("Still uncommitted"));
  assert.ok(!raw.includes("_branch:"));
  assert.match(raw, /no git detail please/);
});

test("mem_handoff works in a project that is not a git repo", () => {
  session.resetSession();
  const root = makeProject(); // no git init
  const out = memHandoff.handler({ summary: "no git here", next: ["carry on"] }, root);
  assert.match(out, /Handoff written/);
  const raw = store.readFile("sessions", store.listFiles("sessions", root)[0], root);
  assert.match(raw, /no git here/);
  assert.match(raw, /\*\*Next:\*\*/);
  assert.ok(!raw.includes("Committed this session"), "nothing to derive, nothing claimed");
});

test("git.activitySince returns null outside a repo and data inside one", () => {
  const gitStore = require("../dist/store/git.js");
  assert.equal(gitStore.isGitRepo(makeProject()), false);
  assert.equal(gitStore.activitySince("2020-01-01 00:00", makeProject()), null);

  const { root } = makeGitProject();
  const activity = gitStore.activitySince("2019-01-01 00:00", root);
  assert.ok(activity, "a real repo must report activity");
  assert.ok(
    activity.commits.some((c) => c.includes("ancient history")),
    "a wide enough window includes the old commit"
  );
  assert.equal(activity.moreCommits, 0);
});

// ---------------------------------------------------------------------------
// repo profiling and ADR import — what `init` can learn without a model.
// ---------------------------------------------------------------------------
const profile = require("../dist/store/profile.js");
const adr = require("../dist/store/adr.js");

test("scanProject reads stack, commands, and entry points from manifests", () => {
  const root = makeProject();
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "widget",
      type: "module",
      main: "dist/index.js",
      bin: { widget: "dist/cli.js" },
      scripts: { build: "tsc", test: "node --test", lint: "eslint ." },
      dependencies: { express: "^5", react: "^19" },
      devDependencies: { typescript: "^6", vitest: "^2", eslint: "^9" },
    })
  );

  const p = profile.scanProject(root);
  assert.ok(p.stack.includes("Node.js + TypeScript"), "typescript devDep implies TS");
  assert.ok(p.stack.includes("ESM (`type: module`)"));
  assert.ok(p.stack.includes("Express") && p.stack.includes("React"));
  assert.ok(p.stack.includes("Vitest") && p.stack.includes("ESLint"));
  assert.ok(p.commands.some((c) => c.includes("npm run build") && c.includes("tsc")));
  assert.ok(p.commands.some((c) => c.includes("npm run lint")));
  assert.ok(p.entryPoints.some((e) => e.includes("dist/index.js")));
  assert.ok(p.entryPoints.some((e) => e.includes("widget")));
});

test("scanProject detects non-Node stacks and Makefile targets", () => {
  const root = makeProject();
  fs.rmSync(path.join(root, "package.json"));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/x\n");
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM golang\n");
  fs.writeFileSync(path.join(root, "Makefile"), ".PHONY: build\nbuild:\n\tgo build\ndeploy:\n\techo\n");

  const p = profile.scanProject(root);
  assert.ok(p.stack.includes("Go"));
  assert.ok(p.stack.includes("Docker"));
  assert.ok(p.commands.some((c) => c.includes("go build ./...")));
  const makeLine = p.commands.find((c) => c.startsWith("`make"));
  assert.ok(makeLine, "Makefile targets must be listed");
  assert.ok(makeLine.includes("build") && makeLine.includes("deploy"));
  assert.ok(!makeLine.includes("PHONY"), "PHONY is not a target");
});

test("scanProject summarises layout and ignores build and vendor dirs", () => {
  const root = makeProject();
  for (const [dir, files] of [
    ["src", ["a.ts", "b.ts", "c.ts"]],
    ["docs", ["one.md"]],
    ["node_modules", ["junk.js"]],
    ["dist", ["out.js"]],
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(root, dir, f), "x\n");
  }

  const p = profile.scanProject(root);
  const dirs = p.layout.join(" ");
  assert.match(dirs, /`src\/` — 3 files, mostly \.ts/);
  assert.match(dirs, /`docs\/`/);
  assert.ok(!dirs.includes("node_modules"), "dependencies say nothing about shape");
  assert.ok(!dirs.includes("dist"), "build output says nothing about shape");
});

test("writeProfile writes .repomem/project.md and mem_context inlines it", () => {
  const root = makeProject();
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "widget", scripts: { test: "node --test" } })
  );
  const written = profile.writeProfile(root);
  assert.ok(written, "an initialised project must profile");

  const raw = fs.readFileSync(path.join(root, ".repomem", "project.md"), "utf8");
  assert.match(raw, /# widget — project profile/);
  assert.match(raw, /Do not edit by hand/);

  const full = memContext.handler({}, root);
  assert.match(full, /## Commands/, "the profile belongs at the top of the packet");
  assert.match(full, /npm run test/);
});

test("repoConventions infers commit style, tags, and hotspots from history", () => {
  const gitStore = require("../dist/store/git.js");
  const { root, run } = makeGitProject();
  for (const [file, msg] of [
    ["a.txt", "feat: add a"],
    ["a.txt", "fix: correct a"],
    ["b.txt", "feat: add b"],
  ]) {
    fs.writeFileSync(path.join(root, file), Math.random().toString());
    run(["add", "."]);
    run(["commit", "-q", "-m", msg]);
  }
  run(["tag", "v1.0.0"]);

  const c = gitStore.repoConventions(root);
  assert.ok(c.sampled >= 4);
  assert.ok(c.conventionalShare > 0.5, "most subjects here are conventional");
  assert.ok(c.topTypes.includes("feat"));
  assert.deepEqual(c.tags, ["v1.0.0"]);
  assert.ok(c.hotspots.some((h) => h.startsWith("a.txt")), "a.txt changed twice");

  const p = profile.scanProject(root);
  assert.ok(p.conventions.some((x) => /Conventional Commits/.test(x)));
  assert.ok(p.conventions.some((x) => /v1\.0\.0/.test(x)));
});

test("importAdrs imports existing ADRs and is safe to re-run", () => {
  const root = makeProject();
  const adrDir = path.join(root, "docs", "adr");
  fs.mkdirSync(adrDir, { recursive: true });
  fs.writeFileSync(
    path.join(adrDir, "0001-use-postgres.md"),
    "# Use Postgres\n\n## Status\n\nAccepted\n\n## Context\n\nWe need transactions.\n"
  );
  fs.writeFileSync(path.join(adrDir, "README.md"), "# Index\n\nnot a decision\n");

  const first = adr.importAdrs(root);
  assert.equal(first.imported.length, 1, "the index file must not be imported");
  const filename = store.listFiles("decisions", root)[0];
  const raw = store.readFile("decisions", filename, root);
  assert.match(raw, /# Use Postgres/);
  assert.match(raw, /We need transactions/);
  assert.match(raw, /source: docs\/adr\/0001-use-postgres\.md/);
  assert.match(raw, /generated: true/);
  assert.match(store.summaryOf(raw, filename), /Accepted/);

  const second = adr.importAdrs(root);
  assert.equal(second.imported.length, 0, "re-running must not duplicate");
  assert.equal(second.skipped, 1);
  assert.equal(store.listFiles("decisions", root).length, 1);
});

test("findAdrs looks in the conventional directories", () => {
  const root = makeProject();
  for (const dir of ["adr", "docs/decisions", "rfcs"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "0002-a-choice.md"), "# A choice\n\nbecause\n");
  }
  const found = adr.findAdrs(root);
  assert.equal(found.length, 3);
  assert.ok(found.every((f) => f.title === "A choice"));
});

// ---------------------------------------------------------------------------
// optional semantic search — repomem ships the cache and the maths, never a
// model, so these run against a local stub provider and never touch a network.
// ---------------------------------------------------------------------------
const embeddings = require("../dist/store/embeddings.js");

const STUB_EMBEDDER = `
const TOPICS = [
  ["windows","cmd","spawn","enoent","npx","shim"],
  ["database","postgres","sql","transaction"],
];
let text = "";
process.stdin.on("data", d => text += d);
process.stdin.on("end", () => {
  const t = text.toLowerCase();
  const v = TOPICS.map(ws => ws.reduce((n,w) => n + (t.includes(w) ? 1 : 0), 0));
  process.stdout.write(JSON.stringify(v.some(Boolean) ? v : [0.01, 0.01]));
});
`;

/** A project wired to a stub embedder, with two topically distinct entries. */
function makeSemanticProject(extra = {}) {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "embedder.js"), STUB_EMBEDDER);
  const semantic = {
    provider: "command",
    command: process.execPath,
    args: [path.join(root, "embedder.js")],
    blend: 0.6,
    ...extra,
  };
  fs.writeFileSync(
    path.join(root, "repomem.config.json"),
    JSON.stringify({ project: "sem", linked: [], semantic })
  );
  memSave.handler(
    { type: "issue", title: "Server will not start on Windows", content: "The npx shim cannot be spawned; ENOENT results." },
    root
  );
  memSave.handler(
    { type: "decision", title: "Chose Postgres", content: "Settlement needs multi-row SQL transactions." },
    root
  );
  return { root, semantic };
}

test("semantic search is off unless configured, and search stays synchronous", () => {
  const root = makeProject();
  memSave.handler({ type: "issue", title: "Flaky CI", content: "retry docker" }, root);
  const result = memSearch.handler({ query: "docker" }, root);
  assert.equal(typeof result, "string", "no config means no async, no embedding calls");
  assert.match(result, /Found 1 match/);
  assert.ok(!fs.existsSync(path.join(root, ".repomem", ".cache", "embeddings.json")));
});

test("buildIndex embeds once, then reuses unchanged entries", async () => {
  const { root, semantic } = makeSemanticProject();

  const first = await embeddings.buildIndex(root, semantic);
  assert.equal(first.embedded, 2);
  assert.equal(first.reused, 0);
  assert.deepEqual(first.failed, []);

  const second = await embeddings.buildIndex(root, semantic);
  assert.equal(second.embedded, 0, "unchanged entries must not be re-embedded");
  assert.equal(second.reused, 2);

  // Editing one entry re-embeds only that one.
  const file = store.listFiles("issues", root)[0];
  store.writeFile("issues", file, "# Changed\n\nnow about spawn and npx on windows\n", {}, root);
  const third = await embeddings.buildIndex(root, semantic);
  assert.equal(third.embedded, 1);
  assert.equal(third.reused, 1);
});

test("changing provider or model invalidates the whole cache", async () => {
  const { root, semantic } = makeSemanticProject();
  await embeddings.buildIndex(root, semantic);

  // Vectors from a different model are not comparable, so none may be reused.
  const rebuilt = await embeddings.buildIndex(root, { ...semantic, model: "other-model" });
  assert.equal(rebuilt.reused, 0, "vectors from another model must not be mixed in");
  assert.equal(rebuilt.embedded, 2);
});

test("semantic search surfaces entries lexical search cannot reach", async () => {
  const { root, semantic } = makeSemanticProject();
  await embeddings.buildIndex(root, semantic);

  // "cmd" appears in no entry, so BM25 has nothing to match on.
  assert.ok(
    !store.listFiles("issues", root).some((f) => (store.readFile("issues", f, root) || "").includes("cmd")),
    "fixture must not contain the query term"
  );
  const lexicalOnly = store.searchFiles("cmd", root);
  assert.equal(lexicalOnly.length, 0, "BM25 alone finds nothing");

  const blended = await memSearch.handler({ query: "cmd" }, root);
  assert.match(blended, /Found 1 match/);
  assert.match(blended, /Server will not start on Windows/);
});

test("a broken provider degrades to lexical search instead of failing", async () => {
  const { root } = makeSemanticProject({ command: process.execPath, args: ["-e", "process.exit(3)"] });
  // Nothing can be embedded, and nothing should blow up.
  const result = await memSearch.handler({ query: "postgres" }, root);
  assert.match(result, /Found 1 match/, "search must still work");
  assert.match(result, /Chose Postgres/);
});

test("buildIndex reports entries it could not embed", async () => {
  const { root } = makeSemanticProject();
  const broken = { provider: "command", command: process.execPath, args: ["-e", "process.exit(1)"] };
  const result = await embeddings.buildIndex(root, broken);
  assert.equal(result.embedded, 0);
  assert.equal(result.failed.length, 2, "failures are reported, not swallowed");
});

test("the vector cache is local state and is gitignored", async () => {
  const { root, semantic } = makeSemanticProject();
  await embeddings.buildIndex(root, semantic);
  const cacheDir = path.join(root, ".repomem", ".cache");
  assert.ok(fs.existsSync(path.join(cacheDir, "embeddings.json")));
  assert.match(fs.readFileSync(path.join(cacheDir, ".gitignore"), "utf8"), /\*/);
});

test("cosine and normalise behave", () => {
  assert.equal(embeddings.cosine([1, 0], [1, 0]), 1);
  assert.equal(embeddings.cosine([1, 0], [0, 1]), 0);
  assert.equal(embeddings.cosine([1, 0], [1, 2, 3]), 0, "mismatched lengths score zero");
  assert.equal(embeddings.cosine([0, 0], [0, 0]), 0, "no divide by zero");

  const scaled = embeddings.normalise(new Map([["a", 2], ["b", 1]]));
  assert.equal(scaled.get("a"), 1);
  assert.equal(scaled.get("b"), 0.5);
  assert.equal(embeddings.normalise(new Map()).size, 0);
});

test("cli embed refuses politely when semantic search is not configured", () => {
  const root = makeProject();
  const { code, out } = cliResult(root, "embed");
  assert.equal(code, 1);
  assert.match(out, /Semantic search is off/);
  assert.match(out, /repomem ships no model/);
});

test("cli embed builds the cache and status reports it", () => {
  const { root } = makeSemanticProject();
  assert.match(runCli(root, "embed"), /Vector cache updated — 2 embedded/);
  assert.match(runCli(root, "status"), /semantic {3}command — 2 vector\(s\)/);
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

const { mcpEntry } = require("../dist/cli.js");

test("cli setup claude-code writes .mcp.json at repo root (not .claude/)", () => {
  const root = makeProject();
  runCli(root, "setup", "claude-code");
  assert.ok(!fs.existsSync(path.join(root, ".claude", "mcp.json")), "must not use .claude/mcp.json");
  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(cfg.mcpServers.repomem, mcpEntry(), "must match the host platform's entry");
});

// Agents spawn MCP servers without a shell; on Windows a bare `npx` is npx.cmd
// and fails with ENOENT, so the entry must route through cmd.exe there.
test("mcpEntry wraps the command in cmd /c on Windows only", () => {
  assert.deepEqual(mcpEntry("win32"), {
    command: "cmd",
    args: ["/c", "npx", "@saleem11kh/repomem"],
  });
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(
      mcpEntry(platform),
      { command: "npx", args: ["@saleem11kh/repomem"] },
      `${platform} must spawn npx directly`
    );
  }
});

test("importing the CLI does not execute it", () => {
  // require.main guard: the test file above already required dist/cli.js, so a
  // stray init/help side effect would have shown up as output or a thrown error.
  assert.equal(typeof mcpEntry, "function");
});

test("cli setup codex writes TOML and is idempotent", () => {
  const root = makeProject();
  runCli(root, "setup", "codex");
  const tomlPath = path.join(root, ".codex", "config.toml");
  const toml = fs.readFileSync(tomlPath, "utf8");
  const entry = mcpEntry();
  assert.match(toml, /^\[mcp_servers\.repomem\]/m);
  assert.ok(toml.includes(`command = ${JSON.stringify(entry.command)}`), "command must match host platform");
  assert.ok(
    toml.includes(`args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`),
    "args must match host platform"
  );
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

test("cli init scans the repo and reports what it learned", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-init-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "widget", scripts: { test: "node --test" } })
  );
  const adrDir = path.join(root, "docs", "adr");
  fs.mkdirSync(adrDir, { recursive: true });
  fs.writeFileSync(path.join(adrDir, "0001-use-postgres.md"), "# Use Postgres\n\nbecause\n");

  const out = runCli(root, "init");
  assert.match(out, /Wrote \.repomem\/project\.md/);
  assert.match(out, /Imported 1 ADR/);
  assert.ok(fs.existsSync(path.join(root, ".repomem", "project.md")));
  assert.equal(store.listFiles("decisions", root).length, 1);

  // Re-running is safe and does not duplicate the import.
  const again = runCli(root, "init");
  assert.match(again, /already imported/);
  assert.equal(store.listFiles("decisions", root).length, 1);
});

test("cli prime prints the same packet the MCP tool returns", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "README.md"), "# Widget\n\nIt widgets things.\n");
  const out = runCli(root, "prime");
  assert.match(out, /# repomem priming packet/);
  assert.match(out, /It widgets things/);
  assert.equal(out.trim(), memPrime.handler({}, root).trim());
});

// ---------------------------------------------------------------------------
// auto-capture — memory that does not depend on remembering to ask.
// ---------------------------------------------------------------------------
const capture = require("../dist/store/capture.js");

test("capture records new commits but does not re-record unchanged WIP", () => {
  const { root, run } = makeGitProject();
  fs.writeFileSync(path.join(root, "wip.txt"), "half done\n");

  const first = capture.planCapture(root);
  assert.equal(first.worthWriting, true, "new WIP is worth recording once");
  assert.match(first.summary, /left uncommitted/);
  capture.writeMarker(root, first.marker);

  // Nothing has changed: capturing again must write nothing.
  const second = capture.planCapture(root);
  assert.equal(second.worthWriting, false, "unchanged WIP must not re-trigger");
  capture.writeMarker(root, second.marker);

  // A commit is an event, and always worth recording.
  run(["add", "."]);
  run(["commit", "-q", "-m", "feat: finish the wip"]);
  const third = capture.planCapture(root);
  assert.equal(third.worthWriting, true, "a new commit must be captured");
  assert.match(third.summary, /1 commit/);
});

test("capture does not re-report a commit made in the same minute as the marker", () => {
  // `git --since` resolves to the minute, so a commit made in the marker's own
  // minute stays inside the time window and used to look new on every run —
  // one auto session file per capture, forever. Commits are ranged now instead.
  const { root, run } = makeGitProject();
  fs.writeFileSync(path.join(root, "feature.txt"), "x\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "feat: land the feature"]);

  const first = capture.planCapture(root);
  assert.equal(first.worthWriting, true, "the commit is genuinely new the first time");
  assert.match(first.summary, /1 commit/);
  assert.ok(first.marker.head, "the marker must record HEAD to range from");
  capture.writeMarker(root, first.marker);

  const second = capture.planCapture(root);
  assert.equal(second.worthWriting, false, "the same commit must not be reported twice");
  capture.writeMarker(root, second.marker);
  assert.equal(capture.planCapture(root).worthWriting, false, "and not on the run after that");
});

test("capture notices when the uncommitted set changes", () => {
  const { root } = makeGitProject();
  fs.writeFileSync(path.join(root, "one.txt"), "x\n");
  capture.writeMarker(root, capture.planCapture(root).marker);
  assert.equal(capture.planCapture(root).worthWriting, false);

  fs.writeFileSync(path.join(root, "two.txt"), "y\n");
  assert.equal(
    capture.planCapture(root).worthWriting,
    true,
    "a different file set is new work"
  );
});

test("capture says plainly that no human summary was written", () => {
  const { root } = makeGitProject();
  fs.writeFileSync(path.join(root, "wip.txt"), "x\n");
  const plan = capture.planCapture(root);
  assert.match(
    plan.summary,
    /intent behind this work is not recorded/,
    "an auto summary must not pretend to understand the work"
  );
});

test("capture is a no-op outside a git repo", () => {
  const root = makeProject();
  assert.equal(capture.planCapture(root).worthWriting, false);
});

test("cli capture writes one session, then stays quiet", () => {
  const { root } = makeGitProject();
  fs.writeFileSync(path.join(root, "wip.txt"), "x\n");

  assert.match(runCli(root, "capture"), /Handoff written/);
  assert.equal(store.listFiles("sessions", root).length, 1);

  assert.match(runCli(root, "capture"), /Nothing new/);
  assert.equal(
    store.listFiles("sessions", root).length,
    1,
    "hooking capture to every session end must not litter sessions/"
  );
});

test("cli setup --hooks installs lifecycle hooks without clobbering settings", () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const settingsPath = path.join(root, ".claude", "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));

  const out = runCli(root, "setup", "claude-code", "--hooks");
  assert.match(out, /Installed session hooks/);

  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(settings.permissions.allow, ["Bash(ls)"], "existing settings survive");
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "repomem context");
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, "repomem capture");

  runCli(root, "setup", "claude-code", "--hooks");
  const again = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(again.hooks.SessionStart.length, 1, "re-running must not duplicate hooks");
});

test("cli setup --hooks is a no-op for agents without lifecycle hooks", () => {
  const root = makeProject();
  const out = runCli(root, "setup", "cursor", "--hooks");
  assert.match(out, /no session lifecycle hooks/);
  assert.ok(!fs.existsSync(path.join(root, ".claude", "settings.json")));
});

test("cli context prints the packet and stays silent outside a project", () => {
  const root = makeProject();
  memSave.handler({ type: "issue", title: "Watch out", content: "for the thing" }, root);
  assert.match(runCli(root, "context"), /# Context for/);
  assert.match(runCli(root, "context", "--brief"), /1 issues/);

  // Hooks run in every repo, including ones that never adopted repomem.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-nohook-"));
  const { code, out } = cliResult(bare, "context");
  assert.equal(code, 0, "a hook must not fail a session in an unrelated repo");
  assert.equal(out.trim(), "");
});

test("cli context passes --task and --budget through", () => {
  const root = makeBusyProject();
  const plain = runCli(root, "context");
  assert.match(plain, /## Known issues/);

  const scoped = runCli(root, "context", "--task", "windows spawn ENOENT");
  assert.match(scoped, /_Ranked by relevance to: windows spawn ENOENT_/);
  assert.match(scoped.split("## Relevant issues")[1].split("\n")[1], /Windows spawn fails/);

  // A hook injects this into every session, so the cap has to hold from the CLI.
  const capped = runCli(root, "context", "--budget", "300");
  assert.ok(
    Math.ceil(capped.trim().length / 4) <= 300,
    `budget must bind from the CLI too, got ${Math.ceil(capped.trim().length / 4)}`
  );
});

test("cli scan and prime guard an uninitialised project", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-bare-"));
  for (const cmd of ["scan", "prime"]) {
    const { code, out } = cliResult(bare, cmd);
    assert.equal(code, 1, `${cmd} must fail outside a repomem project`);
    assert.match(out, /repomem init/);
  }
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

/**
 * The whole adoption story on a repo that predates repomem, driven only through
 * the shipped artifact: CLI subprocesses and the MCP server over stdio. Nothing
 * here imports dist/ directly, so it exercises what a user actually installs.
 */
test("e2e: adopting repomem on a legacy repo, start to finish", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repomem-e2e-legacy-"));
  const git = (args, env) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...env },
    });

  // ---- a repo with history, docs, ADRs, and CI, but no memory ----------------
  fs.mkdirSync(path.join(root, "docs", "adr"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@acme/payments-service",
      main: "dist/index.js",
      scripts: { build: "tsc", test: "jest" },
      dependencies: { express: "^5" },
      devDependencies: { typescript: "^5", jest: "^29" },
    })
  );
  fs.writeFileSync(path.join(root, "README.md"), "# Payments\n\nSettles merchant batches nightly.\n");
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM node:22\n");
  fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  fs.writeFileSync(path.join(root, "src", "api", "routes.ts"), "export const x = 1\n");
  fs.writeFileSync(
    path.join(root, "docs", "adr", "0001-use-postgres.md"),
    "# Use Postgres over DynamoDB\n\n## Status\n\nAccepted\n\n## Context\n\nSettlement needs multi-row transactions.\n"
  );
  fs.writeFileSync(
    path.join(root, "docs", "adr", "0002-idempotency-keys.md"),
    "# Require idempotency keys\n\n## Status\n\nAccepted\n\n## Context\n\nGateway retries were double-charging.\n"
  );

  git(["init", "-q"]);
  git(["config", "user.email", "e2e@example.com"]);
  git(["config", "user.name", "E2E"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "feat: initial payments service"]);
  git(["tag", "v1.2.0"]);
  fs.appendFileSync(path.join(root, "src", "api", "routes.ts"), "export const y = 2\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fix: correct the route handler"]);

  // ---- 1. init learns the repo without a model -------------------------------
  const init = runCli(root, "init");
  assert.match(init, /Wrote \.repomem\/project\.md/);
  assert.match(init, /Imported 2 ADR\(s\)/);

  const profile = fs.readFileSync(path.join(root, ".repomem", "project.md"), "utf8");
  for (const expected of [
    /Node\.js \+ TypeScript/, /Express/, /Jest/, /Docker/,
    /npm run build/, /npm run test/,
    /main: dist\/index\.js/,
    /`src\/`/, /`docs\/`/,
    /\.github\/workflows\/ci\.yml/,
    /Conventional Commits/, /v1\.2\.0/,
    /src\/api\/routes\.ts/,
  ]) {
    assert.match(profile, expected, `profile must record ${expected}`);
  }

  // ---- 2. wiring, including the hooks that make it automatic -----------------
  const setup = runCli(root, "setup", "claude-code", "--hooks");
  assert.match(setup, /Wired repomem into Claude Code/);
  assert.match(setup, /Installed session hooks/);
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(mcpConfig.mcpServers.repomem, mcpEntry());
  const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "repomem context");

  // ---- 3. an agent connects and works ----------------------------------------
  const [context, prime, saved, handoff, searched] = mcp(root, [
    { name: "mem_context", arguments: {} },
    { name: "mem_prime", arguments: {} },
    {
      name: "mem_save",
      arguments: {
        type: "issue",
        title: "Batch job times out over 10k rows",
        content: "Chunk the settlement batch.",
        summary: "settlement batch times out past 10k rows",
        links: ["use-postgres-over-dynamodb"],
      },
    },
    { name: "mem_handoff", arguments: { summary: "looked at settlement", session: "settlement-work", next: ["chunk the batch"] } },
    { name: "mem_search", arguments: { query: "settlement batch" } },
  ]);

  // The cold-start packet carries the profile and the imported decisions.
  assert.match(context.text, /## Commands/);
  assert.match(context.text, /npm run test/);
  assert.match(context.text, /Use Postgres over DynamoDB/);
  assert.match(context.text, /Require idempotency keys/);
  assert.ok(!context.isError);

  assert.match(prime.text, /repomem priming packet/);
  assert.match(prime.text, /Settles merchant batches nightly/, "prose docs reach the agent");
  assert.match(prime.text, /already has \d+ memory entries/, "priming must not re-seed blindly");

  assert.match(saved.text, /Saved issues\//);
  assert.match(handoff.text, /Handoff written to sessions\/.*settlement-work/);
  assert.match(searched.text, /Batch job times out/);
  assert.match(searched.text, /→ related: Use Postgres over DynamoDB/, "wikilinks resolve across imports");

  // The handoff derived its own facts from git, and is attributed to the client.
  const sessionFile = store.listFiles("sessions", root)[0];
  assert.match(sessionFile, /^\d{4}-\d{2}-\d{2}-\d{4}-settlement-work\.md$/);
  const sessionText = store.readFile("sessions", sessionFile, root);
  assert.match(sessionText, /agent: test/, "clientInfo from the MCP handshake");
  assert.match(sessionText, /_branch: \S+_/);
  assert.match(sessionText, /\*\*Next:\*\*/);

  // ---- 4. unattended capture, as the SessionEnd hook would run it -------------
  fs.writeFileSync(path.join(root, "src", "api", "wip.ts"), "export const wip = true\n");
  assert.match(runCli(root, "capture"), /Handoff written/);
  assert.match(runCli(root, "capture"), /Nothing new/, "hooks must not litter sessions/");

  // ---- 5. context stays within a budget when a hook injects it ---------------
  const capped = runCli(root, "context", "--task", "settlement batching", "--budget", "400");
  assert.ok(
    Math.ceil(capped.trim().length / 4) <= 400,
    `hook-injected context must respect its budget, got ${Math.ceil(capped.trim().length / 4)}`
  );
  assert.match(capped, /_Ranked by relevance to: settlement batching_/);

  // ---- 6. opt-in semantic search, via a provider repomem does not ship --------
  fs.writeFileSync(path.join(root, "embedder.js"), STUB_EMBEDDER);
  const config = JSON.parse(fs.readFileSync(path.join(root, "repomem.config.json"), "utf8"));
  config.semantic = {
    provider: "command",
    command: process.execPath,
    args: [path.join(root, "embedder.js")],
    blend: 0.6,
  };
  fs.writeFileSync(path.join(root, "repomem.config.json"), JSON.stringify(config, null, 2));

  assert.match(runCli(root, "embed"), /Vector cache updated/);
  const [semantic] = mcp(root, [{ name: "mem_search", arguments: { query: "postgres" } }]);
  assert.match(semantic.text, /Use Postgres over DynamoDB/, "search still works with semantics on");

  // ---- 7. the memory travels: export here, import into a fresh repo ----------
  const bundle = runCli(root, "sync");
  const teammate = initProject("teammate-svc");
  fs.writeFileSync(path.join(teammate, "bundle.md"), bundle);
  const imported = runCli(teammate, "import", "bundle.md");
  assert.match(imported, /Imported \d+ file\(s\)/);
  const [teammateContext] = mcp(teammate, [{ name: "mem_context", arguments: {} }]);
  assert.match(teammateContext.text, /Use Postgres over DynamoDB/, "a clone inherits the memory");
  assert.match(teammateContext.text, /Batch job times out/);

  // ---- 8. status reflects the whole picture ----------------------------------
  const status = runCli(root, "status");
  assert.match(status, /repomem status — payments-service/);
  assert.match(status, /agents {5}Claude Code/);
  assert.match(status, /semantic {3}command/);
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
