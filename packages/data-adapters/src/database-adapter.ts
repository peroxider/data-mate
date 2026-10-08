import { AnalystError } from '@data-analyst/contracts';
import type {
  CatalogSnapshot,
  ConnectionTest,
  DatabasePort,
  DataSourceBinding,
  ErrorCode,
  QueryRequest,
  QueryResultRef,
} from '@data-analyst/contracts';
import type { RepositoryPort, WorkspaceService } from '@data-analyst/core';
import type { SqlDriver } from './driver.js';
import { assertReadOnlySingleStatement } from './sql-guard.js';
import { SqliteDriver } from './drivers/sqlite-driver.js';
import { PostgresDriver } from './drivers/pg-driver.js';
import { MySqlDriver } from './drivers/mysql-driver.js';

// ---------------------------------------------------------------------------
// DatabasePort 产品实现(§8):三层只读防线的前两层在此汇合 ——
// 1) DataSourceBinding.readonly(契约层,创建时即固定);
// 2) sql-guard 语句白名单(单语句 + 只读关键字 + 拒绝模式);
// 3) 驱动只读连接(见 drivers/*)。
// 查询结果经 WorkspaceService.materializeQueryResult 物化为可追溯数据版本,
// 幂等键命中时直接返回既有 DataRef,不重复执行 SQL。
// ---------------------------------------------------------------------------

export interface DatabaseAdapterConfig {
  statement_timeout_seconds: number;
  max_result_rows: number;
  max_result_bytes: number;
}

export type DriverFactory = (binding: DataSourceBinding, password: string | null) => SqlDriver;

export interface DatabaseAdapterOptions {
  repository: RepositoryPort;
  workspaces: WorkspaceService;
  config: DatabaseAdapterConfig;
  /** 供测试/扩展注入驱动实现;缺省按 binding.driver 内置构造 */
  driverFactories?: Record<string, DriverFactory>;
}

function error(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): AnalystError {
  return new AnalystError({
    code,
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details: details ?? null,
  });
}

const MAX_DESCRIBE_TABLES = 200;

export class DatabaseAdapter implements DatabasePort {
  readonly #repository: RepositoryPort;
  readonly #workspaces: WorkspaceService;
  readonly #config: DatabaseAdapterConfig;
  readonly #driverFactories: Record<string, DriverFactory>;

  constructor(options: DatabaseAdapterOptions) {
    this.#repository = options.repository;
    this.#workspaces = options.workspaces;
    this.#config = options.config;
    this.#driverFactories = {
      sqlite: (binding) => new SqliteDriver(binding.endpoint),
      postgres: (binding, password) => new PostgresDriver(binding.endpoint, password),
      mysql: (binding, password) => new MySqlDriver(binding.endpoint, password),
      ...options.driverFactories,
    };
  }

  async #binding(sourceId: string): Promise<DataSourceBinding> {
    const binding = await this.#repository.dataSources.get(sourceId);
    if (!binding) {
      throw error('NOT_FOUND', `数据源不存在: ${sourceId}`);
    }
    if (!binding.readonly) {
      throw error('FORBIDDEN', '仅允许只读数据源接入查询');
    }
    return binding;
  }

  #resolvePassword(binding: DataSourceBinding): string | null {
    const [kind, ...rest] = binding.credential_ref.split(':');
    const target = rest.join(':');
    if (kind === 'none') return null;
    if (kind === 'env') {
      const value = process.env[target];
      if (value === undefined || value === '') {
        throw error(
          'ENVIRONMENT_INCOMPLETE',
          `凭据环境变量未设置: ${target}`,
          { credential_ref: binding.credential_ref },
        );
      }
      return value;
    }
    throw error(
      'ENVIRONMENT_INCOMPLETE',
      `暂不支持的凭据类型: ${kind}(支持 env:/none:)`,
      { credential_ref: binding.credential_ref },
    );
  }

  #createDriver(binding: DataSourceBinding): SqlDriver {
    const factory = this.#driverFactories[binding.driver];
    if (!factory) {
      throw error('UNPROCESSABLE', `未知数据源驱动: ${binding.driver}`, {
        driver: binding.driver,
      });
    }
    return factory(binding, this.#resolvePassword(binding));
  }

  async testConnection(sourceId: string): Promise<ConnectionTest> {
    const binding = await this.#binding(sourceId);
    const driver = this.#createDriver(binding);
    try {
      return await driver.testConnection(
        Math.min(10, this.#config.statement_timeout_seconds) * 1000,
      );
    } finally {
      await driver.close();
    }
  }

  async describe(sourceId: string): Promise<CatalogSnapshot> {
    const binding = await this.#binding(sourceId);
    const driver = this.#createDriver(binding);
    try {
      const partial = await driver.describe(MAX_DESCRIBE_TABLES);
      return { source_id: binding.id, ...partial };
    } finally {
      await driver.close();
    }
  }

  async query(input: QueryRequest): Promise<QueryResultRef> {
    const binding = await this.#binding(input.source_id);
    if (binding.workspace_id === null) {
      throw error('UNPROCESSABLE', '数据源未绑定 Workspace,无法物化查询结果', {
        source_id: binding.id,
      });
    }
    const workspaceId = binding.workspace_id;

    if (input.idempotency_key !== null) {
      const existing = await this.#findByIdempotencyKey(binding.id, input.idempotency_key);
      if (existing) return existing;
    }

    // 服务端上限收敛请求参数(§24:上限由配置决定,不信任调用方)
    const statement = assertReadOnlySingleStatement(input.sql);
    const driver = this.#createDriver(binding);
    try {
      const output = await driver.query(statement, input.params, {
        maxRows: Math.min(input.max_rows, this.#config.max_result_rows),
        maxBytes: Math.min(input.max_bytes, this.#config.max_result_bytes),
        timeoutMs: Math.min(input.timeout_seconds, this.#config.statement_timeout_seconds) * 1000,
      });

      const materialized = await this.#workspaces.materializeQueryResult({
        workspace_id: workspaceId,
        dataset_name: `sql-${binding.id.slice(0, 8)}`,
        sql: statement,
        columns: output.columns,
        rows: output.rows,
        truncated: output.truncated,
        source_id: binding.id,
        driver: binding.driver,
        max_rows: Math.min(input.max_rows, this.#config.max_result_rows),
        idempotency_key: input.idempotency_key,
      });

      return {
        data_ref: materialized.dataRef,
        statement,
        truncated: output.truncated,
        rows_fetched: output.rows.length,
        dataset_id: materialized.dataset.id,
        version_id: materialized.version.id,
      };
    } finally {
      await driver.close();
    }
  }

  async #findByIdempotencyKey(
    sourceId: string,
    idempotencyKey: string,
  ): Promise<QueryResultRef | null> {
    const versions = await this.#repository.datasetVersions.list();
    const hit = versions.find((version) => {
      const source = version.manifest['source'] as
        | { source_id?: unknown; idempotency_key?: unknown }
        | undefined;
      return (
        version.state === 'ready' &&
        source !== undefined &&
        source.source_id === sourceId &&
        source.idempotency_key === idempotencyKey
      );
    });
    if (!hit) return null;
    const dataRef = await this.#repository.dataRefs.get(hit.data_ref_id);
    if (!dataRef) return null;
    const statement = (hit.manifest['source'] as { sql?: unknown }).sql;
    return {
      data_ref: dataRef,
      statement: typeof statement === 'string' ? statement : '',
      truncated: dataRef.completeness === 'truncated',
      rows_fetched: dataRef.row_count ?? 0,
      dataset_id: hit.dataset_id,
      version_id: hit.id,
    };
  }
}
