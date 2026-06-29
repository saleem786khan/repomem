import { writeFile, generateIndex, isInitialized } from "../store/file-store.js";
import { ToolDef, today, timestamp, str, strArray } from "./util.js";

export const memHandoff: ToolDef = {
  name: "mem_handoff",
  description:
    "Close out a session: write a structured handoff to sessions/YYYY-MM-DD.md so " +
    "the next session (you, a teammate, or a different agent) picks up exactly where " +
    "this one left off. Records what was done, what's next, and any blockers.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "What was worked on this session." },
      done: {
        type: "array",
        items: { type: "string" },
        description: "Completed items.",
      },
      next: {
        type: "array",
        items: { type: "string" },
        description: "What to do next session.",
      },
      blockers: {
        type: "array",
        items: { type: "string" },
        description: "Open blockers or gotchas.",
      },
    },
    required: ["summary"],
  },
  handler(args, projectRoot) {
    if (!isInitialized(projectRoot)) {
      return "✖ .repomem/ not found. Run `repomem init` in your project first.";
    }
    const summary = str(args.summary);
    if (!summary) return "✖ A summary is required.";

    const done = strArray(args.done);
    const next = strArray(args.next);
    const blockers = strArray(args.blockers);

    const lines: string[] = [];
    lines.push(`\n## ${timestamp()} — Handoff`, "");
    lines.push(summary, "");
    if (done.length) {
      lines.push("**Done:**");
      for (const d of done) lines.push(`- ${d}`);
      lines.push("");
    }
    if (next.length) {
      lines.push("**Next:**");
      for (const n of next) lines.push(`- ${n}`);
      lines.push("");
    }
    if (blockers.length) {
      lines.push("**Blockers:**");
      for (const b of blockers) lines.push(`- ${b}`);
      lines.push("");
    }

    const filename = `${today()}.md`;
    writeFile("sessions", filename, lines.join("\n"), { append: true }, projectRoot);
    generateIndex(projectRoot);

    return (
      `✔ Handoff written to sessions/${filename}\n\n` +
      "Commit it so your team and next session inherit it:\n" +
      `  git add .repomem/ && git commit -m "memory: session handoff ${today()}"`
    );
  },
};
