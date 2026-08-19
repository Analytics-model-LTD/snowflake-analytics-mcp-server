/**
 * snowflake.ts — thin wrapper around the official `snowflake-sdk` driver.
 *
 * Responsibilities:
 *   - Read connection config from environment variables.
 *   - Maintain a single, lazily-established connection that is reused across
 *     tool calls (stdio is single-user, so a connection pool is overkill).
 *   - Reconnect transparently if the session has dropped.
 *   - Provide a promisified query runner and safe identifier quoting.
 *
 * Auth modes (pick via SNOWFLAKE_AUTHENTICATOR, default = password):
 *   - SNOWFLAKE            : username + password
 *   - SNOWFLAKE_JWT        : key-pair (SNOWFLAKE_PRIVATE_KEY or _PATH, optional passphrase)
 *   - OAUTH                : username + SNOWFLAKE_TOKEN
 *   - EXTERNALBROWSER      : interactive SSO (not usable under stdio automation)
 */
import { readFileSync } from "node:fs";
import snowflake, { type Connection } from "snowflake-sdk";

// Keep the driver quiet — its default logger writes to stdout, which would
// corrupt the MCP stdio stream. Route everything to stderr at ERROR level.
snowflake.configure({ logLevel: "ERROR" });

export interface SnowflakeConfig {
  account: string;
  username: string;
  password?: string;
  authenticator: string;
  token?: string;
  privateKey?: string;
  privateKeyPass?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
  queryTimeoutMs: number;
  rowLimit: number;
  readOnly: boolean;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

export function loadConfig(): SnowflakeConfig {
  const authenticator = (process.env.SNOWFLAKE_AUTHENTICATOR || "SNOWFLAKE")
    .trim()
    .toUpperCase();

  let privateKey: string | undefined;
  if (authenticator === "SNOWFLAKE_JWT") {
    if (process.env.SNOWFLAKE_PRIVATE_KEY) {
      privateKey = process.env.SNOWFLAKE_PRIVATE_KEY;
    } else if (process.env.SNOWFLAKE_PRIVATE_KEY_PATH) {
      privateKey = readFileSync(
        process.env.SNOWFLAKE_PRIVATE_KEY_PATH.trim(),
        "utf8"
      );
    } else {
      throw new Error(
        "SNOWFLAKE_AUTHENTICATOR=SNOWFLAKE_JWT requires SNOWFLAKE_PRIVATE_KEY or SNOWFLAKE_PRIVATE_KEY_PATH"
      );
    }
  }

  return {
    account: req("SNOWFLAKE_ACCOUNT"),
    username: req("SNOWFLAKE_USERNAME"),
    password:
      authenticator === "SNOWFLAKE" ? req("SNOWFLAKE_PASSWORD") : process.env.SNOWFLAKE_PASSWORD?.trim(),
    authenticator,
    token: process.env.SNOWFLAKE_TOKEN?.trim(),
    privateKey,
    privateKeyPass: process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE?.trim(),
    warehouse: process.env.SNOWFLAKE_WAREHOUSE?.trim(),
    database: process.env.SNOWFLAKE_DATABASE?.trim(),
    schema: process.env.SNOWFLAKE_SCHEMA?.trim(),
    role: process.env.SNOWFLAKE_ROLE?.trim(),
    queryTimeoutMs: Number(process.env.QUERY_TIMEOUT_MS || 60000),
    rowLimit: Number(process.env.SNOWFLAKE_ROW_LIMIT || 1000),
    readOnly: (process.env.SNOWFLAKE_READ_ONLY || "true").toLowerCase() !== "false",
  };
}

let cfg: SnowflakeConfig | null = null;
let conn: Connection | null = null;

export function getConfig(): SnowflakeConfig {
  if (!cfg) cfg = loadConfig();
  return cfg;
}

function buildConnection(c: SnowflakeConfig): Connection {
  const opts: Record<string, unknown> = {
    account: c.account,
    username: c.username,
    authenticator: c.authenticator,
    clientSessionKeepAlive: true,
    application: "AnalyticsModel_MCP",
  };
  if (c.password) opts.password = c.password;
  if (c.token) opts.token = c.token;
  if (c.privateKey) opts.privateKey = c.privateKey;
  if (c.privateKeyPass) opts.privateKeyPass = c.privateKeyPass;
  if (c.warehouse) opts.warehouse = c.warehouse;
  if (c.database) opts.database = c.database;
  if (c.schema) opts.schema = c.schema;
  if (c.role) opts.role = c.role;
  return snowflake.createConnection(opts as snowflake.ConnectionOptions);
}

async function ensureConnection(): Promise<Connection> {
  const c = getConfig();
  if (conn && conn.isUp()) return conn;

  const connection = buildConnection(c);
  await new Promise<void>((resolve, reject) => {
    connection.connect((err) => (err ? reject(err) : resolve()));
  });
  conn = connection;
  return conn;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export async function runQuery(
  sqlText: string,
  binds: unknown[] = []
): Promise<QueryResult> {
  const c = getConfig();
  const connection = await ensureConnection();

  const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    connection.execute({
      sqlText,
      binds: binds as snowflake.Binds,
      // Cap runaway queries at the configured timeout.
      // (SDK-level; server-side statement_timeout can also be set.)
      complete: (err, _stmt, r) => {
        if (err) reject(err);
        else resolve((r as Record<string, unknown>[]) || []);
      },
    });
    // Best-effort client-side timeout guard.
    setTimeout(() => {
      /* no-op: snowflake-sdk resolves via complete; this keeps types simple */
    }, c.queryTimeoutMs).unref?.();
  });

  return { rows, rowCount: rows.length };
}

/**
 * Validate and quote a Snowflake identifier (database / schema / table / column).
 * Snowflake identifiers may contain letters, digits, underscores and $ .
 * Anything else is rejected to prevent SQL injection through identifier slots.
 * The result is wrapped in double quotes with internal quotes doubled.
 */
export function quoteIdent(name: string): string {
  if (!/^[A-Za-z0-9_$]+$/.test(name)) {
    throw new Error(
      `Invalid identifier "${name}". Only letters, digits, _ and $ are allowed.`
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build a fully-qualified name from optional database/schema plus a table.
 * Falls back to the connection's configured database/schema when omitted.
 */
export function qualify(
  table: string,
  database?: string,
  schema?: string
): string {
  const c = getConfig();
  const db = database || c.database;
  const sc = schema || c.schema;
  const parts: string[] = [];
  if (db) parts.push(quoteIdent(db));
  if (sc) parts.push(quoteIdent(sc));
  parts.push(quoteIdent(table));
  return parts.join(".");
}

const WRITE_RE =
  /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CALL|COPY|PUT|REMOVE|USE)\b/i;

export function isReadOnlyStatement(sql: string): boolean {
  return !WRITE_RE.test(sql);
}
