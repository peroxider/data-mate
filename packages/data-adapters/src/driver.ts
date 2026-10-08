import type { ConnectionTest, CatalogSnapshot } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// 数据库驱动端口:DatabaseAdapter 面向本接口工作,SQLite/PostgreSQL/MySQL
// 各自提供实现。实现负责只读兜底、超时与行数/字节截断的驱动侧语义。
// ---------------------------------------------------------------------------

export interface DriverQueryContext {
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
}

export interface DriverQueryOutput {
  columns: string[];
  rows: Array<Array<unknown>>;
  /** 驱动侧判定:达到 maxRows 或 maxBytes 而停止取数 */
  truncated: boolean;
}

export interface SqlDriver {
  readonly name: string;
  testConnection(timeoutMs: number): Promise<ConnectionTest>;
  describe(maxTables: number): Promise<Omit<CatalogSnapshot, 'source_id'>>;
  query(sql: string, params: Array<unknown>, context: DriverQueryContext): Promise<DriverQueryOutput>;
  close(): Promise<void>;
}
