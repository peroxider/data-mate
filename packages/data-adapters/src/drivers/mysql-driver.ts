import { AnalystError } from '@data-analyst/contracts';
import type { ConnectionTest, CatalogSnapshot } from '@data-analyst/contracts';
import type { DriverQueryContext, DriverQueryOutput, SqlDriver } from '../driver.js';
import { resolveEndpoint } from '../endpoint.js';

// ---------------------------------------------------------------------------
// MySQL 驱动(lazy import 'mysql2/promise';依赖未随发行物提供时如实报错)。
// 只读兜底:MAX_EXECUTION_TIME 会话参数 + 守卫层语句白名单。
// ---------------------------------------------------------------------------

interface MySqlConnection {
  query(options: {
    sql: string;
    values?: Array<unknown>;
    timeout?: number;
    rowsAsArray?: boolean;
  }): Promise<[Array<Array<unknown>>, Array<{ name: string }>]>;
  end(): Promise<void>;
}

async function loadMysqlModule(): Promise<{
  createConnection: (config: Record<string, unknown>) => Promise<MySqlConnection>;
}> {
  try {
    // 计算型模块说明符:mysql2 为可选依赖,缺省发行物不含其类型与实现
    const specifier = ['mysql2', '/promise'].join('');
    const module = (await import(specifier)) as unknown as {
      createConnection: (config: Record<string, unknown>) => Promise<MySqlConnection>;
    };
    return module;
  } catch {
    throw new AnalystError({
      code: 'ENVIRONMENT_INCOMPLETE',
      message: "MySQL 驱动依赖 'mysql2' 未安装;离线发行包不包含该客户端时无法使用此数据源",
      request_id: null,
      run_id: null,
      retryable: false,
      details: { driver: 'mysql' },
    });
  }
}

export class MySqlDriver implements SqlDriver {
  readonly name = 'mysql';
  readonly #endpoint: string;
  readonly #password: string | null;

  constructor(endpoint: string, password: string | null) {
    this.#endpoint = endpoint;
    this.#password = password;
  }

  async #withConnection<T>(operation: (connection: MySqlConnection) => Promise<T>): Promise<T> {
    const { createConnection } = await loadMysqlModule();
    const parsed = resolveEndpoint(this.#endpoint, 3306);
    const connection = await createConnection({
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      ...(this.#password !== null ? { password: this.#password } : {}),
      rowsAsArray: true,
      connectTimeout: 10_000,
    });
    try {
      return await operation(connection);
    } finally {
      await connection.end().catch(() => undefined);
    }
  }

  async testConnection(timeoutMs: number): Promise<ConnectionTest> {
    const started = Date.now();
    await this.#withConnection(async (connection) => {
      await connection.query({ sql: 'SELECT 1', timeout: timeoutMs });
    }).catch((error: unknown) => {
      throw new AnalystError({
        code: 'DATABASE_UNAVAILABLE',
        message: `MySQL 连接失败: ${error instanceof Error ? error.message : String(error)}`,
        request_id: null,
        run_id: null,
        retryable: false,
        details: { driver: 'mysql' },
      });
    });
    return { ok: true, driver: this.name, message: null, latency_ms: Date.now() - started };
  }

  async describe(
    maxTables: number,
  ): Promise<Omit<CatalogSnapshot, 'source_id'>> {
    return this.#withConnection(async (connection) => {
      const tables = await connection.query({
        sql: `SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES
              WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
              ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT ${maxTables + 1}`,
        timeout: 10_000,
      });
      const [tableRows] = tables;
      const truncated = tableRows.length > maxTables;
      const bySchema = new Map<
        string,
        Array<{ name: string; columns: Array<{ name: string; type: string; nullable: boolean }> }>
      >();
      for (const row of tableRows.slice(0, maxTables)) {
        const schema = String(row[0]);
        const table = String(row[1]);
        const columns = await connection.query({
          sql: `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
          values: [schema, table],
          timeout: 10_000,
        });
        const [columnRows] = columns;
        const entry = bySchema.get(schema) ?? [];
        entry.push({
          name: table,
          columns: columnRows.map((column) => ({
            name: String(column[0]),
            type: String(column[1]),
            nullable: String(column[2]) === 'YES',
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
    return this.#withConnection(async (connection) => {
      await connection
        .query({ sql: `SET SESSION MAX_EXECUTION_TIME = ${Math.max(0, context.timeoutMs)}` })
        .catch(() => undefined); // 非 SELECT 或旧版本 MySQL 无该变量时忽略
      const wrapped = /^(select|with)\b/i.test(sql)
        ? `SELECT * FROM (${sql}) AS _product_query LIMIT ${context.maxRows + 1}`
        : sql;
      const result = await connection.query({
        sql: wrapped,
        values: params,
        timeout: context.timeoutMs,
      });
      const [rows, fields] = result;
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
      return { columns: fields.map((field) => field.name), rows: sized, truncated };
    }).catch((error: unknown) => {
      if (error instanceof AnalystError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AnalystError({
        code: /max_execution_time|execution time|timeout|ER_QUERY_TIMEOUT/i.test(message)
          ? 'TIMEOUT'
          : 'UNPROCESSABLE',
        message: `MySQL 查询失败: ${message}`,
        request_id: null,
        run_id: null,
        retryable: false,
        details: { driver: 'mysql' },
      });
    });
  }

  async close(): Promise<void> {
    // 连接按操作打开与关闭
  }
}
