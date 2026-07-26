/**
 * Deterministic repo profiling — what an agent otherwise rediscovers by globbing
 * the tree at the start of every session.
 *
 * Nothing here calls a model. Stack, commands, entry points, layout, and CI are
 * all readable from files that already exist, and conventions are inferred from
 * git history. That matters for adoption: `repomem init` on a five-year-old repo
 * has to produce something useful without an agent in the loop.
 *
 * The result is written to .repomem/project.md, which is regenerated wholesale
 * and must never be hand-edited — authored memory lives in the four typed dirs.
 */
import * as fs from "fs";
import * as path from "path";

import { loadConfig } from "../config/config.js";
import { getRepomemRoot, isInitialized } from "./file-store.js";
import { repoConventions } from "./git.js";

export const PROFILE_FILENAME = "project.md";

// Directories that tell you nothing about a project's shape.
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".repomem", "dist", "build", "out", "coverage",
  "vendor", "target", "__pycache__", ".venv", "venv", ".next", ".nuxt",
  ".turbo", ".cache", ".idea", ".vscode", "bin", "obj",
]);

const MAX_WALK_ENTRIES = 5000;
const MAX_LAYOUT_DIRS = 12;

export interface ProjectProfile {
  stack: string[];
  commands: string[];
  entryPoints: string[];
  layout: string[];
  ci: string[];
  conventions: string[];
  hotspots: string[];
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  const raw = readText(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

/** Language and framework signals, read from whichever manifests are present. */
function detectStack(root: string): string[] {
  const out: string[] = [];
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) {
    const deps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    const ts = "typescript" in deps || exists(root, "tsconfig.json");
    out.push(`Node.js${ts ? " + TypeScript" : ""}`);
    if (pkg.type === "module") out.push("ESM (`type: module`)");

    for (const [dep, label] of [
      ["react", "React"], ["next", "Next.js"], ["vue", "Vue"], ["svelte", "Svelte"],
      ["express", "Express"], ["fastify", "Fastify"], ["nestjs", "NestJS"],
      ["@modelcontextprotocol/sdk", "MCP SDK"],
    ] as const) {
      if (Object.keys(deps).some((d) => d === dep || d.startsWith(`${dep}/`))) out.push(label);
    }
    for (const [dep, label] of [
      ["vitest", "Vitest"], ["jest", "Jest"], ["mocha", "Mocha"], ["playwright", "Playwright"],
      ["eslint", "ESLint"], ["prettier", "Prettier"], ["biome", "Biome"],
    ] as const) {
      if (Object.keys(deps).some((d) => d.includes(dep))) out.push(label);
    }
  }

  for (const [file, label] of [
    ["pyproject.toml", "Python (pyproject)"],
    ["requirements.txt", "Python (requirements.txt)"],
    ["go.mod", "Go"],
    ["Cargo.toml", "Rust"],
    ["pom.xml", "Java (Maven)"],
    ["build.gradle", "JVM (Gradle)"],
    ["build.gradle.kts", "JVM (Gradle Kotlin)"],
    ["Gemfile", "Ruby"],
    ["composer.json", "PHP"],
    ["Dockerfile", "Docker"],
    ["docker-compose.yml", "Docker Compose"],
    ["terraform.tf", "Terraform"],
  ] as const) {
    if (exists(root, file)) out.push(label);
  }

  try {
    if (fs.readdirSync(root).some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) {
      out.push(".NET");
    }
  } catch {
    /* unreadable root is someone else's problem */
  }

  return [...new Set(out)];
}

/** How to build, test, run, and lint — the questions asked every session. */
function detectCommands(root: string): string[] {
  const out: string[] = [];

  const pkg = readJson(path.join(root, "package.json"));
  const scripts = (pkg?.scripts as Record<string, string>) ?? {};
  for (const name of ["build", "test", "dev", "start", "lint", "typecheck", "format"]) {
    if (scripts[name]) out.push(`\`npm run ${name}\` — ${scripts[name]}`);
  }

  const make = readText(path.join(root, "Makefile"));
  if (make) {
    const targets = [...make.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)]
      .map((m) => m[1])
      .filter((t) => t !== "PHONY")
      .slice(0, 8);
    if (targets.length) out.push(`\`make <target>\` — ${targets.join(", ")}`);
  }

  const just = readText(path.join(root, "justfile")) ?? readText(path.join(root, "Justfile"));
  if (just) {
    const recipes = [...just.matchAll(/^([a-zA-Z][\w-]*)(?:\s+[^:\n]*)?:/gm)]
      .map((m) => m[1])
      .slice(0, 8);
    if (recipes.length) out.push(`\`just <recipe>\` — ${recipes.join(", ")}`);
  }

  if (exists(root, "Taskfile.yml") || exists(root, "Taskfile.yaml")) {
    out.push("`task <name>` — see Taskfile");
  }
  if (exists(root, "go.mod")) out.push("`go build ./...`, `go test ./...`");
  if (exists(root, "Cargo.toml")) out.push("`cargo build`, `cargo test`");

  return out;
}

/** Where execution starts — bins, mains, and conventional entry files. */
function detectEntryPoints(root: string): string[] {
  const out: string[] = [];
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) {
    if (typeof pkg.main === "string") out.push(`main: ${pkg.main}`);
    const bin = pkg.bin;
    if (typeof bin === "string") out.push(`bin: ${bin}`);
    else if (bin && typeof bin === "object") {
      for (const [name, target] of Object.entries(bin as Record<string, string>)) {
        out.push(`bin \`${name}\`: ${target}`);
      }
    }
  }

  for (const candidate of [
    "src/index.ts", "src/index.js", "src/main.ts", "src/main.py",
    "main.go", "main.py", "app.py", "src/main.rs", "index.js",
  ]) {
    if (exists(root, candidate)) out.push(candidate);
  }

  return [...new Set(out)].slice(0, 8);
}

/** Recursive file count and dominant extension, bounded so huge trees stay fast. */
function summariseDir(dir: string, budget: { left: number }): { files: number; ext: string } {
  const byExt = new Map<string, number>();
  let files = 0;

  const walk = (current: string, depth: number) => {
    if (depth > 3 || budget.left <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget.left-- <= 0) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(current, entry.name), depth + 1);
      } else if (entry.isFile()) {
        files += 1;
        const ext = path.extname(entry.name);
        if (ext) byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
      }
    }
  };
  walk(dir, 0);

  const dominant = [...byExt.entries()].sort((a, b) => b[1] - a[1])[0];
  return { files, ext: dominant ? dominant[0] : "" };
}

function detectLayout(root: string): string[] {
  const budget = { left: MAX_WALK_ENTRIES };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => {
      const { files, ext } = summariseDir(path.join(root, e.name), budget);
      return { name: e.name, files, ext };
    })
    .filter((d) => d.files > 0)
    .sort((a, b) => b.files - a.files)
    .slice(0, MAX_LAYOUT_DIRS)
    .map((d) => `\`${d.name}/\` — ${d.files} file${d.files === 1 ? "" : "s"}${d.ext ? `, mostly ${d.ext}` : ""}`);
}

function detectCI(root: string): string[] {
  const out: string[] = [];
  const workflows = path.join(root, ".github", "workflows");
  try {
    for (const f of fs.readdirSync(workflows)) {
      if (/\.ya?ml$/.test(f)) out.push(`.github/workflows/${f}`);
    }
  } catch {
    /* no workflows */
  }
  for (const [file, label] of [
    [".gitlab-ci.yml", "GitLab CI"],
    ["azure-pipelines.yml", "Azure Pipelines"],
    ["Jenkinsfile", "Jenkins"],
  ] as const) {
    if (exists(root, file)) out.push(label);
  }
  return out.slice(0, 8);
}

/** Everything deterministically knowable about a repo's shape. */
export function scanProject(projectRoot: string): ProjectProfile {
  const conventions: string[] = [];
  const git = repoConventions(projectRoot);
  if (git && git.sampled > 0) {
    const pct = Math.round(git.conventionalShare * 100);
    if (pct >= 60) {
      conventions.push(
        `Conventional Commits — ${pct}% of the last ${git.sampled} commits` +
          (git.topTypes.length ? ` (mostly ${git.topTypes.join(", ")})` : "")
      );
    } else if (pct > 0) {
      conventions.push(`Commit style is mixed — ${pct}% of the last ${git.sampled} are conventional`);
    } else {
      conventions.push(`Free-form commit subjects across the last ${git.sampled} commits`);
    }
    if (git.tags.length) conventions.push(`Releases tagged: ${git.tags.join(", ")}`);
  }

  return {
    stack: detectStack(projectRoot),
    commands: detectCommands(projectRoot),
    entryPoints: detectEntryPoints(projectRoot),
    layout: detectLayout(projectRoot),
    ci: detectCI(projectRoot),
    conventions,
    hotspots: git?.hotspots ?? [],
  };
}

function section(out: string[], heading: string, items: string[]): void {
  if (!items.length) return;
  out.push(`## ${heading}`, "");
  for (const item of items) out.push(`- ${item}`);
  out.push("");
}

export function renderProfile(profile: ProjectProfile, projectName: string): string {
  const out: string[] = [];
  out.push(`# ${projectName} — project profile`, "");
  out.push("_Auto-generated by `repomem scan`. Do not edit by hand — regenerate instead._", "");
  section(out, "Stack", profile.stack);
  section(out, "Commands", profile.commands);
  section(out, "Entry points", profile.entryPoints);
  section(out, "Layout", profile.layout);
  section(out, "CI", profile.ci);
  section(out, "Conventions", profile.conventions);
  section(out, "Churn hotspots", profile.hotspots);
  if (out.length <= 4) out.push("_Nothing detected — this may not be a code project._", "");
  return out.join("\n").trimEnd() + "\n";
}

/** Scan and write .repomem/project.md. Returns the profile, or null if uninitialised. */
export function writeProfile(projectRoot: string): ProjectProfile | null {
  if (!isInitialized(projectRoot)) return null;
  const profile = scanProject(projectRoot);
  const text = renderProfile(profile, loadConfig(projectRoot).project);
  fs.writeFileSync(path.join(getRepomemRoot(projectRoot), PROFILE_FILENAME), text, "utf8");
  return profile;
}

/** The written profile, or null when it has not been generated yet. */
export function readProfile(projectRoot: string): string | null {
  return readText(path.join(getRepomemRoot(projectRoot), PROFILE_FILENAME));
}
