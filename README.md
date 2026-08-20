# snowflake-analytics-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Snowflake**. It connects to Snowflake via the official `snowflake-sdk` driver (pure Node — no client binary needed) and exposes table-discovery, SQL query, and Cortex AI tools over stdio. Runnable directly with `npx`.

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
| `SNOWFLAKE_DATABASE` | recommended | — | Default database (used by `list_tables`, and as the fallback when a caller passes an inaccessible database) |
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
| `SNOWFLAKE_CORTEX_ENABLED` | — | `true` | Register the Cortex AI tools. Set `false` to hide them |
| `SNOWFLAKE_CORTEX_MODEL` | — | `llama3.1-8b` | Default model for Cortex AI_COMPLETE / text-to-SQL |

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

### SQL & discovery

| Tool | Args | Description |
|---|---|---|
| `list_tables` | `database?`, `schema?`, `include_views?` | Returns `{ table_name }[]` for table discovery |
| `test_connection` | — | Returns version, account, user, role, warehouse, database, schema |
| `list_databases` | — | Databases visible to the current role |
| `list_schemas` | `database?` | Schemas in a database |
| `list_warehouses` | — | Warehouses with size/state |
| `describe_table` | `table`, `database?`, `schema?` | Columns, types, nullability, defaults |
| `get_table_sample` | `table`, `database?`, `schema?`, `limit?` | Preview rows from a table |
| `execute_query` | `query` | Run SQL. Read-only unless `SNOWFLAKE_READ_ONLY=false` |

### Cortex AI

These are additive generative-AI tools (token-billed, higher latency than the SQL tools). Each is invoked as a `SELECT`, so they work with `SNOWFLAKE_READ_ONLY=true`. Disable them with `SNOWFLAKE_CORTEX_ENABLED=false`.

| Tool | Args | Description |
|---|---|---|
| `cortex_ask` | `question`, `database?`, `schema?`, `model?` | Natural-language question → generated read-only SQL → answer. Best for analytics like "what is total revenue" |
| `cortex_complete` | `prompt`, `model?` | Free-form LLM completion via AI_COMPLETE |
| `cortex_sentiment` | `text` | Sentiment of a text via AI_SENTIMENT |
| `cortex_summarize` | `text` | Concise summary of a text |
| `cortex_classify` | `text`, `categories[]` | Classify text into your categories via AI_CLASSIFY |
| `cortex_translate` | `text`, `to_language`, `from_language?` | Translate text (source auto-detected when omitted) |

`cortex_ask` generates SQL and always restricts it to read-only statements, regardless of `SNOWFLAKE_READ_ONLY`.

**Cortex prerequisites:** the account must be in a region that supports Cortex, and the connecting role needs the `SNOWFLAKE.CORTEX_USER` database role plus the `USE AI FUNCTIONS` privilege. If a Cortex call fails on region or privileges, the tool returns a hint explaining what to grant.

## Database resolution

`list_tables`, `describe_table`, `get_table_sample`, `list_schemas`, and `cortex_ask` accept an optional `database`. If the value passed isn't an accessible database, the tool falls back to `SNOWFLAKE_DATABASE` instead of erroring — so a stray or wrong database name from an upstream caller doesn't cause a failed lookup.

## License

MIT
