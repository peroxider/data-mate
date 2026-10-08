import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { AnalystError } from '@data-analyst/contracts';
import type { AccessScope, ProductConfig, QualityPort } from '@data-analyst/contracts';
import {
  AggregationService,
  InMemoryRepository,
  ReportService,
  WorkspaceService,
  loadProductConfig,
  resolveConfigDir,
  resolvePaths,
  sha256File,
} from '@data-analyst/core';
import type { AggregationSpec, ResolvedPaths } from '@data-analyst/core';
import { createQualityAdapter } from '@data-analyst/dsh-integration';

// ---------------------------------------------------------------------------
// §17 CLI(M1 子集):workspace、import、analyze、export。
// export 退出语义:导出已完成产物,不自动重新计算;任何缺失/未就绪即非 0。
// 组件冻结目录与 analyst_runtime 沿用仓库根启发式(configDir/..),
// 可用环境变量 DATA_ANALYST_PROFILE_DIR / DATA_ANALYST_RUNTIME_DIR 覆盖。
// ---------------------------------------------------------------------------

interface M1Context {
  config: ProductConfig;
  paths: ResolvedPaths;
  repository: InMemoryRepository;
  workspaces: WorkspaceService;
  pythonBin: string;
  runtimeDir: string | null;
  profileDir: string;
}

async function buildContext(configFile: string): Promise<M1Context> {
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
  const profileDir = process.env.DATA_ANALYST_PROFILE_DIR ?? join(repoRoot, '.m0', 'profile');
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
  return {
    config,
    paths,
    repository,
    workspaces,
    pythonBin,
    runtimeDir,
    profileDir,
  };
}

function m1Limits(context: M1Context): { maxBytes: number; maxRows: number } {
  return {
    maxBytes: context.config.data.quality_ts_max_mib * 1024 * 1024,
    maxRows: context.config.data.quality_ts_max_rows,
  };
}

function scopeFor(context: M1Context, workspaceId: string): AccessScope {
  const limits = m1Limits(context);
  return { workspace_id: workspaceId, max_bytes: limits.maxBytes, max_rows: limits.maxRows };
}

function specError(message: string): AnalystError {
  return new AnalystError({
    code: 'UNPROCESSABLE',
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details: null,
  });
}

function parseSpec(groupBy: string, metrics: string[], ratios: string[]): AggregationSpec {
  if (metrics.length === 0) {
    throw specError('analyze 至少需要一个 --metric');
  }
  const parsedMetrics: AggregationSpec['metrics'] = metrics.map((token) => {
    const parts = token.split(':');
    if (parts.length < 2 || parts.length > 3) {
      throw specError(`--metric 格式应为 name:kind[:column],收到 ${token}`);
    }
    const [name, kind, column] = parts as [string, string, string | undefined];
    if (kind !== 'sum' && kind !== 'count') {
      throw specError(`--metric kind 仅支持 sum|count,收到 ${kind}`);
    }
    return { name, kind, ...(kind === 'sum' ? { column: column ?? name } : {}) };
  });
  const parsedRatios = ratios.map((token) => {
    const match = /^([^:]+):([^/]+)\/([^/]+)$/.exec(token);
    if (!match) {
      throw specError(`--ratio 格式应为 name:numerator/denominator,收到 ${token}`);
    }
    return {
      name: match[1] as string,
      numerator: match[2] as string,
      denominator: match[3] as string,
    };
  });
  return { group_by: groupBy, metrics: parsedMetrics, ratios: parsedRatios };
}

function formatFromExtension(file: string): 'csv' | 'tsv' | 'parquet' | null {
  const ext = extname(file).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.tsv') return 'tsv';
  if (ext === '.parquet') return 'parquet';
  return null;
}

export function registerM1Commands(program: Command): void {
  const workspace = program
    .command('workspace')
    .description('Workspace 生命周期(M1:创建与列表)');

  workspace
    .command('create')
    .description('创建 Workspace')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--name <name>', 'Workspace 名称(1-200 字符)')
    .action(async (options: { config: string; name: string }) => {
      const context = await buildContext(options.config);
      const created = await context.workspaces.createWorkspace(options.name);
      await context.workspaces.persist();
      console.log(JSON.stringify(created, null, 2));
    });

  workspace
    .command('list')
    .description('列出 Workspace')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .action(async (options: { config: string }) => {
      const context = await buildContext(options.config);
      console.log(JSON.stringify(await context.workspaces.listWorkspaces(), null, 2));
    });

  program
    .command('import')
    .description('导入数据文件为受版本管理的数据集(支持 csv/tsv/parquet)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--workspace <id>', 'Workspace UUID')
    .requiredOption('--file <path>', '待导入文件路径')
    .option('--format <format>', 'csv | tsv | parquet(缺省按扩展名推断)')
    .option('--name <name>', '数据集名称(缺省为文件名去扩展名)')
    .action(async (options: {
      config: string;
      workspace: string;
      file: string;
      format?: string;
      name?: string;
    }) => {
      const context = await buildContext(options.config);
      const format = options.format ?? formatFromExtension(options.file);
      if (format !== 'csv' && format !== 'tsv' && format !== 'parquet') {
        throw new AnalystError({
          code: 'UNPROCESSABLE',
          message: '无法推断格式,请用 --format 指定 csv|tsv|parquet',
          request_id: null,
          run_id: null,
          retryable: false,
          details: null,
        });
      }
      const stagedPath = await context.workspaces.stageUpload(options.file);
      const imported = await context.workspaces.importFile({
        workspace_id: options.workspace,
        dataset_name: options.name ?? basename(options.file, extname(options.file)),
        format,
        staged_path: stagedPath,
      });
      await context.workspaces.persist();
      console.log(
        JSON.stringify(
          {
            dataset_id: imported.dataset.id,
            dataset_name: imported.dataset.name,
            version_id: imported.version.id,
            data_ref_id: imported.dataRef.ref_id,
            format,
            row_count: imported.dataRef.row_count,
          },
          null,
          2,
        ),
      );
    });

  program
    .command('analyze')
    .description('M1 闭环:质量 Profiling + 确定性聚合 + 离线 HTML 报告')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--workspace <id>', 'Workspace UUID')
    .requiredOption('--dataset <name>', '数据集名称(取最新版本)')
    .requiredOption('--group-by <column>', '分组列')
    .requiredOption('--metric <token...>', '指标 name:kind[:column](kind 为 sum|count,可重复)')
    .option('--ratio <token...>', '比率 name:numerator/denominator(引用已定义指标,可重复)')
    .option('--no-profile', '跳过质量 Profiling(默认启用;插件缺失时如实报错)')
    .action(async (options: {
      config: string;
      workspace: string;
      dataset: string;
      groupBy: string;
      metric: string[];
      ratio?: string[];
      profile?: boolean;
    }) => {
      const context = await buildContext(options.config);
      const spec = parseSpec(options.groupBy, options.metric, options.ratio ?? []);
      const ref = await context.workspaces.latestDataRef(options.workspace, options.dataset);
      const resolved = await context.workspaces.resolveData(
        ref.ref_id,
        scopeFor(context, options.workspace),
      );

      // 质量报告落盘回调:写入 workspace artifacts,并记录 sha256 供报告 manifest 引用
      const quality: {
        value: { relative_path: string; sha256: string; report: Record<string, unknown> } | null;
      } = { value: null };
      const persistReport = async (workspaceId: string, json: string): Promise<string> => {
        const artifactId = crypto.randomUUID();
        const dir = join(context.paths.workspacesDir, workspaceId, 'artifacts', artifactId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'quality.json'), json, 'utf8');
        const relativePath = `artifacts/${artifactId}/quality.json`;
        quality.value = {
          relative_path: relativePath,
          sha256: await sha256File(join(dir, 'quality.json')),
          report: JSON.parse(json) as Record<string, unknown>,
        };
        return relativePath;
      };

      let qualityPort: QualityPort | null = null;
      if (options.profile !== false) {
        if (!existsSync(context.profileDir)) {
          throw new AnalystError({
            code: 'ENVIRONMENT_INCOMPLETE',
            message: `组件冻结 profile 目录缺失: ${context.profileDir}(可用 DATA_ANALYST_PROFILE_DIR 覆盖或 --no-profile 跳过)`,
            request_id: null,
            run_id: null,
            retryable: false,
            details: null,
          });
        }
        qualityPort = createQualityAdapter({
          profileDir: context.profileDir,
          resolveData: (refId, scope) => context.workspaces.resolveData(refId, scope),
          limits: m1Limits(context),
          persistReport,
        });
      }

      const profileResult = qualityPort
        ? await qualityPort.profile({ data_ref: ref, columns: null, sample: null })
        : null;

      const aggregation = new AggregationService({
        repository: context.repository,
        paths: context.paths,
        ...m1Limits(context),
      });
      const outcome = await aggregation.aggregate({
        workspaceId: options.workspace,
        dataRef: ref,
        absolutePath: resolved.absolute_path,
        spec,
      });
      await context.workspaces.registerArtifact({
        workspace_id: options.workspace,
        run_id: null,
        kind: 'metrics',
        relative_path: outcome.artifact.relative_path,
        sha256: outcome.artifact.sha256,
      });

      const report = new ReportService({ paths: context.paths });
      const reportOutcome = await report.generate({
        workspaceId: options.workspace,
        title: `${options.dataset} 分析报告`,
        aggregation: outcome.output,
        metricsArtifact: {
          relative_path: outcome.artifact.relative_path,
          sha256: outcome.artifact.sha256,
        },
        ...(quality.value
          ? {
              quality: {
                relative_path: quality.value.relative_path,
                sha256: quality.value.sha256,
                report: quality.value.report,
              },
            }
          : {}),
      });
      const reportRef = await context.workspaces.registerArtifact({
        workspace_id: options.workspace,
        run_id: null,
        kind: 'html-report',
        relative_path: reportOutcome.relative_path,
        sha256: reportOutcome.sha256,
      });
      await context.workspaces.persist();

      console.log(
        JSON.stringify(
          {
            data_ref_id: ref.ref_id,
            completeness: profileResult?.completeness ?? 'skipped',
            metrics_artifact: outcome.artifact,
            quality_artifact: quality.value
              ? { relative_path: quality.value.relative_path, sha256: quality.value.sha256 }
              : null,
            report: {
              artifact_id: reportRef.artifact_id,
              relative_path: reportOutcome.relative_path,
              sha256: reportOutcome.sha256,
            },
            overall: outcome.output.overall.values,
            groups: outcome.output.groups,
          },
          null,
          2,
        ),
      );
    });

  program
    .command('export')
    .description('导出已完成 Run 的报告与 manifest(不自动重新计算)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--workspace <id>', 'Workspace UUID(报告所在根)')
    .requiredOption('--report <artifactId|latest>', 'html-report 产物 ID,或 latest 取最新')
    .requiredOption('--output <path>', '输出文件或目录路径')
    .action(async (options: {
      config: string;
      workspace: string;
      report: string;
      output: string;
    }) => {
      const context = await buildContext(options.config);
      const artifacts = await context.repository.artifacts.list();
      const reports = artifacts
        .filter((artifact) => artifact.kind === 'html-report')
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const target =
        options.report === 'latest'
          ? reports[0]
          : reports.find((artifact) => artifact.id === options.report);
      if (!target) {
        throw new AnalystError({
          code: 'NOT_FOUND',
          message: `未找到可导出的 html-report 产物: ${options.report}`,
          request_id: null,
          run_id: null,
          retryable: false,
          details: null,
        });
      }
      if (target.state !== 'ready') {
        throw new AnalystError({
          code: 'UNPROCESSABLE',
          message: `产物状态为 ${target.state},只导出 ready 产物(不自动重新计算)`,
          request_id: null,
          run_id: null,
          retryable: false,
          details: { artifact_id: target.id, state: target.state },
        });
      }

      const sourcePath = join(context.paths.workspacesDir, options.workspace, target.relative_path);
      if (!existsSync(sourcePath)) {
        throw new AnalystError({
          code: 'NOT_FOUND',
          message: `产物文件缺失: ${target.relative_path}`,
          request_id: null,
          run_id: null,
          retryable: false,
          details: { artifact_id: target.id },
        });
      }

      // --output 以 .html 结尾视为目标文件,否则视为目标目录(内为 report.html)
      const outputPath = resolve(options.output);
      const outputFile = outputPath.toLowerCase().endsWith('.html')
        ? outputPath
        : join(outputPath, 'report.html');
      await mkdir(join(outputFile, '..'), { recursive: true });
      await copyFile(sourcePath, outputFile);
      const manifestPath = `${outputFile}.manifest.json`;
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            schema_version: 1,
            producer: 'data-analyst CLI export',
            exported_at: new Date().toISOString(),
            artifact: {
              id: target.id,
              kind: target.kind,
              relative_path: target.relative_path,
              sha256: target.sha256,
              state: target.state,
            },
          },
          null,
          2,
        ),
        'utf8',
      );
      console.log(JSON.stringify({ report: outputFile, manifest: manifestPath }, null, 2));
    });
}
