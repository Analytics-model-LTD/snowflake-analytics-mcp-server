/**
 * cortex.ts — Snowflake Cortex AI tools.
 *
 * These are additive on top of the fast SQL/discovery tools: Cortex functions
 * are generative AI calls (token-billed, higher latency), so they are exposed as
 * their own tools rather than wrapped around metadata operations.
 *
 * Every Cortex function here is invoked as a SELECT, so the tools remain fully
 * compatible with SNOWFLAKE_READ_ONLY=true. The text-to-SQL tool additionally
 * enforces read-only on the *generated* SQL regardless of server settings.
 *
 * Model is configurable via SNOWFLAKE_CORTEX_MODEL (default: llama3.1-8b).
 * Availability depends on the account's region and the role holding the
 * SNOWFLAKE.CORTEX_USER database role — errors are surfaced with a hint.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getConfig,
  runQuery,
  quoteIdent,
  resolveDatabase,
  isReadOnlyStatement,
} from "../snowflake.js";

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function cortexErr(err: unknown) {
  const raw = err instanceof Error ? err.message : String(err);
  // Surface a helpful hint for the two most common Cortex setup failures.
  const hintable = /cortex|not enabled|unknown function|privilege|not authorized|CORTEX_USER|region/i.test(
    raw
  );
  const message = hintable
    ? `${raw}\n\nHint: Cortex AI requires an account in a supported region and a role holding the SNOWFLAKE.CORTEX_USER database role (plus USE AI FUNCTIONS). Confirm both, or set SNOWFLAKE_CORTEX_ENABLED=false to hide these tools.`
    : raw;
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

// A Cortex model identifier is a simple slug — validate before inlining it.
function safeModel(model?: string): string {
  const m = (model || getConfig().cortexModel).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(m)) {
    throw new Error(`Invalid model name "${m}".`);
  }
  return m;
}

// Strip markdown fences and trailing semicolons; keep only the first statement.
function cleanSql(text: string): string {
  let s = text.trim();
  s = s.replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Take up to the first semicolon so we execute a single statement.
  const semi = s.indexOf(";");
  if (semi !== -1) s = s.slice(0, semi);
  return s.trim();
}

// Build a compact schema description for the configured database/schema.
async function schemaContext(database: string, schema?: string): Promise<string> {
  const conditions: string[] = ["TABLE_SCHEMA <> 'INFORMATION_SCHEMA'"];
  const binds: unknown[] = [];
  if (schema) {
    conditions[0] = "TABLE_SCHEMA = ?";
    binds.push(schema);
  }
  const { rows } = await runQuery(
    `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE ` +
      `FROM ${quoteIdent(database)}.INFORMATION_SCHEMA.COLUMNS ` +
      `WHERE ${conditions.join(" AND ")} ` +
      `ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION ` +
      `LIMIT 800`,
    binds
  );

  const tables = new Map<string, string[]>();
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    const key = `${o.TABLE_SCHEMA}.${o.TABLE_NAME}`;
    if (!tables.has(key)) tables.set(key, []);
    tables.get(key)!.push(`${o.COLUMN_NAME} ${o.DATA_TYPE}`);
  }
  const lines: string[] = [];
  for (const [tbl, cols] of tables) {
    lines.push(`${tbl} (${cols.join(", ")})`);
  }
  return lines.join("\n");
}

export function registerCortexTools(server: McpServer): void {
  // ── cortex_ask: natural language → SQL → answer ─────────────────────────────
  server.registerTool(
    "cortex_ask",
    {
      title: "Ask (Cortex text-to-SQL)",
      description:
        "Answer a natural-language question about the data. Reads the schema, uses " +
        "Cortex AI_COMPLETE to generate a read-only SQL query, runs it, and returns " +
        "the rows plus the generated SQL. Best for analytical questions like " +
        "'what is total revenue' or 'top 5 customers by orders'.",
      inputSchema: {
        question: z.string().describe("The natural-language question to answer."),
        database: z.string().optional().describe("Defaults to SNOWFLAKE_DATABASE."),
        schema: z.string().optional().describe("Defaults to SNOWFLAKE_SCHEMA."),
        model: z.string().optional().describe("Cortex model. Defaults to SNOWFLAKE_CORTEX_MODEL."),
      },
    },
    async (args: { question: string; database?: string; schema?: string; model?: string }) => {
      try {
        const c = getConfig();
        const database = (await resolveDatabase(args.database)) || c.database;
        const schema = args.schema || c.schema;
        if (!database) throw new Error("No database. Set SNOWFLAKE_DATABASE or pass `database`.");

        const model = safeModel(args.model);
        const ctx = await schemaContext(database, schema);
        if (!ctx) throw new Error(`No tables found in ${database}${schema ? "." + schema : ""}.`);

        const prompt =
          `You are a Snowflake SQL expert. Using ONLY the schema below, write a single ` +
          `read-only Snowflake SQL query (SELECT or WITH only) that answers the question. ` +
          `Fully qualify tables as ${database}.<schema>.<table>. Return ONLY the SQL with no ` +
          `explanation and no markdown fences.\n\nSchema:\n${ctx}\n\nQuestion: ${args.question}\n\nSQL:`;

        const gen = await runQuery(`SELECT AI_COMPLETE('${model}', ?) AS SQL_TEXT`, [prompt]);
        const generatedSql = cleanSql(String((gen.rows[0]?.SQL_TEXT ?? "")));
        if (!generatedSql) throw new Error("Model did not return any SQL.");

        // Generated SQL is ALWAYS restricted to read-only, regardless of server config.
        if (!isReadOnlyStatement(generatedSql)) {
          return jsonText({
            question: args.question,
            generated_sql: generatedSql,
            error: "Generated SQL was not read-only and was blocked. Rephrase the question.",
          });
        }

        const result = await runQuery(generatedSql);
        const capped = result.rows.slice(0, c.rowLimit);
        return jsonText({
          question: args.question,
          generated_sql: generatedSql,
          row_count: result.rowCount,
          returned: capped.length,
          truncated: result.rowCount > capped.length,
          rows: capped,
        });
      } catch (err) {
        return cortexErr(err);
      }
    }
  );

  // ── cortex_complete: general LLM completion ─────────────────────────────────
  server.registerTool(
    "cortex_complete",
    {
      title: "Complete (Cortex AI_COMPLETE)",
      description:
        "Generate a free-form LLM completion for a prompt using Cortex AI_COMPLETE. " +
        "Use for summaries, explanations, or generation that isn't a SQL query.",
      inputSchema: {
        prompt: z.string().describe("The prompt to send to the model."),
        model: z.string().optional().describe("Cortex model. Defaults to SNOWFLAKE_CORTEX_MODEL."),
      },
    },
    async (args: { prompt: string; model?: string }) => {
      try {
        const model = safeModel(args.model);
        const { rows } = await runQuery(`SELECT AI_COMPLETE('${model}', ?) AS RESPONSE`, [
          args.prompt,
        ]);
        return jsonText({ model, response: rows[0]?.RESPONSE ?? null });
      } catch (err) {
        return cortexErr(err);
      }
    }
  );

  // ── cortex_sentiment: sentiment of a text ───────────────────────────────────
  server.registerTool(
    "cortex_sentiment",
    {
      title: "Sentiment (Cortex AI_SENTIMENT)",
      description: "Return the sentiment of a text string using Cortex AI_SENTIMENT.",
      inputSchema: { text: z.string().describe("The text to analyze.") },
    },
    async (args: { text: string }) => {
      try {
        const { rows } = await runQuery(`SELECT AI_SENTIMENT(?) AS SENTIMENT`, [args.text]);
        return jsonText({ sentiment: rows[0]?.SENTIMENT ?? null });
      } catch (err) {
        return cortexErr(err);
      }
    }
  );

  // ── cortex_summarize: summarize a text ──────────────────────────────────────
  server.registerTool(
    "cortex_summarize",
    {
      title: "Summarize (Cortex SUMMARIZE)",
      description: "Return a concise summary of a text string using Cortex.",
      inputSchema: { text: z.string().describe("The text to summarize.") },
    },
    async (args: { text: string }) => {
      try {
        const { rows } = await runQuery(`SELECT SNOWFLAKE.CORTEX.SUMMARIZE(?) AS SUMMARY`, [
          args.text,
        ]);
        return jsonText({ summary: rows[0]?.SUMMARY ?? null });
      } catch (err) {
        return cortexErr(err);
      }
    }
  );

  // ── cortex_classify: classify into user categories ──────────────────────────
  server.registerTool(
    "cortex_classify",
    {
      title: "Classify (Cortex AI_CLASSIFY)",
      description:
        "Classify a text string into one of the provided categories using Cortex AI_CLASSIFY.",
      inputSchema: {
        text: z.string().describe("The text to classify."),
        categories: z
          .array(z.string())
          .min(2)
          .describe("Two or more category labels to choose from."),
      },
    },
    async (args: { text: string; categories: string[] }) => {
      try {
        // Build a SQL array literal of escaped string categories; bind the input.
        const cats = args.categories
          .map((x) => `'${String(x).replace(/'/g, "''")}'`)
          .join(", ");
        const { rows } = await runQuery(
          `SELECT AI_CLASSIFY(?, [${cats}]) AS CLASSIFICATION`,
          [args.text]
        );
        return jsonText({ classification: rows[0]?.CLASSIFICATION ?? null });
      } catch (err) {
        return cortexErr(err);
      }
    }
  );

  // ── cortex_translate: translate text ────────────────────────────────────────
  server.registerTool(
    "cortex_translate",
    {
      title: "Translate (Cortex TRANSLATE)",
      description:
        "Translate text to a target language using Cortex. Source language is " +
        "auto-detected when omitted.",
      inputSchema: {
        text: z.string().describe("The text to translate."),
        to_language: z.string().describe("Target language code, e.g. 'en', 'hi', 'es'."),
        from_language: z
          .string()
          .optional()
          .describe("Source language code. Empty = auto-detect."),
      },
    },
    async (args: { text: string; to_language: string; from_language?: string }) => {
      try {
        const { rows } = await runQuery(
          `SELECT SNOWFLAKE.CORTEX.TRANSLATE(?, ?, ?) AS TRANSLATION`,
          [args.text, args.from_language || "", args.to_language]
        );
        return jsonText({ translation: rows[0]?.TRANSLATION ?? null });
      } catch (err) {
        return cortexErr(err);
      }
    }
  );
}
