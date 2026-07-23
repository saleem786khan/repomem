import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { findProjectRoot } from "./config/config.js";
import { ToolDef } from "./tools/util.js";
import { memSave } from "./tools/mem-save.js";
import { memSearch } from "./tools/mem-search.js";
import { memContext } from "./tools/mem-context.js";
import { memHandoff } from "./tools/mem-handoff.js";

const TOOLS: ToolDef[] = [memSave, memSearch, memContext, memHandoff];
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

const VERSION = "0.2.0";

/** Build and start the repomem MCP server over stdio. */
export async function startServer(): Promise<void> {
  const server = new Server(
    { name: "repomem", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Git-native memory for AI coding agents. Memory lives in .repomem/ in the " +
        "repo, commits with the code, and travels to teammates. Call mem_context at " +
        "the start of a session, mem_save to capture decisions/patterns/issues, " +
        "mem_search to recall, and mem_handoff to close out a session.",
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOL_MAP.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `✖ Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = tool.handler(args, findProjectRoot());
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `✖ ${tool.name} failed: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stderr is safe to log to; stdout is reserved for the MCP protocol.
  console.error(`repomem MCP server v${VERSION} ready (stdio).`);
}

// Run directly when invoked as a script (not when imported by the CLI router).
if (require.main === module) {
  startServer().catch((err) => {
    console.error("repomem failed to start:", err);
    process.exit(1);
  });
}
