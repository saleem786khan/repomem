/** Shared helpers for repomem MCP tools. */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, projectRoot: string) => string;
}

/** YYYY-MM-DD in local time. */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO-ish local timestamp for in-file headings. */
export function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Turn a title into a filesystem-safe kebab slug. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

/** Coerce an unknown arg into a trimmed string (empty when absent). */
export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Coerce an unknown arg into a string array. */
export function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) {
    return v.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [];
}
