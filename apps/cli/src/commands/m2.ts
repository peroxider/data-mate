import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { AnalystError } from '@data-analyst/contracts';
import type { AccessScope, ProductConfig } from '@data-analyst/contracts';
import {
  AnalysisService,
  InMemoryRepository,
  TrainReportService,
  WorkspaceService,
  loadProductConfig,
  renderCoefficientSvg,
  resolveConfigDir,
  resolvePaths,
  sha256File,
} from '@data-analyst/core';
import type { ResolvedPaths } from '@data-analyst/core';

// ---------------------------------------------------------------------------
// §17 CLI(M2 子集):stats-compare、train-model、evidence list/refresh。
// 复用 M1 的 workspace/import/analyze 基础设施;统计与训练经 Python sidecar
// 执行,关键指标由产品侧确定性代码独立重算(§13)并登记 MetricEvidence;
// evidence refresh 落实 T14(数据哈希变化 → 相关证据 stale)。
// ---------------------------------------------------------------------------

interface M2Context {
  config: ProductConfig;
  paths: ResolvedPaths;
  repository: InMemoryRepository;
  workspaces: WorkspaceService;
  analysis: AnalysisService;
}

async function buildContext(configFile: string): Promise<M2Context> {
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
  const analysis = new AnalysisService({
    repository,
    paths,
    pythonBin,
    runtimeDir,
    maxBytes: config.data.quality_ts_max_mib * 1024 * 1024,
    maxRows: config.data.quality_ts_max_rows,
  });
  return { config, paths, repository, workspaces, analysis };
}

function scopeFor(context: M2Context, workspaceId: string): AccessScope {
  return {
    workspace_id: workspaceId,
    max_bytes: context.config.data.quality_ts_max_mib * 1024 * 1024,
    max_rows: context.config.data.quality_ts_max_rows,
  };
}

async function resolveLatest(
  context: M2Context,
  workspaceId: string,
  datasetName: string,
): Promise<{ refId: string; absolutePath: string; format: string }> {
  const ref = await context.workspaces.latestDataRef(workspaceId, datasetName);
  const resolved = await context.workspaces.resolveData(ref.ref_id, scopeFor(context, workspaceId));
  return { refId: ref.ref_id, absolutePath: resolved.absolute_path, format: ref.format };
}

async function writeFigureArtifact(
  context: M2Context,
  workspaceId: string,
  svg: string | null,
): Promise<{ relative_path: string; sha256: string; artifact_id: string } | null> {
  if (svg === null) return null;
  const artifactId = crypto.randomUUID();
  const dir = join(context.paths.workspacesDir, workspaceId, 'artifacts', artifactId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'figure.svg');
  await writeFile(file, svg, 'utf8');
  return {
    relative_path: `artifacts/${artifactId}/figure.svg`,
    sha256: await sha256File(file),
    artifact_id: artifactId,
  };
}

function parseFeatures(features: string): string[] {
  const list = features
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (list.length === 0) {
    throw new AnalystError({
      code: 'UNPROCESSABLE',
      message: '--features 至少需要一列(逗号分隔)',
      request_id: null,
      run_id: null,
      retryable: false,
      details: null,
    });
  }
  return list;
}

function requireNumber(
  value: string,
  message: string,
  validate: (parsed: number) => boolean,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !validate(parsed)) {
    throw new AnalystError({
      code: 'UNPROCESSABLE',
      message: `${message},收到 ${value}`,
      request_id: null,
      run_id: null,
      retryable: false,
      details: null,
    });
  }
  return parsed;
}

export function registerM2Commands(program: Command): void {
  program
    .command('stats-compare')
    .description('两独立样本 Welch t 检验(scipy sidecar + 产品侧独立重算校验)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--workspace <id>', 'Workspace UUID')
    .requiredOption('--dataset <name>', '数据集名称(取最新版本)')
    .requiredOption('--group-col <column>', '分组列(恰好 2 个组)')
    .requiredOption('--value-col <column>', '数值列')
    .option('--alpha <alpha>', '显著性水平(默认 0.05)', '0.05')
    .action(async (options: {
      config: string;
      workspace: string;
      dataset: string;
      groupCol: string;
      valueCol: string;
      alpha: string;
    }) => {
      const context = await buildContext(options.config);
      const target = await resolveLatest(context, options.workspace, options.dataset);
      const ref = await context.workspaces.latestDataRef(options.workspace, options.dataset);
      const alpha = requireNumber(options.alpha, '--alpha 必须在 (0,1) 区间', (parsed) => parsed > 0 && parsed < 1);
      const outcome = await context.analysis.compareGroups({
        workspaceId: options.workspace,
        dataRef: ref,
        absolutePath: target.absolutePath,
        groupCol: options.groupCol,
        valueCol: options.valueCol,
        alpha,
      });
      if (outcome.status === 'unsupported') {
        await context.workspaces.persist();
        console.log(
          JSON.stringify({ status: 'unsupported', reason: outcome.unsupported_reason }, null, 2),
        );
        return;
      }
      const statsRef = await context.workspaces.registerArtifact({
        workspace_id: options.workspace,
        run_id: null,
        kind: 'metrics',
        relative_path: outcome.artifacts.stats!.relative_path,
        sha256: outcome.artifacts.stats!.sha256,
      });
      await context.workspaces.persist();
      console.log(
        JSON.stringify(
          {
            status: 'completed',
            data_ref_id: ref.ref_id,
            method: outcome.stats?.method,
            n_used: outcome.stats?.n_used,
            statistics: outcome.stats?.statistics,
            checks: outcome.checks,
            artifacts: { stats: statsRef },
            evidence: outcome.evidence.map((item) => ({
              locator: item.locator,
              verification: item.verification,
            })),
          },
          null,
          2,
        ),
      );
    });

  program
    .command('train-model')
    .description('表格分类/回归训练(numpy 确定性 sidecar + 指标重算 + 解释图)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--workspace <id>', 'Workspace UUID')
    .requiredOption('--dataset <name>', '数据集名称(取最新版本)')
    .requiredOption('--task <task>', 'classification | regression')
    .requiredOption('--target <column>', '目标列')
    .requiredOption('--features <columns>', '特征列(逗号分隔)')
    .option('--split-seed <seed>', '切分随机种子(默认 42)', '42')
    .option('--test-ratio <ratio>', '测试集占比(默认 0.25)', '0.25')
    .action(async (options: {
      config: string;
      workspace: string;
      dataset: string;
      task: string;
      target: string;
      features: string;
      splitSeed: string;
      testRatio: string;
    }) => {
      if (options.task !== 'classification' && options.task !== 'regression') {
        throw new AnalystError({
          code: 'UNPROCESSABLE',
          message: `--task 仅支持 classification|regression,收到 ${options.task}`,
          request_id: null,
          run_id: null,
          retryable: false,
          details: null,
        });
      }
      const features = parseFeatures(options.features);
      const splitSeed = requireNumber(
        options.splitSeed,
        '--split-seed 必须是非负整数',
        (parsed) => Number.isInteger(parsed) && parsed >= 0,
      );
      const testRatio = requireNumber(
        options.testRatio,
        '--test-ratio 需在 [0.05,0.5) 区间',
        (parsed) => parsed >= 0.05 && parsed < 0.5,
      );
      const context = await buildContext(options.config);
      const target = await resolveLatest(context, options.workspace, options.dataset);
      const ref = await context.workspaces.latestDataRef(options.workspace, options.dataset);
      const outcome = await context.analysis.trainModel({
        workspaceId: options.workspace,
        dataRef: ref,
        absolutePath: target.absolutePath,
        task: options.task,
        target: options.target,
        features,
        splitSeed,
        testRatio,
      });
      if (outcome.status === 'unsupported') {
        await context.workspaces.persist();
        console.log(
          JSON.stringify({ status: 'unsupported', reason: outcome.unsupported_reason }, null, 2),
        );
        return;
      }
      const modelRef = await context.workspaces.registerArtifact({
        workspace_id: options.workspace,
        run_id: null,
        kind: 'ml-model',
        relative_path: outcome.artifacts.model!.relative_path,
        sha256: outcome.artifacts.model!.sha256,
      });
      const predictionsRef = await context.workspaces.registerArtifact({
        workspace_id: options.workspace,
        run_id: null,
        kind: 'metrics',
        relative_path: outcome.artifacts.predictions!.relative_path,
        sha256: outcome.artifacts.predictions!.sha256,
      });
      const figure = await writeFigureArtifact(
        context,
        options.workspace,
        renderCoefficientSvg(outcome.training!),
      );
      const figureRef = figure
        ? await context.workspaces.registerArtifact({
            workspace_id: options.workspace,
            run_id: null,
            kind: 'figure',
            relative_path: figure.relative_path,
            sha256: figure.sha256,
          })
        : null;
      const report = new TrainReportService({ paths: context.paths });
      const reportOutcome = await report.generate({
        workspaceId: options.workspace,
        title: `${options.dataset} 训练报告(${options.task})`,
        training: outcome.training!,
        checks: outcome.checks,
        evidence: outcome.evidence.map((item) => ({
          locator: item.locator,
          verification: item.verification,
        })),
        inputs: [
          { kind: 'ml-model', relative_path: modelRef.relative_path, sha256: modelRef.sha256 },
          {
            kind: 'metrics',
            relative_path: predictionsRef.relative_path,
            sha256: predictionsRef.sha256,
          },
          ...(figureRef
            ? [{ kind: 'figure', relative_path: figureRef.relative_path, sha256: figureRef.sha256 }]
            : []),
        ],
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
            status: 'completed',
            data_ref_id: ref.ref_id,
            task: outcome.training?.task,
            n_train: outcome.training?.n_train,
            n_test: outcome.training?.n_test,
            split: {
              seed: outcome.training?.split.split_seed,
              test_ratio: outcome.training?.split.test_ratio,
              leakage_excluded: outcome.training?.split.leakage.excluded_fields,
            },
            metrics: outcome.training?.metrics,
            baseline: outcome.training?.baseline,
            confusion_matrix: outcome.training?.confusion_matrix,
            checks: outcome.checks,
            artifacts: {
              model: modelRef,
              predictions: predictionsRef,
              figure: figureRef,
              report: reportRef,
            },
            evidence: outcome.evidence.map((item) => ({
              locator: item.locator,
              verification: item.verification,
            })),
          },
          null,
          2,
        ),
      );
    });

  const evidence = program.command('evidence').description('MetricEvidence 查询与状态刷新(T14)');

  evidence
    .command('list')
    .description('列出登记的指标证据(可按 workspace/verification 过滤)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .option('--workspace <id>', '仅列出属于该 Workspace 数据的证据(可选)')
    .option('--verification <status>', 'unverified|consistent|mismatch|stale(可选)')
    .action(async (options: { config: string; workspace?: string; verification?: string }) => {
      const context = await buildContext(options.config);
      let items = await context.repository.metricEvidence.list();
      if (options.workspace) {
        const refs = new Set(
          (await context.repository.dataRefs.list())
            .filter((ref) => ref.workspace_id === options.workspace)
            .map((ref) => ref.ref_id),
        );
        items = items.filter((item) => refs.has(item.data_ref_id));
      }
      if (options.verification) {
        items = items.filter((item) => item.verification === options.verification);
      }
      items.sort((a, b) => a.created_at.localeCompare(b.created_at));
      console.log(JSON.stringify(items, null, 2));
    });

  evidence
    .command('refresh')
    .description('复核数据文件哈希;与登记时不一致 → 相关证据全部 stale(T14)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--workspace <id>', 'Workspace UUID')
    .requiredOption('--dataset <name>', '数据集名称(取最新版本)')
    .action(async (options: { config: string; workspace: string; dataset: string }) => {
      const context = await buildContext(options.config);
      const ref = await context.workspaces.latestDataRef(options.workspace, options.dataset);
      // 不走 resolveData(哈希不一致会直接抛错);按 manifest 定位当前文件
      const version = await context.repository.datasetVersions.get(ref.dataset_version_id as string);
      if (!version) {
        throw new AnalystError({
          code: 'NOT_FOUND',
          message: `数据版本不存在: ${String(ref.dataset_version_id)}`,
          request_id: null,
          run_id: null,
          retryable: false,
          details: null,
        });
      }
      const manifest = version.manifest as { data_file: string };
      const absolutePath = join(
        context.paths.workspacesDir,
        options.workspace,
        'datasets',
        version.dataset_id,
        'versions',
        version.id,
        manifest.data_file,
      );
      const result = await context.analysis.refreshEvidenceStatus({
        dataRef: ref,
        absolutePath,
      });
      await context.workspaces.persist();
      console.log(
        JSON.stringify(
          {
            data_ref_id: ref.ref_id,
            stale_count: result.staleCount,
            message:
              result.staleCount > 0
                ? '数据哈希与登记时不一致,相关证据已全部标记 stale'
                : '数据哈希一致,证据状态不变',
          },
          null,
          2,
        ),
      );
    });
}
