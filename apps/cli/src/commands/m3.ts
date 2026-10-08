import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { AnalystError } from '@data-analyst/contracts';
import type { ProductConfig, RunTrigger } from '@data-analyst/contracts';
import {
  DataSourceBindingSchema,
  ModelProfileSchema,
} from '@data-analyst/contracts';
import {
  AggregationService,
  InMemoryRepository,
  ReportService,
  RunGovernor,
  WorkspaceService,
  loadProductConfig,
  resolveConfigDir,
  resolvePaths,
} from '@data-analyst/core';
import type { ResolvedPaths } from '@data-analyst/core';
import { DatabaseAdapter } from '@data-analyst/data-adapters';
import { NotebookService } from '@data-analyst/notebook-adapter';

// ---------------------------------------------------------------------------
// §24 M3 CLI:数据源接入(datasource)、只读 SQL 查询(sql-query)、Session/
// 模型配置、运行治理(run:SESSION_BUSY/Kernel 上限/排队/config revision 快照/
// run_events)与 m3-demo 演示链路(SQL→Notebook→报告)。复用 M1/M2 上下文装配。
// ---------------------------------------------------------------------------

interface M3Context {
  config: ProductConfig;
  paths: ResolvedPaths;
  repository: InMemoryRepository;
  workspaces: WorkspaceService;
  database: DatabaseAdapter;
  governor: RunGovernor;
  notebook: NotebookService;
  aggregation: AggregationService;
  report: ReportService;
  runtimeDir: string | null;
  pythonBin: string;
}

async function buildContext(configFile: string): Promise<M3Context> {
  const config = loadProductConfig({ configFile });
  const configDir = resolveConfigDir(configFile);
  const repoRoot = resolve(configDir, '..');
  const paths = resolvePaths(config, configDir);
  const repository = new InMemoryRepository();
  if (existsSync(paths.productStateFile)) {
    await repository.restoreFrom(paths.productStateFile);
  }
  const pythonBin = config.runtime.python === 'auto' ? 'python3' : config.runtime.python;
  const runtimeDirEnv = process.env.DATA_ANALYST_RUNTIME_DIR;
  const runtimeDirCandidate = runtimeDirEnv ?? join(repoRoot, 'python', 'analyst_runtime');
  const runtimeDir = existsSync(runtimeDirCandidate) ? runtimeDirCandidate : null;
  const workspaces = new WorkspaceService({
    repository,
    paths,
    pythonBin,
    runtimeDir,
    limits: {
      maxUploadBytes: config.data.max_upload_mib * 1024 * 1024,
      maxRows: config.data.quality_ts_max_rows,
    },
  });
  const database = new DatabaseAdapter({
    repository,
    workspaces,
    config: {
      statement_timeout_seconds: config.database.statement_timeout_seconds,
      max_result_rows: config.database.max_result_rows,
      max_result_bytes: config.database.max_result_mib * 1024 * 1024,
    },
  });
  const governor = new RunGovernor({
    repository,
    maxActiveKernels: config.runtime.max_active_kernels,
  });
  const notebook = new NotebookService({ repository, paths, pythonBin, runtimeDir });
  const aggregation = new AggregationService({
    repository,
    paths,
    maxBytes: config.data.quality_ts_max_mib * 1024 * 1024,
    maxRows: config.data.quality_ts_max_rows,
  });
  const report = new ReportService({ paths });
  return {
    config,
    paths,
    repository,
    workspaces,
    database,
    governor,
    notebook,
    aggregation,
    report,
    runtimeDir,
    pythonBin,
  };
}

async function persist(context: M3Context): Promise<void> {
  await context.workspaces.persist();
}

const SQL_LIMITS = {
  max_rows: 10_000,
  max_bytes: 8 * 1024 * 1024,
  timeout_seconds: 30,
};

function requireId(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new AnalystError({
      code: 'UNPROCESSABLE',
      message: `${label} 不能为空`,
      request_id: null,
      run_id: null,
      retryable: false,
      details: null,
    });
  }
  return value.trim();
}

export function registerM3Commands(program: Command): void {
  const datasource = program.command('datasource').description('§24 M3 数据源接入与探测');

  datasource
    .command('add')
    .description('登记只读数据源绑定(SQLite 文件 / PostgreSQL / MySQL endpoint)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--workspace <id>', 'Workspace UUID')
    .requiredOption('--driver <driver>', 'sqlite | postgres | mysql')
    .requiredOption('--endpoint <endpoint>', 'SQLite 文件路径或数据库 URL(host:port/db)')
    .option('--credential-ref <ref>', '凭据引用(env:NAME / none:标记)', 'none:local')
    .action(async (options: {
      config: string;
      workspace: string;
      driver: string;
      endpoint: string;
      credentialRef: string;
    }) => {
      if (options.driver !== 'sqlite' && options.driver !== 'postgres' && options.driver !== 'mysql') {
        throw new AnalystError({
          code: 'UNPROCESSABLE',
          message: `--driver 仅支持 sqlite|postgres|mysql,收到 ${options.driver}`,
          request_id: null,
          run_id: null,
          retryable: false,
          details: null,
        });
      }
      const context = await buildContext(options.config);
      const binding = DataSourceBindingSchema.parse({
        id: randomUUID(),
        workspace_id: requireId(options.workspace, '--workspace'),
        driver: options.driver,
        endpoint: options.endpoint,
        credential_ref: options.credentialRef,
        readonly: true,
        created_at: new Date().toISOString(),
      });
      await context.repository.dataSources.put(binding);
      await persist(context);
      console.log(JSON.stringify(binding, null, 2));
    });

  datasource
    .command('list')
    .description('列出已登记数据源')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .action(async (options: { config: string }) => {
      const context = await buildContext(options.config);
      console.log(JSON.stringify(await context.repository.dataSources.list(), null, 2));
    });

  datasource
    .command('test')
    .description('测试数据源连通性')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--source <id>', 'DataSourceBinding UUID')
    .action(async (options: { config: string; source: string }) => {
      const context = await buildContext(options.config);
      console.log(JSON.stringify(await context.database.testConnection(options.source), null, 2));
    });

  datasource
    .command('describe')
    .description('读取数据源目录快照(schema/表/列)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--source <id>', 'DataSourceBinding UUID')
    .action(async (options: { config: string; source: string }) => {
      const context = await buildContext(options.config);
      console.log(JSON.stringify(await context.database.describe(options.source), null, 2));
    });

  program
    .command('sql-query')
    .description('只读 SQL 查询;结果物化为可追溯数据版本')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--source <id>', 'DataSourceBinding UUID')
    .requiredOption('--sql <sql>', '只读单语句 SQL')
    .option('--max-rows <n>', '行数上限(服务端配置收敛)', '10000')
    .option('--timeout-seconds <s>', '超时秒数(服务端配置收敛)', '30')
    .option('--idempotency-key <key>', '幂等键(重试不重复执行)')
    .action(async (options: {
      config: string;
      source: string;
      sql: string;
      maxRows: string;
      timeoutSeconds: string;
      idempotencyKey?: string;
    }) => {
      const context = await buildContext(options.config);
      const result = await context.database.query({
        source_id: requireId(options.source, '--source'),
        sql: options.sql,
        params: [],
        max_rows: Number(options.maxRows),
        max_bytes: SQL_LIMITS.max_bytes,
        timeout_seconds: Number(options.timeoutSeconds),
        idempotency_key: options.idempotencyKey ?? null,
      });
      await persist(context);
      console.log(JSON.stringify(result, null, 2));
    });

  const session = program.command('session').description('§12 Session 绑定');

  session
    .command('create')
    .description('为 Workspace 创建本地 Session')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--workspace <id>', 'Workspace UUID')
    .action(async (options: { config: string; workspace: string }) => {
      const context = await buildContext(options.config);
      const binding = await context.notebook.createSession(
        requireId(options.workspace, '--workspace'),
      );
      await persist(context);
      console.log(JSON.stringify(binding, null, 2));
    });

  const modelProfile = program.command('model-profile').description('模型配置档案');

  modelProfile
    .command('add')
    .description('登记 openai-chat 模型配置(Run 使用启动时 revision 快照)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--base-url <url>', '模型服务 base URL')
    .requiredOption('--model <name>', '模型名称')
    .option('--credential-ref <ref>', '凭据引用(env:NAME / none:标记)', 'none:local')
    .action(async (options: { config: string; baseUrl: string; model: string; credentialRef: string }) => {
      const context = await buildContext(options.config);
      const profile = ModelProfileSchema.parse({
        id: randomUUID(),
        revision: 1,
        protocol: 'openai-chat',
        base_url: options.baseUrl,
        model: options.model,
        credential_ref: options.credentialRef,
        capabilities: {
          streaming: 'optional',
          tool_calling: 'optional',
          vision: 'disabled',
        },
        config_hash: createHash('sha256')
          .update(JSON.stringify({ base_url: options.baseUrl, model: options.model }))
          .digest('hex'),
        created_at: new Date().toISOString(),
      });
      await context.repository.modelProfiles.put(profile);
      await persist(context);
      console.log(JSON.stringify(profile, null, 2));
    });

  const run = program.command('run').description('§13 运行治理(Kernel 上限/排队/取消/日志)');

  run
    .command('begin')
    .description('开始 Run;同 Session 冲突 → SESSION_BUSY,Kernel 满载 → 排队')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--session <id>', 'SessionBinding UUID')
    .option('--trigger <trigger>', 'user_message|manual_cell|replay|system', 'manual_cell')
    .option('--model-profile <id>', 'ModelProfile UUID(可选)')
    .option('--idempotency-key <key>', '幂等键')
    .action(async (options: {
      config: string;
      session: string;
      trigger: string;
      modelProfile?: string;
      idempotencyKey?: string;
    }) => {
      const context = await buildContext(options.config);
      const outcome = await context.governor.beginRun({
        session_id: requireId(options.session, '--session'),
        trigger: options.trigger as RunTrigger,
        model_profile_id: options.modelProfile ?? null,
        idempotency_key: options.idempotencyKey ?? null,
      });
      await persist(context);
      console.log(
        JSON.stringify(
          { run: outcome.run, queued: outcome.queued, busy_with_run_id: outcome.busy_with_run_id },
          null,
          2,
        ),
      );
    });

  run
    .command('finish')
    .description('结束 Run(completed|failed);释放 Kernel 租约并唤醒队列')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--run <id>', 'AnalysisRun UUID')
    .requiredOption('--status <status>', 'completed | failed')
    .action(async (options: { config: string; run: string; status: string }) => {
      if (options.status !== 'completed' && options.status !== 'failed') {
        throw new AnalystError({
          code: 'UNPROCESSABLE',
          message: `--status 仅支持 completed|failed,收到 ${options.status}`,
          request_id: null,
          run_id: null,
          retryable: false,
          details: null,
        });
      }
      const context = await buildContext(options.config);
      const finished = await context.governor.finishRun(
        requireId(options.run, '--run'),
        options.status,
      );
      await persist(context);
      console.log(JSON.stringify(finished, null, 2));
    });

  run
    .command('cancel')
    .description('取消 Run(旧输出不进入新 Run)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--run <id>', 'AnalysisRun UUID')
    .action(async (options: { config: string; run: string }) => {
      const context = await buildContext(options.config);
      const result = await context.governor.cancelRun(requireId(options.run, '--run'));
      await persist(context);
      console.log(JSON.stringify(result, null, 2));
    });

  run
    .command('list')
    .description('列出 Run')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .option('--session <id>', '按 Session 过滤')
    .action(async (options: { config: string; session?: string }) => {
      const context = await buildContext(options.config);
      console.log(JSON.stringify(await context.governor.listRuns(options.session), null, 2));
    });

  run
    .command('events')
    .description('按 Run 查询 run_events 日志关联(FR17)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--run <id>', 'AnalysisRun UUID')
    .action(async (options: { config: string; run: string }) => {
      const context = await buildContext(options.config);
      console.log(JSON.stringify(await context.governor.eventsForRun(options.run), null, 2));
    });

  program
    .command('m3-demo')
    .description('M3 演示链路:SQLite 数据源 → 只读 SQL → Notebook Cell → 聚合报告')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .action(async (options: { config: string }) => {
      const context = await buildContext(options.config);

      // 1) Workspace + 演示 SQLite 库
      const workspace = await context.workspaces.createWorkspace('M3 演示(SQL→Notebook→报告)');
      const demoDir = join(context.paths.workspacesDir, workspace.id, 'demo');
      await mkdir(demoDir, { recursive: true });
      const dbPath = join(demoDir, 'demo_sales.db');
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE demo_sales (id INTEGER PRIMARY KEY, region TEXT NOT NULL, amount REAL NOT NULL)');
      const insert = db.prepare('INSERT INTO demo_sales (region, amount) VALUES (?, ?)');
      const rows: Array<[string, number]> = [
        ['east', 100], ['east', 260], ['east', 40],
        ['west', 200], ['west', 120],
        ['south', 80],
      ];
      for (const [region, amount] of rows) insert.run(region, amount);
      db.close();

      // 2) 数据源 + 只读 SQL 查询(T09/T10 语义在守卫与驱动层强制)
      const binding = DataSourceBindingSchema.parse({
        id: randomUUID(),
        workspace_id: workspace.id,
        driver: 'sqlite',
        endpoint: dbPath,
        credential_ref: 'none:demo',
        readonly: true,
        created_at: new Date().toISOString(),
      });
      await context.repository.dataSources.put(binding);
      const query = await context.database.query({
        source_id: binding.id,
        sql: 'SELECT region, COUNT(*) AS order_count, SUM(amount) AS total_amount FROM demo_sales GROUP BY region ORDER BY region',
        params: [],
        max_rows: SQL_LIMITS.max_rows,
        max_bytes: SQL_LIMITS.max_bytes,
        timeout_seconds: SQL_LIMITS.timeout_seconds,
        idempotency_key: 'm3-demo-baseline',
      });

      // 3) Session + 模型配置 + Run(revision 快照;run_events 关联)
      const sessionBinding = await context.notebook.createSession(workspace.id);
      const profile = ModelProfileSchema.parse({
        id: randomUUID(),
        revision: 1,
        protocol: 'openai-chat',
        base_url: 'http://127.0.0.1:9/v1',
        model: 'offline-demo',
        credential_ref: 'none:demo',
        capabilities: { streaming: 'optional', tool_calling: 'optional', vision: 'disabled' },
        config_hash: createHash('sha256').update('m3-demo').digest('hex'),
        created_at: new Date().toISOString(),
      });
      await context.repository.modelProfiles.put(profile);
      const begin = await context.governor.beginRun({
        session_id: sessionBinding.id,
        trigger: 'manual_cell',
        model_profile_id: profile.id,
        idempotency_key: null,
      });
      const runEntity = begin.run;
      await context.governor.appendEvent({
        run_id: runEntity.id,
        session_id: sessionBinding.id,
        event: 'run.phase',
        message: `M3 演示链路启动(queued=${begin.queued});config_revision=${runEntity.config_revision}`,
      });

      // 4) Notebook Cell:对物化 CSV 用 stdlib csv 复算校验(独立于 SQL 结果)
      const notebookRef = await context.notebook.ensureNotebook(sessionBinding.id);
      const cellId = 'm3-demo-cell';
      const resolved = await context.workspaces.resolveData(query.data_ref.ref_id, {
        workspace_id: workspace.id,
        max_bytes: SQL_LIMITS.max_bytes,
        max_rows: SQL_LIMITS.max_rows,
      });
      const cellSource = [
        'import csv',
        `rows = list(csv.DictReader(open(${JSON.stringify(resolved.absolute_path)}, encoding='utf-8')))`,
        `total = sum(float(r['total_amount']) for r in rows)`,
        `regions = sorted(r['region'] for r in rows)`,
        `print('rows:', len(rows), 'regions:', regions)`,
        `print('grand_total:', total)`,
        `{'regions': regions, 'grand_total': total}`,
      ].join('\n');
      await context.notebook.updateCell({
        notebook_id: notebookRef.id,
        cell_id: cellId,
        expected_revision: 0,
        source: cellSource,
      });
      await context.governor.appendEvent({
        run_id: runEntity.id,
        session_id: sessionBinding.id,
        cell_id: cellId,
        event: 'cell.execute',
        message: `执行演示 Cell(数据版本 ${query.version_id};truncated=${query.truncated})`,
      });
      const executionEvents = [];
      for await (const event of context.notebook.execute({
        notebook_id: notebookRef.id,
        cell_id: cellId,
        run_id: runEntity.id,
        expected_revision: 1,
        timeout_seconds: context.config.runtime.cell_timeout_seconds,
        allow_stdin: false,
        idempotency_key: `m3-demo-cell-${query.version_id}`,
      })) {
        executionEvents.push(event);
      }
      const resultEvent = executionEvents.find((event) => event.type === 'execute_result');
      await context.governor.appendEvent({
        run_id: runEntity.id,
        session_id: sessionBinding.id,
        cell_id: cellId,
        execution_id: executionEvents[0]?.execution_id ?? null,
        event: 'cell.done',
        message: `Cell 输出事件 ${executionEvents.length} 条;末值 ${JSON.stringify(resultEvent?.payload['data'] ?? null).slice(0, 200)}`,
      });
      await context.governor.finishRun(runEntity.id, 'completed');
      await context.governor.appendEvent({
        run_id: runEntity.id,
        session_id: sessionBinding.id,
        event: 'run.finish',
        message: 'Run 完成;Kernel 租约释放(stopped),取消语义下旧输出不进入新 Run',
      });

      // 5) 聚合 + 离线 HTML 报告(数值全部来自确定性聚合产物)
      const resolvedForAggregate = await context.workspaces.resolveData(query.data_ref.ref_id, {
        workspace_id: workspace.id,
        max_bytes: SQL_LIMITS.max_bytes,
        max_rows: SQL_LIMITS.max_rows,
      });
      const aggregate = await context.aggregation.aggregate({
        workspaceId: workspace.id,
        dataRef: query.data_ref,
        absolutePath: resolvedForAggregate.absolute_path,
        spec: {
          group_by: 'region',
          metrics: [
            { name: 'order_count', kind: 'sum', column: 'order_count' },
            { name: 'total_amount', kind: 'sum', column: 'total_amount' },
          ],
          ratios: [{ name: 'avg_amount', numerator: 'total_amount', denominator: 'order_count' }],
        },
        runId: runEntity.id,
      });
      await context.workspaces.registerArtifact({
        workspace_id: workspace.id,
        run_id: runEntity.id,
        kind: 'metrics',
        relative_path: aggregate.artifact.relative_path,
        sha256: aggregate.artifact.sha256,
      });
      const reportOutcome = await context.report.generate({
        workspaceId: workspace.id,
        title: 'M3 演示:SQL 查询 → Notebook 校验 → 聚合报告',
        aggregation: aggregate.output,
        metricsArtifact: aggregate.artifact,
        runId: runEntity.id,
      });
      const reportRef = await context.workspaces.registerArtifact({
        workspace_id: workspace.id,
        run_id: runEntity.id,
        kind: 'html-report',
        relative_path: reportOutcome.relative_path,
        sha256: reportOutcome.sha256,
      });
      await persist(context);

      console.log(
        JSON.stringify(
          {
            workspace_id: workspace.id,
            datasource: { id: binding.id, driver: binding.driver, endpoint: dbPath },
            sql: {
              statement: query.statement,
              rows_fetched: query.rows_fetched,
              truncated: query.truncated,
              data_ref_id: query.data_ref.ref_id,
              dataset_id: query.dataset_id,
              version_id: query.version_id,
              completeness: query.data_ref.completeness,
            },
            session_id: sessionBinding.id,
            run: {
              id: runEntity.id,
              config_revision: runEntity.config_revision,
              model_profile_snapshot_id: runEntity.model_profile_snapshot_id,
              status: 'completed',
            },
            cell: {
              id: cellId,
              backend: 'analyst_runtime run-cell',
              events: executionEvents.length,
              execute_result: resultEvent?.payload['data'] ?? null,
            },
            aggregation: {
              artifact: aggregate.artifact,
              overall: aggregate.output.overall,
            },
            report: { ...reportRef, artifact_id: reportOutcome.artifactId },
          },
          null,
          2,
        ),
      );
    });
}
