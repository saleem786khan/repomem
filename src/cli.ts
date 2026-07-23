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

const MCP_COMMAND = "npx";
const MCP_ARGS = ["@saleem11kh/repomem"];
const MCP_ENTRY = { command: MCP_COMMAND, args: MCP_ARGS };

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
  console.log("\nNext: wire it to your agent, e.g.");
  console.log("  repomem setup claude-code");
  console.log("\nThen commit it so your team inherits the memory:");
  console.log("  git add .repomem/ repomem.config.json && git commit");
}

/** repomem setup <agent> — write the MCP server config for an agent. */
function cmdSetup(agentArg?: string): void {
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
  if (agent.format === "toml") {
    console.log("  Codex only loads project config for trusted projects —");
    console.log("  run it from this dir and approve the trust prompt.");
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
  servers.repomem = MCP_ENTRY;
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
  const block = [
    "[mcp_servers.repomem]",
    `command = ${JSON.stringify(MCP_COMMAND)}`,
    `args = [${MCP_ARGS.map((a) => JSON.stringify(a)).join(", ")}]`,
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

function cmdHelp(): void {
  console.log(`repomem — git-native memory for AI coding agents

Usage:
  repomem                      Start the MCP server (stdio) — used by agents
  repomem init                 Scaffold .repomem/ and repomem.config.json
  repomem setup <agent>        Wire repomem into an agent
                               (${Object.keys(AGENTS).join(", ")})
  repomem status               Show memory counts and configured agents
  repomem sync                 Export all memory to stdout
  repomem import [file]        Import a sync bundle (file or stdin) into .repomem/
  repomem pull                 Fetch remote linked repos' memory from GitHub
  repomem help                 Show this help`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  switch (command) {
    case undefined:
      // No subcommand: behave as the MCP server (how agents invoke `npx repomem`).
      await (await import("./index.js")).startServer();
      return;
    case "init":
      cmdInit();
      return;
    case "setup":
      cmdSetup(arg);
      return;
    case "status":
      cmdStatus();
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

main().catch((err) => {
  console.error("repomem error:", err);
  process.exit(1);
});
