# snowflake-analytics-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Snowflake**, built for the Analytics Model platform. It connects to Snowflake via the official `snowflake-sdk` driver (pure Node — no client binary needed, unlike the Oracle server) and exposes table-discovery and query tools over stdio. Runnable directly with `npx`.

The `list_tables` tool returns the platform's exact table-discovery envelope, so it drops straight into the same `fetchMcpTables` flow as the Clio, Dropbox and Shopify servers.

## Install

```bash
npm install -g snowflake-analytics-mcp-server
# or run directly (no install):
npx -y snowflake-analytics-mcp-server
```

## Configuration

All credentials come from environment variables.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SNOWFLAKE_ACCOUNT` | ✅ | — | Account identifier, e.g. `xy12345.eu-central-1` or `orgname-account_name` |
| `SNOWFLAKE_USERNAME` | ✅ | — | Login name |
| `SNOWFLAKE_PASSWORD` | ✅ (password auth) | — | Password (required unless using key-pair/OAuth) |
| `SNOWFLAKE_WAREHOUSE` | — | — | Virtual warehouse to use |
| `SNOWFLAKE_DATABASE` | recommended | — | Default database (used by `list_tables` when no arg is given) |
| `SNOWFLAKE_SCHEMA` | recommended | — | Default schema |
| `SNOWFLAKE_ROLE` | — | — | Role to assume |
| `SNOWFLAKE_AUTHENTICATOR` | — | `SNOWFLAKE` | `SNOWFLAKE` (password), `SNOWFLAKE_JWT` (key-pair), `OAUTH` |
| `SNOWFLAKE_PRIVATE_KEY` | key-pair | — | PEM private key contents |
| `SNOWFLAKE_PRIVATE_KEY_PATH` | key-pair | — | Path to a PEM private key file (alternative to above) |
| `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` | — | — | Passphrase, if the key is encrypted |
| `SNOWFLAKE_TOKEN` | OAuth | — | OAuth access token (with `SNOWFLAKE_AUTHENTICATOR=OAUTH`) |
| `SNOWFLAKE_READ_ONLY` | — | `true` | Blocks writes/DDL in `execute_query`. Set `false` to allow them |
| `SNOWFLAKE_ROW_LIMIT` | — | `1000` | Hard cap on returned rows |
| `QUERY_TIMEOUT_MS` | — | `60000` | Client-side query timeout |

### Account identifier tip

Use hyphens, not underscores, in the account identifier if a client has trouble connecting (e.g. `orgname-account-name`).

## Claude Desktop config

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "snowflake": {
      "command": "npx",
      "args": ["-y", "snowflake-analytics-mcp-server"],
      "env": {
        "SNOWFLAKE_ACCOUNT": "xy12345.eu-central-1",
        "SNOWFLAKE_USERNAME": "ANALYTICS_USER",
        "SNOWFLAKE_PASSWORD": "••••••••",
        "SNOWFLAKE_WAREHOUSE": "COMPUTE_WH",
        "SNOWFLAKE_DATABASE": "ANALYTICS_DB",
        "SNOWFLAKE_SCHEMA": "PUBLIC",
        "SNOWFLAKE_ROLE": "ANALYST"
      }
    }
  }
}
```

### Key-pair auth example

```json
"env": {
  "SNOWFLAKE_ACCOUNT": "xy12345.eu-central-1",
  "SNOWFLAKE_USERNAME": "ANALYTICS_USER",
  "SNOWFLAKE_AUTHENTICATOR": "SNOWFLAKE_JWT",
  "SNOWFLAKE_PRIVATE_KEY_PATH": "/path/to/rsa_key.p8",
  "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE": "••••••••",
  "SNOWFLAKE_DATABASE": "ANALYTICS_DB",
  "SNOWFLAKE_SCHEMA": "PUBLIC"
}
```

## Tools

| Tool | Args | Description |
|---|---|---|
| `list_tables` | `database?`, `schema?`, `include_views?` | **Platform contract.** Returns `{ table_name }[]` in the double-wrapped envelope for `fetchMcpTables` |
| `test_connection` | — | Returns version, account, user, role, warehouse, database, schema |
| `list_databases` | — | Databases visible to the current role |
| `list_schemas` | `database?` | Schemas in a database |
| `list_warehouses` | — | Warehouses with size/state |
| `describe_table` | `table`, `database?`, `schema?` | Columns, types, nullability, defaults |
| `get_table_sample` | `table`, `database?`, `schema?`, `limit?` | Preview rows from a table |
| `execute_query` | `query` | Run SQL. Read-only unless `SNOWFLAKE_READ_ONLY=false` |

## Platform integration note

`list_tables` matches the confirmed envelope used by the Shopify/Clio servers:

```jsonc
{
  "is_success": true,
  "status_code": 200,
  "data": "[{\"table_name\":\"ORDERS\"},{\"table_name\":\"CUSTOMERS\"}]", // double-stringified
  "message": "Found 2 table(s).",
  "requestedPayload": { "database": "ANALYTICS_DB", "schema": "PUBLIC", "include_views": true }
}
```

Because Snowflake exposes **arbitrary** user tables (unlike Clio's fixed resource categories, which each had a `list_<resource>` tool), there is no per-table tool. When a user selects a table in the platform, the backend should fetch its rows via `get_table_sample` (preview) or `execute_query` (`SELECT * FROM <table>`), rather than calling a tool named after the table. Confirm this mapping with the backend before wiring the row-fetch step.

## License

MIT
