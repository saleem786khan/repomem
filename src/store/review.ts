import {
  MEMORY_TYPES,
  MemoryType,
  docDateMs,
  fmField,
  isRetired,
  lifecycleOf,
  listFiles,
  parseLinks,
  readFile,
  resolveLink,
} from "./file-store.js";
import { findProjectRoot } from "../config/config.js";

/**
 * The review cadence half of the memory lifecycle. Ranking already decays old
 * entries; nothing before this ever asked "is it still true?". `repomem review`
 * is that ask — runnable by hand, in CI, or on a cron, and it reports rather
 * than gates: what needs a human eye, never a failing exit for being old.
 */

export const DEFAULT_STALE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReviewFinding {
  file: string; // type/filename
  detail: string;
}

export interface ReviewReport {
  /** Live decisions/patterns older than the threshold — worth re-confirming. */
  stale: ReviewFinding[];
  /** Unresolved issues older than the threshold — fixed long ago, or truly open? */
  openIssues: ReviewFinding[];
  /** [[wikilinks]] that no longer resolve to any entry. */
  brokenLinks: ReviewFinding[];
  /** Entries claiming `supersedes:` whose target carries no superseded-by stamp. */
  unstampedSupersedes: ReviewFinding[];
  /** How many entries are retired (superseded or resolved) and correctly demoted. */
  retired: number;
}

function ageDays(type: MemoryType, filename: string, projectRoot: string): number {
  const ms = docDateMs(type, filename, projectRoot);
  return ms > 0 ? Math.floor((Date.now() - ms) / DAY_MS) : Infinity;
}

export function reviewMemory(
  projectRoot: string = findProjectRoot(),
  staleDays: number = DEFAULT_STALE_DAYS
): ReviewReport {
  const report: ReviewReport = {
    stale: [],
    openIssues: [],
    brokenLinks: [],
    unstampedSupersedes: [],
    retired: 0,
  };

  for (const type of MEMORY_TYPES) {
    for (const filename of listFiles(type, projectRoot)) {
      const raw = readFile(type, filename, projectRoot) ?? "";
      const file = `${type}/${filename}`;

      if (isRetired(raw)) {
        report.retired++;
      } else {
        // Sessions are immutable history — age is not a defect there.
        const age = ageDays(type, filename, projectRoot);
        if (age > staleDays && Number.isFinite(age)) {
          if (type === "issues") {
            report.openIssues.push({ file, detail: `open for ${age} days` });
          } else if (type !== "sessions") {
            report.stale.push({ file, detail: `${age} days old — still true?` });
          }
        }
      }

      for (const target of parseLinks(raw)) {
        if (!resolveLink(target, projectRoot)) {
          report.brokenLinks.push({ file, detail: `[[${target}]] resolves to nothing` });
        }
      }

      const supersedes = fmField(raw, "supersedes");
      if (supersedes) {
        const target = resolveLink(supersedes, projectRoot);
        if (!target) {
          report.unstampedSupersedes.push({
            file,
            detail: `supersedes ${supersedes}, which no longer exists`,
          });
        } else {
          const targetRaw = readFile(target.type, target.filename, projectRoot) ?? "";
          if (!lifecycleOf(targetRaw).supersededBy) {
            report.unstampedSupersedes.push({
              file,
              detail: `${target.type}/${target.filename} is not marked superseded-by`,
            });
          }
        }
      }
    }
  }

  return report;
}

/** Total findings that need a human eye (the retired count is informational). */
export function findingCount(r: ReviewReport): number {
  return (
    r.stale.length + r.openIssues.length + r.brokenLinks.length + r.unstampedSupersedes.length
  );
}
