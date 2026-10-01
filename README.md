# snowflake-analytics-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Snowflake**. It connects to Snowflake via the official `snowflake-sdk` driver (pure Node — no client binary needed) and exposes table-discovery, SQL query, and Cortex AI tools over stdio. Runnable directly with `npx`.

## Install

```bash
npm install -g snowflake-analytics-mcp-server
# or run directly (no install):
npx -y snowflake-analytics-mcp-server
```

## Quick start (key-pair auth — recommended)

Snowflake is phasing out password-only sign-ins. Password connections fail with
`Multi-factor authentication is required for this account` once MFA is enforced on the user,
and an MCP server running over stdio cannot answer an MFA prompt. Key-pair auth with a
dedicated **service user** avoids MFA entirely and is the recommended setup.

**1. Generate a key pair** (uses Node — no OpenSSL needed):

```bash
node -e "const {generateKeyPairSync:g}=require('crypto'),f=require('fs');const k=g('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});f.writeFileSync('rsa_key.p8',k.privateKey);f.writeFileSync('rsa_key.pub',k.publicKey)"
```

This writes `rsa_key.p8` (private key — keep secret) and `rsa_key.pub` (public key — safe to share).

**2. Create a service user in Snowflake** (as `ACCOUNTADMIN`, in a Snowsight worksheet). Paste the
public key's base64 body only — without the `BEGIN`/`END` lines:

```sql
USE ROLE ACCOUNTADMIN;

CREATE USER ANALYTICS_MCP
  TYPE = SERVICE
  RSA_PUBLIC_KEY = 'MIIBIjANBgkqh...'
  DEFAULT_ROLE = SYSADMIN
  DEFAULT_WAREHOUSE = COMPUTE_WH;

GRANT ROLE SYSADMIN TO USER ANALYTICS_MCP;
```

To add a key to an existing user instead: `ALTER USER <name> SET RSA_PUBLIC_KEY = 'MIIBIjANBgkqh...';`

**3. Verify the key** (optional but recommended). The fingerprint in Snowflake must match your local key:

```sql
DESC USER ANALYTICS_MCP;   -- see the RSA_PUBLIC_KEY_FP row
```

```bash
node -e "const c=require('crypto'),f=require('fs');console.log('SHA256:'+c.createHash('sha256').update(c.createPublicKey(f.readFileSync('rsa_key.pub')).export({type:'spki',format:'der'})).digest('base64'))"
```

**4. Configure the server** with `SNOWFLAKE_USERNAME=ANALYTICS_MCP` and the private key (see
[Configuration](#configuration)). Do **not** set a password.

**5. Test:** call `test_connection` — it should return `connected: true` with your user and role.

## Configuration

All credentials come from environment variables.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SNOWFLAKE_ACCOUNT` | ✅ | — | Account identifier in `ORGNAME-ACCOUNTNAME` form (e.g. `CXKKWJE-DZ51267`). Legacy locator form (`xy12345.eu-central-1`) also works |
| `SNOWFLAKE_USERNAME` | ✅ | — | Login name |
| `SNOWFLAKE_PRIVATE_KEY` | key-pair | — | PEM private key contents. Multi-line, single-line, or `\n`-escaped values all work. Recommended for hosted setups |
| `SNOWFLAKE_PRIVATE_KEY_PATH` | key-pair | — | Path to a PEM private key file (alternative to the above; convenient for local use) |
| `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` | — | — | Passphrase, if the private key is encrypted |
| `SNOWFLAKE_PASSWORD` | password auth only | — | Not needed with key-pair auth. Fails for MFA-enforced users |
| `SNOWFLAKE_AUTHENTICATOR` | — | auto | `SNOWFLAKE_JWT` when a private key is set, otherwise `SNOWFLAKE` (password). Also supports `OAUTH`. An explicit value overrides auto-detection |
| `SNOWFLAKE_TOKEN` | OAuth | — | OAuth access token (with `SNOWFLAKE_AUTHENTICATOR=OAUTH`) |
| `SNOWFLAKE_WAREHOUSE` | recommended | — | Virtual warehouse to use (queries fail without an active warehouse) |
| `SNOWFLAKE_DATABASE` | recommended | — | Default database (used by `list_tables`, and as the fallback when a caller passes an inaccessible database) |
| `SNOWFLAKE_SCHEMA` | recommended | — | Default schema |
| `SNOWFLAKE_ROLE` | — | user default | Role to assume |
| `SNOWFLAKE_READ_ONLY` | — | `true` | Blocks writes/DDL in `execute_query`. Set `false` to allow them |
| `SNOWFLAKE_ROW_LIMIT` | — | `1000` | Hard cap on returned rows |
| `QUERY_TIMEOUT_MS` | — | `60000` | Client-side query timeout |
| `SNOWFLAKE_CORTEX_ENABLED` | — | `true` | Register the Cortex AI tools. Set `false` to hide them |
| `SNOWFLAKE_CORTEX_MODEL` | — | `llama3.1-8b` | Default model for Cortex AI_COMPLETE / text-to-SQL |
| `SNOWFLAKE_PARTNER_CSID` | — | `Analytics-model` | Partner Connection String Identifier registered on SPN; sent as the Snowflake `application` tag for Connected-Application telemetry |

### Account identifier tip

Find your identifier by running this in Snowsight:

```sql
SELECT CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME();
```

Use hyphens, not underscores, if a client has trouble connecting (e.g. `orgname-account-name`).

## Claude Desktop config

Add to `claude_desktop_config.json`.

### Key-pair auth (recommended)

```json
{
  "mcpServers": {
    "snowflake": {
      "command": "npx",
      "args": ["-y", "snowflake-analytics-mcp-server"],
      "env": {
        "SNOWFLAKE_ACCOUNT": "ORGNAME-ACCOUNTNAME",
        "SNOWFLAKE_USERNAME": "ANALYTICS_MCP",
        "SNOWFLAKE_PRIVATE_KEY_PATH": "/path/to/rsa_key.p8",
        "SNOWFLAKE_ROLE": "SYSADMIN",
        "SNOWFLAKE_WAREHOUSE": "COMPUTE_WH",
        "SNOWFLAKE_DATABASE": "ANALYTICS_DB",
        "SNOWFLAKE_SCHEMA": "PUBLIC"
      }
    }
  }
}
```

For hosted environments where the key file isn't on disk, pass the key contents instead:

```json
"SNOWFLAKE_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----"
```

If the key is encrypted, also set `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`.

### Password auth

> Only works for users **without** enforced MFA. Prefer key-pair auth.

```json
"env": {
  "SNOWFLAKE_ACCOUNT": "ORGNAME-ACCOUNTNAME",
  "SNOWFLAKE_USERNAME": "ANALYTICS_USER",
  "SNOWFLAKE_PASSWORD": "••••••••",
  "SNOWFLAKE_WAREHOUSE": "COMPUTE_WH",
  "SNOWFLAKE_DATABASE": "ANALYTICS_DB",
  "SNOWFLAKE_SCHEMA": "PUBLIC",
  "SNOWFLAKE_ROLE": "ANALYST"
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

## Troubleshooting

| Error | Cause and fix |
|---|---|
| `Multi-factor authentication is required for this account` | The server is using password auth for an MFA-enforced user. Switch to key-pair auth (see [Quick start](#quick-start-key-pair-auth--recommended)). Make sure `SNOWFLAKE_PASSWORD` is removed and `SNOWFLAKE_AUTHENTICATOR` is not set to `SNOWFLAKE` |
| `JWT token is invalid` | The private key doesn't match the public key on the user, or `SNOWFLAKE_USERNAME` / `SNOWFLAKE_ACCOUNT` is wrong. Compare the `RSA_PUBLIC_KEY_FP` fingerprint with your local key |
| `Key-pair auth requires SNOWFLAKE_PRIVATE_KEY or SNOWFLAKE_PRIVATE_KEY_PATH` | `SNOWFLAKE_AUTHENTICATOR=SNOWFLAKE_JWT` is set but no key was provided |
| `No active warehouse selected in the current session` | Set `SNOWFLAKE_WAREHOUSE`, or give the user a `DEFAULT_WAREHOUSE` |
| `Object does not exist or not authorized` | The role lacks access. Check `SNOWFLAKE_ROLE` and grants on the warehouse, database, and schema. For the sample data: `GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE_SAMPLE_DATA TO ROLE SYSADMIN;` |
| Can't connect / invalid account | Use the `ORGNAME-ACCOUNTNAME` identifier with hyphens |

## Security

- Never commit or share the private key (`rsa_key.p8`). Add key files to `.gitignore`.
- Use a dedicated `TYPE = SERVICE` user with only the privileges it needs, rather than a personal login.
- Keep `SNOWFLAKE_READ_ONLY=true` (the default) unless writes are required.
- To rotate a key, set `RSA_PUBLIC_KEY_2` with the new key, switch the server over, then unset the old one.

## License

MIT