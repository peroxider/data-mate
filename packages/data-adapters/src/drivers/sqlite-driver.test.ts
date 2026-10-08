import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { AnalystError } from '@data-analyst/contracts';
import { SqliteDriver } from './sqlite-driver.js';

const dirs: string[] = [];

async function makeDriver(rows: number): Promise<SqliteDriver> {
  const root = await mkdtemp(join(tmpdir(), 'sqlite-driver-'));
  dirs.push(root);
  const dbPath = join(root, 'fixture.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE metrics (id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, value REAL)');
  const insert = db.prepare('INSERT INTO metrics (name, value) VALUES (?, ?)');
  for (let i = 0; i < rows; i += 1) {
    insert.run(`m${i}`, i * 1.5);
  }
  db.close();
  return new SqliteDriver(dbPath);
}

// 共享 fixture 贯穿全部用例,统一在 afterAll 清理
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let driver: SqliteDriver;

beforeAll(async () => {
  driver = await makeDriver(10);
});

describe('SqliteDriver', () => {
  it('testConnection 返回 ok 与延迟', async () => {
    const result = await driver.testConnection(2000);
    expect(result.ok).toBe(true);
    expect(result.driver).toBe('sqlite');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('describe 列出 main schema 与列信息', async () => {
    const catalog = await driver.describe(100);
    expect(catalog.truncated).toBe(false);
    expect(catalog.schemas).toHaveLength(1);
    expect(catalog.schemas[0]!.name).toBe('main');
    const metrics = catalog.schemas[0]!.tables.find((table) => table.name === 'metrics');
    expect(metrics?.columns.map((column) => column.name)).toEqual(['id', 'name', 'value']);
    expect(metrics?.columns[0]!.nullable).toBe(false);
  });

  it('query 返回列名与行', async () => {
    const output = await driver.query('SELECT name, value FROM metrics ORDER BY id', [], {
      maxRows: 100,
      maxBytes: 1_000_000,
      timeoutMs: 5000,
    });
    expect(output.columns).toEqual(['name', 'value']);
    expect(output.rows).toHaveLength(10);
    expect(output.truncated).toBe(false);
  });

  it('maxRows 截断:T09 truncated 语义', async () => {
    const output = await driver.query('SELECT id FROM metrics', [], {
      maxRows: 3,
      maxBytes: 1_000_000,
      timeoutMs: 5000,
    });
    expect(output.rows).toHaveLength(3);
    expect(output.truncated).toBe(true);
  });

  it('maxBytes 截断同样标记 truncated', async () => {
    const output = await driver.query('SELECT id, name FROM metrics', [], {
      maxRows: 100,
      maxBytes: 40,
      timeoutMs: 5000,
    });
    expect(output.truncated).toBe(true);
    expect(output.rows.length).toBeLessThan(10);
  });

  it('写语句因只读打开而物理失败(T10)', async () => {
    await expect(
      driver.query('CREATE TABLE evil (id INT)', [], {
        maxRows: 10,
        maxBytes: 10_000,
        timeoutMs: 5000,
      }),
    ).rejects.toThrowError(AnalystError);
  });

  it('超时被真实终止并返回 TIMEOUT(T10)', async () => {
    await expect(
      driver.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT * FROM c',
        [],
        { maxRows: 10_000_000, maxBytes: Number.MAX_SAFE_INTEGER, timeoutMs: 400 },
      ),
    ).rejects.toMatchObject({ payload: { code: 'TIMEOUT' } });
  });

  it('永不产出首行的聚合查询(无限 CTE 上 COUNT)同样能超时终止(对抗回归)', async () => {
    const started = Date.now();
    await expect(
      driver.query(
        'WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt) SELECT COUNT(*) AS n FROM cnt',
        [],
        { maxRows: 100, maxBytes: 1_000_000, timeoutMs: 500 },
      ),
    ).rejects.toMatchObject({ payload: { code: 'TIMEOUT' } });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('重复列名被去重以保证物化 CSV 列唯一', async () => {
    const output = await driver.query('SELECT 1 AS v, 2 AS v', [], {
      maxRows: 10,
      maxBytes: 10_000,
      timeoutMs: 5000,
    });
    expect(output.columns).toEqual(['v', 'v_2']);
  });

  it('文件不存在 → DATABASE_UNAVAILABLE', async () => {
    const missing = new SqliteDriver(join(tmpdir(), 'no-such-db-xyz.db'));
    await expect(missing.testConnection(2000)).rejects.toMatchObject({
      payload: { code: 'DATABASE_UNAVAILABLE' },
    });
  });
});
