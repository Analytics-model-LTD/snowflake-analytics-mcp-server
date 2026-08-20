/**
 * tools/index.ts — registers every tool on the MCP server.
 *
 * `list_tables` is registered first and follows the platform's double-wrapped
 * envelope contract (see listTables.ts). The remaining tools are standard
 * SQL-database helpers (test_connection, describe_table, get_table_sample,
 * execute_query, list_schemas, ...). Cortex AI tools are registered last and
 * only when enabled.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getConfig,
  runQuery,
  quoteIdent,
  qualify,
  resolveDatabase,
  isReadOnlyStatement,
} from "../snowflake.js";
import { registerListTables } from "./listTables.js";
import { registerCortexTools } from "./cortex.js";

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errText(err: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { error: err instanceof Error ? err.message : String(err) },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

export function registerTools(server: McpServer): void {
  // 1) Platform-contract table discovery.
  registerListTables(server);

  // 2) Connectivity / context probe.
  server.registerTool(
    "test_connection",
    {
      title: "Test connection",
      description:
        "Verify connectivity and return the current Snowflake version, account, user, role, warehouse, database and schema.",
      inputSchema: {},
    },
    async () => {
      try {
        const { rows } = await runQuery(
          "SELECT CURRENT_VERSION() AS VERSION, CURRENT_ACCOUNT() AS ACCOUNT, " +
          "CURRENT_USER() AS \"USER\", CURRENT_ROLE() AS ROLE, " +
          "CURRENT_WAREHOUSE() AS WAREHOUSE, CURRENT_DATABASE() AS DATABASE, " +
          "CURRENT_SCHEMA() AS SCHEMA"
        );
        return jsonText({ connected: true, ...(rows[0] || {}) });
      } catch (err) {
        return errText(err);
      }
    }
  );

  // 3) List databases.
  server.registerTool(
    "list_databases",
    {
      title: "List databases",
      description: "List all databases the current role can access.",
      inputSchema: {},
    },
    async () => {
      try {
        const { rows } = await runQuery(
          "SELECT DATABASE_NAME FROM SNOWFLAKE.INFORMATION_SCHEMA.DATABASES ORDER BY DATABASE_NAME"
        );
        return jsonText(
          rows.map((r) => r.DATABASE_NAME ?? r.database_name).filter(Boolean)
        );
      } catch {
        // Fallback for roles without SNOWFLAKE db access.
        try {
          const { rows } = await runQuery("SHOW DATABASES");
          return jsonText(rows.map((r) => (r as Record<string, unknown>).name));
        } catch (err) {
          return errText(err);
        }
      }
    }
  );

  // 4) List schemas.
  server.registerTool(
    "list_schemas",
    {
      title: "List schemas",
      description:
        "List schemas in a database. Defaults to SNOWFLAKE_DATABASE when `database` is omitted.",
      inputSchema: {
        database: z.string().optional().describe("Database name. Defaults to SNOWFLAKE_DATABASE."),
      },
    },
    async (args: { database?: string }) => {
      try {
        const db = (await resolveDatabase(args.database)) || getConfig().database;
        if (!db) throw new Error("No database. Set SNOWFLAKE_DATABASE or pass `database`.");
        const { rows } = await runQuery(
          `SELECT SCHEMA_NAME FROM ${quoteIdent(db)}.INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME`
        );
        return jsonText(
          rows.map((r) => r.SCHEMA_NAME ?? r.schema_name).filter(Boolean)
        );
      } catch (err) {
        return errText(err);
      }
    }
  );

  // 5) List warehouses.
  server.registerTool(
    "list_warehouses",
    {
      title: "List warehouses",
      description: "List virtual warehouses the current role can see, with size and state.",
      inputSchema: {},
    },
    async () => {
      try {
        const { rows } = await runQuery("SHOW WAREHOUSES");
        return jsonText(
          rows.map((r) => {
            const o = r as Record<string, unknown>;
            return { name: o.name, size: o.size, state: o.state, type: o.type };
          })
        );
      } catch (err) {
        return errText(err);
      }
    }
  );

  // 6) Describe a table's columns.
  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description:
        "Return column names, data types, nullability and defaults for a table (or view).",
      inputSchema: {
        table: z.string().describe("Table name (unqualified)."),
        database: z.string().optional().describe("Defaults to SNOWFLAKE_DATABASE."),
        schema: z.string().optional().describe("Defaults to SNOWFLAKE_SCHEMA."),
      },
    },
    async (args: { table: string; database?: string; schema?: string }) => {
      try {
        const c = getConfig();
        const db = (await resolveDatabase(args.database)) || c.database;
        const sc = args.schema || c.schema;
        if (!db) throw new Error("No database. Set SNOWFLAKE_DATABASE or pass `database`.");
        const conditions = ["TABLE_NAME = ?"];
        const binds: unknown[] = [args.table];
        if (sc) {
          conditions.push("TABLE_SCHEMA = ?");
          binds.push(sc);
        }
        const { rows } = await runQuery(
          `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ` +
          `CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE ` +
          `FROM ${quoteIdent(db)}.INFORMATION_SCHEMA.COLUMNS ` +
          `WHERE ${conditions.join(" AND ")} ORDER BY ORDINAL_POSITION`,
          binds
        );
        if (!rows.length) throw new Error(`Table "${args.table}" not found or no columns visible.`);
        return jsonText(rows);
      } catch (err) {
        return errText(err);
      }
    }
  );

  // 7) Sample rows from a table.
  server.registerTool(
    "get_table_sample",
    {
      title: "Get table sample",
      description:
        "Fetch a sample of rows from a table. Use this to preview data for a selected table.",
      inputSchema: {
        table: z.string().describe("Table name (unqualified)."),
        database: z.string().optional().describe("Defaults to SNOWFLAKE_DATABASE."),
        schema: z.string().optional().describe("Defaults to SNOWFLAKE_SCHEMA."),
        limit: z.number().int().positive().optional().describe("Row limit. Default 10."),
      },
    },
    async (args: {
      table: string;
      database?: string;
      schema?: string;
      limit?: number;
    }) => {
      try {
        const c = getConfig();
        const limit = Math.min(args.limit ?? 10, c.rowLimit);
        const db = (await resolveDatabase(args.database)) || c.database;
        const fqn = qualify(args.table, db, args.schema);
        const { rows } = await runQuery(`SELECT * FROM ${fqn} LIMIT ${limit}`);
        return jsonText(rows);
      } catch (err) {
        return errText(err);
      }
    }
  );

  // 8) Run an arbitrary query (read-only unless SNOWFLAKE_READ_ONLY=false).
  server.registerTool(
    "execute_query",
    {
      title: "Execute query",
      description:
        "Run a SQL query and return rows as JSON. Read-only by default (SELECT/SHOW/DESCRIBE/WITH). " +
        "Set SNOWFLAKE_READ_ONLY=false to allow writes/DDL.",
      inputSchema: {
        query: z.string().describe("The SQL statement to execute."),
      },
    },
    async (args: { query: string }) => {
      try {
        const c = getConfig();
        if (c.readOnly && !isReadOnlyStatement(args.query)) {
          throw new Error(
            "Write/DDL statements are blocked. The server is read-only " +
            "(set SNOWFLAKE_READ_ONLY=false to allow them)."
          );
        }
        const { rows, rowCount } = await runQuery(args.query);
        // Guard against dumping enormous result sets into the context window.
        const capped = rows.slice(0, c.rowLimit);
        return jsonText({
          row_count: rowCount,
          returned: capped.length,
          truncated: rowCount > capped.length,
          rows: capped,
        });
      } catch (err) {
        return errText(err);
      }
    }
  );

  // 9) Cortex AI tools (opt-out via SNOWFLAKE_CORTEX_ENABLED=false).
  if (getConfig().cortexEnabled) {
    registerCortexTools(server);
  }
}
