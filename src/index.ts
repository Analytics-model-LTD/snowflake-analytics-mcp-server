#!/usr/bin/env node
/**
 * snowflake-analytics-mcp-server
 *
 * A Model Context Protocol server that exposes a Snowflake connection over
 * stdio, runnable via `npx`. Provides table-discovery, SQL query, and Cortex AI
 * tools. Credentials come entirely from environment variables (see README).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "snowflake-analytics-mcp-server",
    version: "0.2.0",
    title: "Snowflake Analytics MCP Server",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr only — stdout is reserved for the MCP protocol stream.
  process.stderr.write("snowflake-analytics-mcp-server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`
  );
  process.exit(1);
});
