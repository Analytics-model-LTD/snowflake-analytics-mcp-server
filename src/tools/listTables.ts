/**
 * listTables.ts — table-discovery tool for the Analytics Model platform.
 *
 * The platform's MCP connector flow (fetchMcpTables) expects every MCP server
 * to expose a `list_tables` tool whose result text, once unwrapped, yields a
 * flat array of { table_name } objects.
 *
 * OUTPUT SHAPE — copied byte-for-byte from the working Shopify / Clio servers.
 * The platform parser expects:
 *   1. The tool result text is JSON.stringify of an object with a `data` field.
 *   2. `data` is ITSELF a JSON string of the [{ table_name }] array.
 * i.e. the array is DOUBLE-stringified. Do not "simplify" this to a raw array
 * or the backend parse fails and the table dropdown stays empty.
 *
 * Unlike Clio (a REST API with fixed resource categories), Snowflake is a real
 * database, so we query INFORMATION_SCHEMA for the live table list scoped to the
 * connection's database/schema (overridable via arguments).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConfig, runQuery, quoteIdent } from "../snowflake.js";

interface PlatformEnvelope {
  is_success: boolean;
  status_code: number;
  data: string; // double-stringified [{ table_name }]
  message: string;
  requestedPayload: Record<string, unknown>;
}

function envelope(
  tableNames: string[],
  requestedPayload: Record<string, unknown>,
  message: string
): PlatformEnvelope {
  return {
    is_success: true,
    status_code: 200,
    data: JSON.stringify(tableNames.map((t) => ({ table_name: t }))),
    message,
    requestedPayload,
  };
}

export function registerListTables(server: McpServer): void {
  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "List available Snowflake tables (and views) for analytics table discovery. " +
        "Returns a flat array of { table_name } objects. Scoped to the connection's " +
        "database/schema unless overridden.",
      inputSchema: {
        database: z
          .string()
          .optional()
          .describe("Database to list from. Defaults to SNOWFLAKE_DATABASE."),
        schema: z
          .string()
          .optional()
          .describe("Schema to list from. Defaults to SNOWFLAKE_SCHEMA."),
        include_views: z
          .boolean()
          .optional()
          .describe("Include views alongside base tables. Default true."),
      },
    },
    async (args: {
      database?: string;
      schema?: string;
      include_views?: boolean;
    }) => {
      const c = getConfig();
      const database = args.database || c.database;
      const schema = args.schema || c.schema;
      const includeViews = args.include_views !== false;
      const requestedPayload = { database, schema, include_views: includeViews };

      try {
        if (!database) {
          throw new Error(
            "No database available. Set SNOWFLAKE_DATABASE or pass `database`."
          );
        }

        // INFORMATION_SCHEMA lives inside each database.
        const infoSchema = `${quoteIdent(database)}.INFORMATION_SCHEMA.TABLES`;
        const conditions: string[] = [];
        const binds: unknown[] = [];
        if (schema) {
          conditions.push("TABLE_SCHEMA = ?");
          binds.push(schema);
        } else {
          // Exclude Snowflake's own metadata schema for a cleaner list.
          conditions.push("TABLE_SCHEMA <> 'INFORMATION_SCHEMA'");
        }
        if (!includeViews) {
          conditions.push("TABLE_TYPE = 'BASE TABLE'");
        }
        const where = conditions.length
          ? `WHERE ${conditions.join(" AND ")}`
          : "";
        const sql =
          `SELECT TABLE_NAME FROM ${infoSchema} ${where} ORDER BY TABLE_NAME`;

        const { rows } = await runQuery(sql, binds);
        const names = rows
          .map((r) => (r.TABLE_NAME ?? r.table_name) as string)
          .filter(Boolean);

        const payload = envelope(
          names,
          requestedPayload,
          `Found ${names.length} table(s).`
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      } catch (err) {
        // Keep the platform envelope even on failure so the parser doesn't choke.
        const payload: PlatformEnvelope = {
          is_success: false,
          status_code: 500,
          data: JSON.stringify([]),
          message: err instanceof Error ? err.message : String(err),
          requestedPayload,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          isError: true,
        };
      }
    }
  );
}
