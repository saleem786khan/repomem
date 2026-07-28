#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";

import {
  CONFIG_FILENAME,
  loadConfig,
  deriveProjectName,
  RepomemConfig,
} from "./config/config.js";
import {
  getRepomemRoot,
  MEMORY_TYPES,
  counts,
  generateIndex,
  importBundle,
  isInitialized,
  listFiles,
  readFile,
  remoteCacheRoot,
  REPOMEM_DIR,
} from "./store/file-store.js";
import { parseRemote, fetchRemoteRepomem, RemoteRef } from "./store/remote.js";
import { writeProfile, PROFILE_FILENAME } from "./store/profile.js";
import { importAdrs } from "./store/adr.js";
import { planCapture, writeMarker } from "./store/capture.js";
import { reviewMemory, findingCount, DEFAULT_STALE_DAYS, ReviewFinding } from "./store/review.js";
import { buildIndex, readCache } from "./store/embeddings.js";
import { memPrime } from "./tools/mem-prime.js";
import { memContext } from "./tools/mem-context.js";
import { memHandoff } from "./tools/mem-handoff.js";

interface AgentSpec {
  file: string;
  label: string;
  format: "json" | "toml";
}

// Each agent reads project-scoped MCP config from a specific file at the repo
// root. Claude Code uses `.mcp.json` (NOT `.claude/mcp.json`); Codex uses TOML.
const AGENTS: Record<string, AgentSpec> = {
  "claude-code": { file: ".mcp.json", label: "Claude Code", format: "json" },
  cursor: { file: ".cursor/mcp.json", label: "Cursor", format: "json" },
  gemini: { file: ".gemini/settings.json", label: "Gemini CLI", format: "json" },
  "gemini-cli": { file: ".gemini/settings.json", label: "Gemini CLI", format: "json" },
  codex: { file: ".codex/config.toml", label: "Codex", format: "toml" },
};

const NPM_PACKAGE = "@saleem11kh/repomem";

export interface McpEntry {
  command: string;
  args: string[];
}

/**
 * The server entry an agent should spawn, shaped for the host platform.
 *
 * Agents launch MCP servers with a bare spawn() and no shell. On Windows `npx`
 * is `npx.cmd`, which such a spawn cannot resolve — it fails with ENOENT and the
 * server silently shows as disconnected — so the command has to go through
 * cmd.exe there.
 */
export function mcpEntry(platform: NodeJS.Platform = process.platform): McpEntry {
  return platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", NPM_PACKAGE] }
    : { command: "npx", args: [NPM_PACKAGE] };
}

function cwd(): string {
  return process.cwd();
}

/** repomem init — scaffold .repomem/ and repomem.config.json. */
function cmdInit(): void {
  const root = cwd();
  const repomem = getRepomemRoot(root);

  for (const type of MEMORY_TYPES) {
    const dir = path.join(repomem, type);
    fs.mkdirSync(dir, { recursive: true });
    const keep = path.join(dir, ".gitkeep");
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, "", "utf8");
  }

  const configPath = path.join(root, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    const config: RepomemConfig = {
      project: deriveProjectName(root),
      linked: [],
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    console.log(`✔ Created ${CONFIG_FILENAME} (project: ${config.project})`);
  } else {
    console.log(`• ${CONFIG_FILENAME} already exists — left untouched`);
  }

  generateIndex(root);
  console.log(`✔ Initialised .repomem/ with ${MEMORY_TYPES.join(", ")}`);

  // An empty .repomem/ is why adopting on an existing repo stalls. Learn what
  // can be learned without a model before handing back to the user.
  console.log("");
  cmdScan();

  console.log("\nNext: wire it to your agent, e.g.");
  console.log("  repomem setup claude-code");
  console.log("\nThen commit it so your team inherits the memory:");
  console.log("  git add .repomem/ repomem.config.json && git commit");
}

/** repomem scan — regenerate the project profile and import any new ADRs. */
function cmdScan(): void {
  const root = cwd();
  if (!isInitialized(root)) {
    console.error("✖ .repomem/ not found here. Run `repomem init` first.");
    process.exitCode = 1;
    return;
  }

  const profile = writeProfile(root);
  if (profile) {
    const parts = [
      profile.stack.length ? `${profile.stack.length} stack signal(s)` : "",
      profile.commands.length ? `${profile.commands.length} command(s)` : "",
      profile.layout.length ? `${profile.layout.length} top-level dir(s)` : "",
      profile.conventions.length ? "git conventions" : "",
    ].filter(Boolean);
    console.log(
      `✔ Wrote ${REPOMEM_DIR}/${PROFILE_FILENAME}${parts.length ? ` — ${parts.join(", ")}` : ""}`
    );
    if (profile.stack.length) console.log(`  stack: ${profile.stack.join(", ")}`);
  }

  const { imported, skipped } = importAdrs(root);
  if (imported.length) {
    console.log(`✔ Imported ${imported.length} ADR(s) into decisions/`);
    for (const f of imported.slice(0, 5)) console.log(`  ${f}`);
    if (imported.length > 5) console.log(`  …and ${imported.length - 5} more`);
  } else if (skipped) {
    console.log(`• ${skipped} ADR(s) already imported — nothing new`);
  }

  generateIndex(root);

  const c = counts(root);
  const authored = c.decisions + c.patterns + c.issues - imported.length;
  if (authored <= 0) {
    console.log("\nProse docs still need an agent to distil. Run:");
    console.log("  repomem prime          # print the packet");
    console.log("  # …or ask your agent to call mem_prime");
  }
}

/**
 * repomem context — print the session-start packet (used by SessionStart hooks).
 * `--budget N` matters here: a hook injects this into every session, so being
 * able to cap what it costs is the difference between useful and intrusive.
 */
async function cmdContext(args: string[]): Promise<void> {
  const root = cwd();
  if (!isInitialized(root)) {
    // A hook runs on every session, including in repos that never adopted
    // repomem. Failing loudly there would be noise, not help.
    return;
  }

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const budget = Number(flag("--budget"));

  process.stdout.write(
    (await memContext.handler(
      {
        brief: args.includes("--brief"),
        task: flag("--task") ?? "",
        budget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
      },
      root
    )) + "\n"
  );
}

/**
 * repomem capture — record what changed since the last capture, unattended.
 * Writes nothing when nothing changed, so hooking it to every session end does
 * not litter sessions/ with empty files.
 */
async function cmdCapture(): Promise<void> {
  const root = cwd();
  if (!isInitialized(root)) return;

  const plan = planCapture(root);
  if (!plan.worthWriting) {
    console.log("• Nothing new since the last capture.");
    writeMarker(root, plan.marker);
    return;
  }

  const out = await memHandoff.handler(
    { summary: plan.summary, session: "auto", since: plan.since },
    root
  );
  writeMarker(root, plan.marker);
  console.log(out.split("\n")[0]);
}

/** repomem embed — build or refresh the semantic vector cache. */
async function cmdEmbed(): Promise<void> {
  const root = cwd();
  if (!isInitialized(root)) {
    console.error("✖ .repomem/ not found here. Run `repomem init` first.");
    process.exitCode = 1;
    return;
  }

  const semantic = loadConfig(root).semantic;
  if (!semantic) {
    console.error("✖ Semantic search is off. Add a `semantic` block to repomem.config.json:");
    console.error('  { "semantic": { "provider": "ollama", "model": "nomic-embed-text" } }');
    console.error("\nrepomem ships no model — point it at something you already run.");
    process.exitCode = 1;
    return;
  }

  const result = await buildIndex(root, semantic);
  console.log(
    `✔ Vector cache updated — ${result.embedded} embedded, ${result.reused} reused` +
      (result.removed ? `, ${result.removed} dropped` : "")
  );
  if (result.failed.length) {
    console.error(`✖ ${result.failed.length} entr(ies) failed to embed:`);
    for (const f of result.failed.slice(0, 5)) console.error(`  ${f}`);
    if (result.failed.length > 5) console.error(`  …and ${result.failed.length - 5} more`);
    process.exitCode = 1;
  }
  if (result.embedded + result.reused > 0) {
    console.log("\nmem_search now blends semantic similarity with BM25.");
  }
}

/** repomem prime — print the priming packet for an agent to act on. */
async function cmdPrime(): Promise<void> {
  const root = cwd();
  if (!isInitialized(root)) {
    console.error("✖ .repomem/ not found here. Run `repomem init` first.");
    process.exitCode = 1;
    return;
  }
  // Same packet the MCP tool returns, so scripted and in-agent onboarding agree.
  process.stdout.write(memPrime.handler({}, root) + "\n");
}

/**
 * Claude Code hooks that make memory automatic: warm the session on start,
 * record what changed on end. Both call the CLI, which no-ops outside a repomem
 * project, so installing them globally is harmless.
 *
 * Only Claude Code is wired this way — Cursor, Gemini CLI, and Codex have no
 * equivalent lifecycle hook, so for them `--hooks` is a no-op with a warning.
 */
const HOOK_SETTINGS_FILE = path.join(".claude", "settings.json");
const HOOK_COMMANDS = {
  SessionStart: "repomem context",
  SessionEnd: "repomem capture",
} as const;

interface HookEntry {
  hooks: { type: string; command: string }[];
}

/** Install the lifecycle hooks, preserving anything already configured. */
function installHooks(root: string): boolean {
  const target = path.join(root, HOOK_SETTINGS_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(target)) {
    try {
      settings = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch {
      console.error(`✖ ${HOOK_SETTINGS_FILE} exists but is not valid JSON — aborting.`);
      process.exitCode = 1;
      return false;
    }
  }

  const hooks = (settings.hooks as Record<string, HookEntry[]>) ?? {};
  for (const [event, command] of Object.entries(HOOK_COMMANDS)) {
    const existing = hooks[event] ?? [];
    const alreadyThere = existing.some((entry) =>
      (entry.hooks ?? []).some((h) => h.command === command)
    );
    if (!alreadyThere) existing.push({ hooks: [{ type: "command", command }] });
    hooks[event] = existing;
  }
  settings.hooks = hooks;

  fs.writeFileSync(target, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return true;
}

/** repomem setup <agent> — write the MCP server config for an agent. */
function cmdSetup(agentArg?: string, flag?: string): void {
  if (!agentArg) {
    console.error(`✖ Usage: repomem setup <${Object.keys(AGENTS).join("|")}>`);
    process.exitCode = 1;
    return;
  }
  const agent = AGENTS[agentArg.toLowerCase()];
  if (!agent) {
    console.error(
      `✖ Unknown agent "${agentArg}". Supported: ${Object.keys(AGENTS).join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  const root = cwd();
  const target = path.join(root, agent.file);
  const dir = path.dirname(target);
  if (dir !== root) fs.mkdirSync(dir, { recursive: true });

  const wired = agent.format === "toml"
    ? setupToml(target, agent)
    : setupJson(target, agent);
  if (!wired) return;

  console.log(`✔ Wired repomem into ${agent.label} (${agent.file})`);
  if (process.platform === "win32") {
    console.log("  Windows: the command is wrapped in `cmd /c` so agents can spawn it.");
    console.log("  Teammates on macOS/Linux should re-run this to rewrite the entry.");
  }
  if (agent.format === "toml") {
    console.log("  Codex only loads project config for trusted projects —");
    console.log("  run it from this dir and approve the trust prompt.");
  }

  if (flag === "--hooks") {
    if (agentArg.toLowerCase() !== "claude-code") {
      console.log(`• ${agent.label} has no session lifecycle hooks — skipped.`);
    } else if (installHooks(root)) {
      console.log(`✔ Installed session hooks (${HOOK_SETTINGS_FILE})`);
      console.log("    SessionStart → repomem context   (memory loads itself)");
      console.log("    SessionEnd   → repomem capture   (work records itself)");
    }
  }

  console.log("  Restart the agent to pick up the new MCP server.");
}

/** Merge the repomem entry into a JSON `mcpServers` map. Returns false on error. */
function setupJson(target: string, agent: AgentSpec): boolean {
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(target)) {
    try {
      existing = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch {
      console.error(`✖ ${agent.file} exists but is not valid JSON — aborting.`);
      process.exitCode = 1;
      return false;
    }
  }

  const servers =
    (existing.mcpServers as Record<string, unknown>) ?? ({} as Record<string, unknown>);
  servers.repomem = mcpEntry();
  existing.mcpServers = servers;

  fs.writeFileSync(target, JSON.stringify(existing, null, 2) + "\n", "utf8");
  return true;
}

/** Append a `[mcp_servers.repomem]` block to a Codex TOML config (idempotent). */
function setupToml(target: string, agent: AgentSpec): boolean {
  const content = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (/^\s*\[mcp_servers\.repomem\]/m.test(content)) {
    console.log(`• repomem already configured in ${agent.label} (${agent.file})`);
    return false;
  }
  const entry = mcpEntry();
  const block = [
    "[mcp_servers.repomem]",
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    "",
  ].join("\n");
  const prefix = content.trim() ? content.replace(/\s*$/, "") + "\n\n" : "";
  fs.writeFileSync(target, prefix + block, "utf8");
  return true;
}

/** repomem status — print a health summary. */
function cmdStatus(): void {
  const root = cwd();
  if (!isInitialized(root)) {
    console.error("✖ .repomem/ not found here. Run `repomem init` first.");
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(root);
  const c = counts(root);

  console.log(`repomem status — ${config.project}`);
  console.log("");
  for (const type of MEMORY_TYPES) {
    console.log(`  ${type.padEnd(10)} ${c[type]}`);
  }

  const configuredAgents = Object.entries(AGENTS)
    .filter(([, a]) => fs.existsSync(path.join(root, a.file)))
    .map(([, a]) => a.label);
  const uniqueAgents = [...new Set(configuredAgents)];
  console.log("");
  console.log(`  agents     ${uniqueAgents.length ? uniqueAgents.join(", ") : "none configured"}`);
  console.log(
    `  linked     ${
      config.linked.length ? config.linked.map((l) => l.repo).join(", ") : "none"
    }`
  );
  if (config.workspace) console.log(`  workspace  ${config.workspace}`);

  if (config.semantic) {
    const cache = readCache(root);
    const vectors = cache ? Object.keys(cache.entries).length : 0;
    console.log(
      `  semantic   ${config.semantic.provider}` +
        `${config.semantic.model ? ` (${config.semantic.model})` : ""} — ` +
        `${vectors} vector(s)${vectors === 0 ? " — run `repomem embed`" : ""}`
    );
  }
}

/** repomem sync — export .repomem/ contents to stdout for piping/sharing. */
function cmdSync(): void {
  const root = cwd();
  if (!isInitialized(root)) {
    console.error("✖ .repomem/ not found here. Run `repomem init` first.");
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(root);
  const out: string[] = [`# repomem export — ${config.project}`, ""];
  for (const type of MEMORY_TYPES) {
    const files = listFiles(type, root);
    if (files.length === 0) continue;
    out.push(`## ${type}`, "");
    for (const filename of files) {
      out.push(`### ${type}/${filename}`, "");
      out.push((readFile(type, filename, root) ?? "").trim(), "");
    }
  }
  process.stdout.write(out.join("\n") + "\n");
}

/** Ensure the remote cache is gitignored so it never gets committed. */
function ensureCacheGitignore(root: string): void {
  const cacheDir = path.join(getRepomemRoot(root), ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const gi = path.join(cacheDir, ".gitignore");
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, "# repomem remote cache — fetched copies, do not commit\n*\n", "utf8");
  }
}

/** repomem pull — fetch remote linked repos' .repomem/ into the local cache. */
async function cmdPull(): Promise<void> {
  const root = cwd();
  if (!isInitialized(root)) {
    console.error("✖ .repomem/ not found here. Run `repomem init` first.");
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(root);
  const remotes = config.linked
    .map((l) => parseRemote(l.repo))
    .filter((r): r is RemoteRef => r !== null);

  if (remotes.length === 0) {
    console.log("• No remote linked repos to pull.");
    console.log('  Add one to repomem.config.json, e.g. { "repo": "github:owner/name" }');
    return;
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  ensureCacheGitignore(root);

  for (const r of remotes) {
    const destRepomem = path.join(remoteCacheRoot(root, r), REPOMEM_DIR);
    try {
      fs.mkdirSync(destRepomem, { recursive: true });
      const count = await fetchRemoteRepomem(r, destRepomem, token);
      console.log(`✔ Pulled ${count} file(s) from ${r.owner}/${r.name}@${r.ref}`);
    } catch (err) {
      console.error(`✖ ${r.owner}/${r.name}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
  console.log("\nRemote memory is now searchable — mem_search with linked=true.");
}

/** repomem import [file] — write a `repomem sync` bundle back into .repomem/. */
function cmdImport(fileArg?: string): void {
  const root = cwd();
  if (!isInitialized(root)) {
    console.error("✖ .repomem/ not found here. Run `repomem init` first.");
    process.exitCode = 1;
    return;
  }

  let text: string;
  if (fileArg) {
    try {
      text = fs.readFileSync(path.resolve(root, fileArg), "utf8");
    } catch {
      console.error(`✖ Cannot read ${fileArg}`);
      process.exitCode = 1;
      return;
    }
  } else {
    try {
      text = fs.readFileSync(0, "utf8"); // stdin
    } catch {
      console.error("✖ Provide a file: `repomem import bundle.md`, or pipe via stdin.");
      process.exitCode = 1;
      return;
    }
  }

  const written = importBundle(text, root);
  if (written.length === 0) {
    console.log("• Nothing to import — no recognised memory sections found.");
    return;
  }
  generateIndex(root);
  console.log(`✔ Imported ${written.length} file(s):`);
  for (const f of written) console.log(`  ${f}`);
}

/** repomem review — report memory that needs a human eye; never a gate. */
function cmdReview(argv: string[]): void {
  const root = cwd();
  if (!isInitialized(root)) {
    console.error("✖ .repomem/ not found here. Run `repomem init` first.");
    process.exitCode = 1;
    return;
  }

  const daysIdx = argv.indexOf("--days");
  const parsed = daysIdx !== -1 ? Number(argv[daysIdx + 1]) : NaN;
  const staleDays = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_DAYS;

  const config = loadConfig(root);
  const report = reviewMemory(root, staleDays);
  console.log(`repomem review — ${config.project} (stale after ${staleDays} days)`);
  console.log("");

  const section = (title: string, findings: ReviewFinding[]) => {
    if (findings.length === 0) return;
    console.log(`• ${title} (${findings.length})`);
    for (const f of findings) console.log(`    ${f.file} — ${f.detail}`);
    console.log("");
  };

  section("Aging entries — re-confirm or supersede", report.stale);
  section("Long-open issues — fixed long ago, or truly open?", report.openIssues);
  section("Broken wikilinks", report.brokenLinks);
  section("supersedes without a back-reference (predates v0.6.0 — re-save to stamp)", report.unstampedSupersedes);

  if (report.retired > 0) {
    console.log(`✔ ${report.retired} retired entr${report.retired === 1 ? "y" : "ies"} (superseded/resolved) correctly demoted`);
  }
  if (findingCount(report) === 0) {
    console.log("✔ Nothing needs attention.");
  } else {
    console.log(`${findingCount(report)} finding(s). Retire with mem_save (supersedes/resolves), or edit the files directly.`);
  }
}

function cmdHelp(): void {
  console.log(`repomem — git-native memory for AI coding agents

Usage:
  repomem                      Start the MCP server (stdio) — used by agents
  repomem init                 Scaffold .repomem/, then scan the repo
  repomem scan                 Regenerate ${REPOMEM_DIR}/${PROFILE_FILENAME} and import new ADRs
  repomem prime                Print the priming packet for an agent to distil
  repomem embed                Build the semantic vector cache (opt-in; see README)
  repomem context [--brief] [--task <what>] [--budget <tokens>]
                               Print the session-start memory packet
  repomem capture              Record what changed since the last capture
  repomem setup <agent>        Wire repomem into an agent
                               (${Object.keys(AGENTS).join(", ")})
  repomem setup <agent> --hooks
                               …and install session hooks (Claude Code only)
                               so memory loads and records itself
  repomem status               Show memory counts and configured agents
  repomem review [--days <n>]  Report stale entries, long-open issues, and broken links
  repomem sync                 Export all memory to stdout
  repomem import [file]        Import a sync bundle (file or stdin) into .repomem/
  repomem pull                 Fetch remote linked repos' memory from GitHub
  repomem help                 Show this help`);
}

async function main(): Promise<void> {
  const [command, arg, flag] = process.argv.slice(2);

  switch (command) {
    case undefined:
      // No subcommand: behave as the MCP server (how agents invoke `npx repomem`).
      await (await import("./index.js")).startServer();
      return;
    case "init":
      cmdInit();
      return;
    case "scan":
      cmdScan();
      return;
    case "prime":
      await cmdPrime();
      return;
    case "embed":
      await cmdEmbed();
      return;
    case "context":
      await cmdContext(process.argv.slice(3));
      return;
    case "capture":
      await cmdCapture();
      return;
    case "setup":
      cmdSetup(arg, flag);
      return;
    case "status":
      cmdStatus();
      return;
    case "review":
      cmdReview(process.argv.slice(3));
      return;
    case "sync":
      cmdSync();
      return;
    case "pull":
      await cmdPull();
      return;
    case "import":
      cmdImport(arg);
      return;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      return;
    default:
      console.error(`✖ Unknown command "${command}".\n`);
      cmdHelp();
      process.exitCode = 1;
  }
}

// Run the CLI only when invoked as a script, so tests can import mcpEntry().
if (require.main === module) {
  main().catch((err) => {
    console.error("repomem error:", err);
    process.exit(1);
  });
}
