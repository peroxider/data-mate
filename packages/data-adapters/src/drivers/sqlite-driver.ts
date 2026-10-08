import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AnalystError } from '@data-analyst/contracts';
import type { ConnectionTest, CatalogSnapshot } from '@data-analyst/contracts';
import type { DriverQueryContext, DriverQueryOutput, SqlDriver } from '../driver.js';

// ---------------------------------------------------------------------------
// SQLite 驱动(node:sqlite,离线发行物自带,零外部依赖)。
// - 只读兜底:以 readOnly 打开数据库文件,写语句在驱动层物理失败(T10);
// - 真实超时:查询在独立子进程执行,主线程超时后 SIGKILL 强杀 ——
//   worker_threads 的 terminate 无法中断同步原生 SQLite 调用(如对无限
//   递归 CTE 的 COUNT(*) 聚合,永不返回首行),存活的 worker 又会阻止
//   进程退出;子进程 + SIGKILL 保证必然终止(T10);
// - 截断语义:取数到 maxRows+1/maxBytes 即停止,由上层标 truncated(T09)。
// ---------------------------------------------------------------------------

const CHILD_SOURCE = `
const { DatabaseSync } = require('node:sqlite');
let payload = '';
process.stdin.on('data', (chunk) => { payload += chunk; });
process.stdin.on('end', () => {
  try {
    const { path, sql, params, maxRows, maxBytes } = JSON.parse(payload);
    const db = new DatabaseSync(path, { readOnly: true });
    const stmt = db.prepare(sql);
    const columns = stmt.columns().map((c) => c.name);
    const rows = [];
    let bytes = 0;
    let truncated = false;
    const limit = maxRows + 1;
    for (const row of stmt.iterate(...params)) {
      const values = columns.map((name) => {
        const value = row[name];
        if (typeof value === 'bigint') return value.toString();
        return value;
      });
      rows.push(values);
      bytes += values.reduce((acc, v) => acc + (v === null || v === undefined ? 0 : String(v).length + 2), 16);
      if (rows.length >= limit) { truncated = true; rows.pop(); break; }
      if (bytes > maxBytes) { truncated = true; rows.pop(); break; }
    }
    process.stdout.write(JSON.stringify({ ok: true, columns, rows, truncated }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }));
  }
});
`;

interface WorkerResult {
  ok: boolean;
  columns?: string[];
  rows?: Array<Array<unknown>>;
  truncated?: boolean;
  error?: string;
}

function runQueryIsolated(payload: {
  path: string;
  sql: string;
  params: Array<unknown>;
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
}): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, ['-e', CHILD_SOURCE], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(
          new AnalystError({
            code: 'TIMEOUT',
            message: `SQLite 查询超过 ${Math.round(payload.timeoutMs / 1000)}s,已终止执行`,
            request_id: null,
            run_id: null,
            retryable: false,
            details: { driver: 'sqlite', timeout_ms: payload.timeoutMs },
          }),
        );
      });
    }, payload.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      finish(() => reject(error));
    });
    child.once('close', (code) => {
      finish(() => {
        try {
          resolve(JSON.parse(stdout) as WorkerResult);
        } catch {
          reject(new Error(`SQLite 查询子进程异常退出: code=${code}`));
        }
      });
    });
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}

function unavailable(message: string, details: Record<string, unknown>): AnalystError {
  return new AnalystError({
    code: 'DATABASE_UNAVAILABLE',
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details,
  });
}

export class SqliteDriver implements SqlDriver {
  readonly name = 'sqlite';
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async testConnection(timeoutMs: number): Promise<ConnectionTest> {
    const started = Date.now();
    const result = await runQueryIsolated({
      path: this.#path,
      sql: 'SELECT 1',
      params: [],
      maxRows: 1,
      maxBytes: 1024,
      timeoutMs,
    }).catch((error: unknown) => {
      if (error instanceof AnalystError) throw error;
      throw unavailable(
        `SQLite 连接失败: ${error instanceof Error ? error.message : String(error)}`,
        { driver: 'sqlite', path: this.#path },
      );
    });
    if (!result.ok) {
      throw unavailable(`SQLite 连接失败: ${result.error ?? '未知错误'}`, {
        driver: 'sqlite',
        path: this.#path,
      });
    }
    return {
      ok: true,
      driver: this.name,
      message: null,
      latency_ms: Date.now() - started,
    };
  }

  async describe(maxTables: number): Promise<Omit<CatalogSnapshot, 'source_id'>> {
    const result = await runQueryIsolated({
      path: this.#path,
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      params: [],
      maxRows: maxTables,
      maxBytes: Number.MAX_SAFE_INTEGER,
      timeoutMs: 10_000,
    });
    if (!result.ok || !result.rows) {
      throw unavailable(`SQLite 目录读取失败: ${result.error ?? '未知错误'}`, {
        driver: 'sqlite',
      });
    }
    const tableNames = result.rows.map((row) => String(row[0]));
    const truncated = Boolean(result.truncated);
    const db = new DatabaseSync(this.#path, { readOnly: true });
    try {
      const tables = tableNames.map((name) => {
        const infoRows = db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
        }>;
        return {
          name,
          columns: infoRows.map((column) => ({
            name: column.name,
            type: column.type || 'BLOB',
            nullable: column.notnull === 0,
          })),
        };
      });
      // SQLite 无多 schema 概念:全部表归入单一逻辑 schema
      return { schemas: [{ name: 'main', tables }], truncated };
    } finally {
      db.close();
    }
  }

  async query(
    sql: string,
    params: Array<unknown>,
    context: DriverQueryContext,
  ): Promise<DriverQueryOutput> {
    const result = await runQueryIsolated({
      path: this.#path,
      sql,
      params,
      maxRows: context.maxRows,
      maxBytes: context.maxBytes,
      timeoutMs: context.timeoutMs,
    }).catch((error: unknown) => {
      if (error instanceof AnalystError) throw error;
      throw unavailable(
        `SQLite 查询失败: ${error instanceof Error ? error.message : String(error)}`,
        { driver: 'sqlite' },
      );
    });
    if (!result.ok || !result.columns || !result.rows) {
      throw new AnalystError({
        code: 'UNPROCESSABLE',
        message: `SQLite 查询执行失败: ${result.error ?? '未知错误'}`,
        request_id: null,
        run_id: null,
        retryable: false,
        details: { driver: 'sqlite' },
      });
    }
    // 去重列名,保证物化 CSV 列唯一
    const seen = new Map<string, number>();
    const columns = result.columns.map((name) => {
      const count = seen.get(name) ?? 0;
      seen.set(name, count + 1);
      return count === 0 ? name : `${name}_${count + 1}`;
    });
    return { columns, rows: result.rows, truncated: Boolean(result.truncated) };
  }

  async close(): Promise<void> {
    // worker 按查询创建与回收,无持久连接
  }
}
