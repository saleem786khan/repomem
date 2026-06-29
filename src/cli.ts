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
  isInitialized,
  listFiles,
  readFile,
} from "./store/file-store.js";

const AGENTS: Record<string, { file: string; label: string }> = {
  "claude-code": { file: ".claude/mcp.json", label: "Claude Code" },
  cursor: { file: ".cursor/mcp.json", label: "Cursor" },
  gemini: { file: ".gemini/settings.json", label: "Gemini CLI" },
  "gemini-cli": { file: ".gemini/settings.json", label: "Gemini CLI" },
  codex: { file: ".codex/config.json", label: "Codex" },
};

const MCP_ENTRY = { command: "npx", args: ["@saleem11kh/repomem"] };

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
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(target)) {
    try {
      existing = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch {
      console.error(`✖ ${agent.file} exists but is not valid JSON — aborting.`);
      process.exitCode = 1;
      return;
    }
  }

  const servers =
    (existing.mcpServers as Record<string, unknown>) ?? ({} as Record<string, unknown>);
  servers.repomem = MCP_ENTRY;
  existing.mcpServers = servers;

  fs.writeFileSync(target, JSON.stringify(existing, null, 2) + "\n", "utf8");
  console.log(`✔ Wired repomem into ${agent.label} (${agent.file})`);
  console.log("  Restart the agent to pick up the new MCP server.");
}

/** repomem status — print a health summary. */
function cmdStatus(): void {
  const root = cwd();
  if (!isInitialized(root)) {
    console.log("✖ .repomem/ not found here. Run `repomem init` first.");
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

function cmdHelp(): void {
  console.log(`repomem — git-native memory for AI coding agents

Usage:
  repomem                      Start the MCP server (stdio) — used by agents
  repomem init                 Scaffold .repomem/ and repomem.config.json
  repomem setup <agent>        Wire repomem into an agent
                               (${Object.keys(AGENTS).join(", ")})
  repomem status               Show memory counts and configured agents
  repomem sync                 Export all memory to stdout
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
