import { AnalystError } from '@data-analyst/contracts';
import type { ConnectionTest, CatalogSnapshot } from '@data-analyst/contracts';
import type { DriverQueryContext, DriverQueryOutput, SqlDriver } from '../driver.js';
import { resolveEndpoint } from '../endpoint.js';

// ---------------------------------------------------------------------------
// PostgreSQL 驱动(lazy import 'pg';依赖未随发行物提供时如实报错)。
// 只读兜底:statement_timeout 会话参数 + 语句白名单由守卫层承担;
// 此处负责超时与行数/字节截断的驱动侧语义。
// ---------------------------------------------------------------------------

interface PgClient {
  connect(): Promise<void>;
  query(text: string, values?: Array<unknown>): Promise<{
    rows: Array<Array<unknown>>;
    fields: Array<{ name: string }>;
  }>;
  end(): Promise<void>;
}

async function loadPgModule(): Promise<{
  Client: new (config: Record<string, unknown>) => PgClient;
}> {
  try {
    // 计算型模块说明符:pg 为可选依赖,缺省发行物不含其类型与实现
    const specifier = ['pg'].join('');
    const module = (await import(specifier)) as unknown as {
      Client: new (config: Record<string, unknown>) => PgClient;
    };
    return module;
  } catch {
    throw new AnalystError({
      code: 'ENVIRONMENT_INCOMPLETE',
      message: "PostgreSQL 驱动依赖 'pg' 未安装;离线发行包不包含该客户端时无法使用此数据源",
      request_id: null,
      run_id: null,
      retryable: false,
      details: { driver: 'postgres' },
    });
  }
}

export class PostgresDriver implements SqlDriver {
  readonly name = 'postgres';
  readonly #endpoint: string;
  readonly #password: string | null;

  constructor(endpoint: string, password: string | null) {
    this.#endpoint = endpoint;
    this.#password = password;
  }

  async #withClient<T>(operation: (client: PgClient) => Promise<T>): Promise<T> {
    const { Client } = await loadPgModule();
    const parsed = resolveEndpoint(this.#endpoint, 5432);
    const client = new Client({
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      ...(this.#password !== null ? { password: this.#password } : {}),
      application_name: 'data-analyst-readonly',
    });
    await client.connect();
    try {
      return await operation(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async testConnection(timeoutMs: number): Promise<ConnectionTest> {
    const started = Date.now();
    await this.#withClient(async (client) => {
      await client.query(`SET statement_timeout = ${Math.max(0, timeoutMs)}`);
      await client.query('SELECT 1');
    }).catch((error: unknown) => {
      throw new AnalystError({
        code: 'DATABASE_UNAVAILABLE',
        message: `PostgreSQL 连接失败: ${error instanceof Error ? error.message : String(error)}`,
        request_id: null,
        run_id: null,
        retryable: false,
        details: { driver: 'postgres' },
      });
    });
    return { ok: true, driver: this.name, message: null, latency_ms: Date.now() - started };
  }

  async describe(maxTables: number): Promise<Omit<CatalogSnapshot, 'source_id'>> {
    return this.#withClient(async (client) => {
      await client.query('SET statement_timeout = 10000');
      const tables = await client.query(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name LIMIT ${maxTables + 1}`,
      );
      const truncated = tables.rows.length > maxTables;
      const names = tables.rows
        .slice(0, maxTables)
        .map((row) => [String(row[0]), String(row[1])] as const);
      const bySchema = new Map<
        string,
        Array<{ name: string; columns: Array<{ name: string; type: string; nullable: boolean }> }>
      >();
      for (const [schema, table] of names) {
        const columns = await client.query(
          `SELECT column_name, data_type, is_nullable FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
          [schema, table],
        );
        const entry = bySchema.get(schema) ?? [];
        entry.push({
          name: table,
          columns: columns.rows.map((row) => ({
            name: String(row[0]),
            type: String(row[1]),
            nullable: String(row[2]) === 'YES',
          })),
        });
        bySchema.set(schema, entry);
      }
      return {
        schemas: [...bySchema.entries()].map(([name, tablesInSchema]) => ({
          name,
          tables: tablesInSchema,
        })),
        truncated,
      };
    });
  }

  async query(
    sql: string,
    params: Array<unknown>,
    context: DriverQueryContext,
  ): Promise<DriverQueryOutput> {
    return this.#withClient(async (client) => {
      await client.query(`SET statement_timeout = ${Math.max(0, context.timeoutMs)}`);
      // SELECT/WITH 包装 LIMIT 实现行数上限;其余白名单语句(EXPLAIN/SHOW 等)原样执行
      const wrapped = /^(select|with)\b/i.test(sql)
        ? `SELECT * FROM (${sql}) AS _product_query LIMIT ${context.maxRows + 1}`
        : sql;
      const result = await client.query(wrapped, params);
      const columns = result.fields.map((field) => field.name);
      const rows = result.rows;
      let truncated = rows.length > context.maxRows;
      const kept = truncated ? rows.slice(0, context.maxRows) : rows;
      let bytes = 0;
      const sized: Array<Array<unknown>> = [];
      for (const row of kept) {
        const rowBytes = row.reduce<number>(
          (acc, value) => acc + (value === null || value === undefined ? 0 : String(value).length + 2),
          16,
        );
        if (bytes + rowBytes > context.maxBytes) {
          truncated = true;
          break;
        }
        bytes += rowBytes;
        sized.push(row);
      }
      return { columns, rows: sized, truncated };
    }).catch((error: unknown) => {
      if (error instanceof AnalystError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AnalystError({
        code: /statement timeout|canceling statement/i.test(message) ? 'TIMEOUT' : 'UNPROCESSABLE',
        message: `PostgreSQL 查询失败: ${message}`,
        request_id: null,
        run_id: null,
        retryable: false,
        details: { driver: 'postgres' },
      });
    });
  }

  async close(): Promise<void> {
    // 连接按操作打开与关闭
  }
}
