import * as fs from "fs";
import * as path from "path";

export interface LinkedRepo {
  repo: string;
  relation?: string;
}

export interface RepomemConfig {
  project: string;
  workspace?: string;
  linked: LinkedRepo[];
}

export const CONFIG_FILENAME = "repomem.config.json";

const DEFAULT_CONFIG: RepomemConfig = {
  project: "unknown-project",
  linked: [],
};

/**
 * Walk up from `start` looking for repomem.config.json or a .repomem/ dir.
 * Returns the directory that contains them, or `start` if none found.
 */
export function findProjectRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  // Stop at filesystem root.
  for (;;) {
    if (
      fs.existsSync(path.join(dir, CONFIG_FILENAME)) ||
      fs.existsSync(path.join(dir, ".repomem"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/**
 * Load repomem.config.json from the project root. Falls back to a default
 * config (project name derived from package.json or directory name) when the
 * file is missing or malformed — never throws.
 */
export function loadConfig(projectRoot: string = findProjectRoot()): RepomemConfig {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RepomemConfig>;
    return {
      project: parsed.project || deriveProjectName(projectRoot),
      workspace: parsed.workspace,
      linked: Array.isArray(parsed.linked) ? parsed.linked : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG, project: deriveProjectName(projectRoot) };
  }
}

/** Derive a project name from package.json `name`, else the directory name. */
export function deriveProjectName(projectRoot: string): string {
  try {
    const pkgRaw = fs.readFileSync(path.join(projectRoot, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { name?: string };
    if (pkg.name) {
      // Strip npm scope for a friendlier label.
      return pkg.name.replace(/^@[^/]+\//, "");
    }
  } catch {
    /* ignore */
  }
  return path.basename(projectRoot);
}
