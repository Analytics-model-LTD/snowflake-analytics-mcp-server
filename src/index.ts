#!/usr/bin/env node
/**
 * snowflake-analytics-mcp-server
 *
 * A Model Context Protocol server that exposes a Snowflake connection over
 * stdio, runnable via `npx`. Built for the Analytics Model platform: the
 * `list_tables` tool follows the platform's table-discovery envelope contract,
 * while the remaining tools are standard SQL helpers.
 *
 * Credentials come entirely from environment variables (see README).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "snowflake-analytics-mcp-server",
    version: "0.1.0",
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
