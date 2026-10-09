import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  AccessScopeSchema,
  AnalystError,
  ExecutionRecordSchema,
  TrainingResultSchema,
  newId,
  nowIso,
} from '@data-analyst/contracts';
import type {
  AnalysisRun,
  ArtifactKind,
  ChatToolDefinition,
  DataRef,
  MetricEvidence,
  RunPhase,
  RunStreamEventType,
  TrainingResult,
} from '@data-analyst/contracts';
import type { RepositoryPort } from './repository.js';
import type { RunGovernor } from './run-governance.js';
import type { WorkspaceService } from './workspace-service.js';
import type { AggregationOutput, AggregationService, AggregationSpec, MetricValue } from './aggregate.js';
import { readCsvRecords } from './csv-scan.js';
import { sha256File } from './hashing.js';
import { buildModelSample } from './data-samples.js';
import { numbersConsistent, verifyTrainingMetrics } from './evidence.js';

// ---------------------------------------------------------------------------
// §17 Agent 工具接入:产品侧 ToolRegistry + 四个分析工具。
// 边界规则(§13):工具调用先登记 ExecutionRecord(registered→running)再放行副作用;
// 返回统一为 {summary, references, next_capabilities};错误以 AnalystError 抛出,
// 由回路转成 tool-role 消息让模型自恢复。phase 单调不回退(§13)。
// DSH Cordis 注册暂缓:packages/dsh-integration 的 DshToolBridge 消费 descriptors()。
// ---------------------------------------------------------------------------

export const AGENT_TOOL_NAMES = [
  'analyst.inspect_data',
  'analyst.list_artifacts',
  'analyst.commit_results',
  'analyst.verify_metrics',
] as const;

export interface AgentToolLimits {
  /** 单次读取/聚合的字节上限 */
  max_bytes: number;
  /** 行数上限 */
  max_rows: number;
  /** inspect_data 预览构造的行数上限 */
  preview_rows: number;
  /** §18 model_sample_rows */
  model_sample_rows: number;
  /** §18 model_sample_cell_chars */
  model_sample_cell_chars: number;
}

/** 工具执行上下文:由回路按 Run 构造;副作用前必须先 beginExecution。 */
export interface ToolContext {
  run: AnalysisRun;
  session_id: string;
  workspaceId: string;
  repository: RepositoryPort;
  runGovernor: RunGovernor;
  workspace: WorkspaceService;
  aggregation: AggregationService;
  workspacesDir: string;
  limits: AgentToolLimits;
  /** SSE 事件(type 为六类运行事件之一);实现绑定 session/run */
  emit(type: RunStreamEventType, payload: Record<string, unknown>): void;
  /** 登记执行记录并置 running;返回 execution_id */
  beginExecution(toolName: string, argsJson: string): Promise<{ executionId: string }>;
  endExecution(executionId: string, status: 'completed' | 'failed'): Promise<void>;
  /** phase 单调不回退;更新 Run 并发 run.status 事件 */
  setPhase(phase: RunPhase): Promise<void>;
  signal: AbortSignal;
}

export interface ToolResult {
  summary: string;
  references: unknown[];
  next_capabilities: string[];
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema 对象 */
  parameters: Record<string, unknown>;
  phase: RunPhase;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (this.#tools.has(tool.name)) {
      throw new AnalystError({
        code: 'CONFIG_INVALID',
        message: `同名工具重复注册: ${tool.name}`,
        request_id: null,
        run_id: null,
        retryable: false,
        details: null,
      });
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | null {
    return this.#tools.get(name) ?? null;
  }

  list(): AgentTool[] {
    return [...this.#tools.values()];
  }

  descriptors(): ChatToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}

// ------------------------------ 执行上下文实现 -------------------------------

const PHASE_ORDER: RunPhase[] = ['inspect', 'quality', 'compute', 'validate', 'present'];

export interface ToolContextDeps {
  run: AnalysisRun;
  workspaceId: string;
  repository: RepositoryPort;
  runGovernor: RunGovernor;
  workspace: WorkspaceService;
  aggregation: AggregationService;
  workspacesDir: string;
  limits: AgentToolLimits;
  emit(type: RunStreamEventType, payload: Record<string, unknown>): void;
  signal: AbortSignal;
}

export function createToolContext(deps: ToolContextDeps): ToolContext {
  const sessionId = deps.run.session_id;

  const appendToolEvent = async (
    event: string,
    message: string,
    options: { cellId?: string; executionId?: string | null; level?: 'info' | 'warn' | 'error' } = {},
  ): Promise<void> => {
    await deps.runGovernor.appendEvent({
      run_id: deps.run.id,
      session_id: sessionId,
      cell_id: options.cellId ?? null,
      execution_id: options.executionId ?? null,
      level: options.level ?? 'info',
      event,
      message,
    });
  };

  return {
    run: deps.run,
    session_id: sessionId,
    workspaceId: deps.workspaceId,
    repository: deps.repository,
    runGovernor: deps.runGovernor,
    workspace: deps.workspace,
    aggregation: deps.aggregation,
    workspacesDir: deps.workspacesDir,
    limits: deps.limits,
    emit: deps.emit,
    signal: deps.signal,

    async beginExecution(toolName: string, argsJson: string) {
      const record = ExecutionRecordSchema.parse({
        id: newId(),
        run_id: deps.run.id,
        // 合成 cell_id:工具调用不是 Notebook Cell,契约 cell_id 本就是自由字符串
        cell_id: `tool:${toolName}`,
        source_revision: 0,
        source_hash: createHash('sha256').update(argsJson).digest('hex'),
        kernel_epoch: 1,
        lease_token: deps.run.id,
        status: 'registered',
        started_at: nowIso(),
        ended_at: null,
      });
      await deps.repository.executions.put(record);
      await appendToolEvent('execution.registered', `工具 ${toolName} 已登记执行记录`, {
        cellId: record.cell_id,
        executionId: record.id,
      });
      await deps.repository.executions.put({ ...record, status: 'running' });
      await appendToolEvent('execution.started', `工具 ${toolName} 开始执行`, {
        cellId: record.cell_id,
        executionId: record.id,
      });
      return { executionId: record.id };
    },

    async endExecution(executionId: string, status: 'completed' | 'failed') {
      const record = await deps.repository.executions.get(executionId);
      if (!record) return;
      await deps.repository.executions.put({
        ...record,
        status,
        ended_at: record.ended_at ?? nowIso(),
      });
      await appendToolEvent('execution.finished', `工具执行结束:${status}`, {
        cellId: record.cell_id,
        executionId: record.id,
        level: status === 'failed' ? 'warn' : 'info',
      });
    },

    async setPhase(phase: RunPhase) {
      const run = await deps.repository.runs.get(deps.run.id);
      if (!run) return;
      const currentIndex = run.phase ? PHASE_ORDER.indexOf(run.phase) : -1;
      const nextIndex = PHASE_ORDER.indexOf(phase);
      if (nextIndex <= currentIndex) return; // 单调不回退
      const updated = { ...run, phase };
      await deps.repository.runs.put(updated);
      deps.run = updated;
      await appendToolEvent('run.phase', `Run phase 前进至 ${phase}`);
      deps.emit('run.status', { status: updated.status, phase });
    },
  };
}

// ------------------------------ 工具公共辅助 ---------------------------------

function err(
  code: AnalystError['payload']['code'],
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

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (cause) {
    throw err('UNPROCESSABLE', '工具入参不符合模式', {
      issues: (cause as { issues?: unknown[] }).issues?.slice(0, 5) ?? null,
    });
  }
}

function artifactPath(ctx: ToolContext, relativePath: string): string {
  const root = resolve(join(ctx.workspacesDir, ctx.workspaceId));
  const absolutePath = resolve(root, relativePath);
  const rel = relative(root, absolutePath);
  if (isAbsolute(rel) || rel.startsWith('..')) {
    throw err('FORBIDDEN', '产物路径越出 Workspace 根目录');
  }
  return absolutePath;
}

// ------------------------------ analyst.inspect_data ------------------------

const InspectInputSchema = z
  .object({
    data_ref_id: z.string().min(1).optional(),
    dataset: z.string().min(1).optional(),
  })
  .refine((input) => input.data_ref_id !== undefined || input.dataset !== undefined, {
    message: 'data_ref_id 与 dataset 至少提供一个',
  });

const inspectDataTool: AgentTool = {
  name: 'analyst.inspect_data',
  description:
    '查看一个数据版本的列结构、行列规模与受限预览样本(敏感列值被屏蔽,只读,无副作用)。',
  parameters: {
    type: 'object',
    properties: {
      data_ref_id: { type: 'string', description: 'DataRef ID;与 dataset 二选一' },
      dataset: { type: 'string', description: '数据集名称(取最新版本);与 data_ref_id 二选一' },
    },
    required: [],
  },
  phase: 'inspect',

  async execute(rawInput, ctx) {
    const input = parseInput(InspectInputSchema, rawInput);
    const ref = await resolveDataRef(ctx, input);
    const scope = AccessScopeSchema.parse({
      workspace_id: ctx.workspaceId,
      max_bytes: ctx.limits.max_bytes,
      max_rows: ctx.limits.max_rows,
    });
    const resolved = await ctx.workspace.resolveData(ref.ref_id, scope);
    const delimiter = ref.format === 'tsv' ? '\t' : ',';
    const { header, records } = await readCsvRecords(resolved.absolute_path, {
      delimiter,
      maxBytes: ctx.limits.max_bytes,
      maxRows: ctx.limits.max_rows,
    });

    const preview = records
      .slice(0, ctx.limits.preview_rows)
      .map((record) => Object.fromEntries(header.map((name, index) => [name, record[index]])));
    const sample = buildModelSample(header, preview, {
      maxRows: ctx.limits.model_sample_rows,
      maxCellChars: ctx.limits.model_sample_cell_chars,
    });

    const totalRows = ref.row_count ?? records.length;
    const maskedNote =
      sample.maskedColumns.length > 0
        ? `敏感列已屏蔽: ${sample.maskedColumns.join(', ')}`
        : '无敏感列屏蔽';
    const summary = [
      `数据 ${ref.ref_id}(格式 ${ref.format}):约 ${totalRows} 行 × ${header.length} 列。`,
      `列: ${header.join(', ')}`,
      maskedNote,
      sample.truncated ? `预览截断,仅含前 ${sample.rows.length} 行。` : '预览未截断。',
    ].join('\n');

    return {
      summary,
      references: [{ data_ref_id: ref.ref_id, version_id: ref.dataset_version_id, sha256: ref.sha256 }],
      next_capabilities: ['analyst.list_artifacts', 'analyst.commit_results', 'analyst.verify_metrics'],
    };
  },
};

async function resolveDataRef(ctx: ToolContext, input: { data_ref_id?: string; dataset?: string }): Promise<DataRef> {
  if (input.data_ref_id) {
    const ref = await ctx.repository.dataRefs.get(input.data_ref_id);
    if (!ref || ref.workspace_id !== ctx.workspaceId) {
      throw err('NOT_FOUND', `DataRef 不存在或不属于当前 Workspace: ${input.data_ref_id}`);
    }
    return ref;
  }
  return ctx.workspace.latestDataRef(ctx.workspaceId, input.dataset as string);
}

// ------------------------------ analyst.list_artifacts ----------------------

const ListArtifactsInputSchema = z.object({
  kind: z
    .enum(['notebook', 'table', 'metrics', 'figure', 'html-report', 'quality-report', 'ml-model'])
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const listArtifactsTool: AgentTool = {
  name: 'analyst.list_artifacts',
  description: '列出当前 Workspace 已登记的分析产物(类型/路径/哈希),供引用与下载。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['notebook', 'table', 'metrics', 'figure', 'html-report', 'quality-report', 'ml-model'],
        description: '按产物类型过滤(可选)',
      },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数上限,默认 20' },
    },
    required: [],
  },
  phase: 'present',

  async execute(rawInput, ctx) {
    const input = parseInput(ListArtifactsInputSchema, rawInput);
    const artifacts = await ctx.workspace.listArtifacts(ctx.workspaceId, {
      kind: input.kind as ArtifactKind | undefined,
    });
    const limit = input.limit ?? 20;
    const selected = artifacts.slice(-limit); // 最近的产物优先
    const summary =
      selected.length === 0
        ? '当前 Workspace 没有匹配的产物。'
        : `共 ${artifacts.length} 个匹配产物,返回最近 ${selected.length} 个:\n` +
          selected
            .map(
              (artifact) =>
                `${artifact.kind} ${artifact.relative_path} sha256=${artifact.sha256.slice(0, 12)}…`,
            )
            .join('\n');
    return {
      summary,
      references: selected.map((artifact) => ({
        artifact_id: artifact.id,
        kind: artifact.kind,
        relative_path: artifact.relative_path,
        sha256: artifact.sha256,
        state: artifact.state,
      })),
      next_capabilities: ['analyst.commit_results', 'analyst.verify_metrics'],
    };
  },
};

// ------------------------------ analyst.commit_results ----------------------

const CommitResultsInputSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['notebook', 'table', 'metrics', 'figure', 'html-report', 'quality-report', 'ml-model']),
  sha256: z.string().length(64).optional(),
});

const commitResultsTool: AgentTool = {
  name: 'analyst.commit_results',
  description:
    '把 Workspace 内已存在且通过完整性校验的文件登记为正式产物(只登记,不生成文件;哈希不符或路径越界将被拒绝)。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace 内相对路径' },
      kind: {
        type: 'string',
        enum: ['notebook', 'table', 'metrics', 'figure', 'html-report', 'quality-report', 'ml-model'],
      },
      sha256: { type: 'string', description: '文件 SHA-256;缺省时由服务端计算' },
    },
    required: ['path', 'kind'],
  },
  phase: 'present',

  async execute(rawInput, ctx) {
    const input = parseInput(CommitResultsInputSchema, rawInput);
    const absolutePath = artifactPath(ctx, input.path);
    const sha256 = input.sha256 ?? (await sha256File(absolutePath).catch(() => {
      throw err('NOT_FOUND', `产物文件不存在: ${input.path}`);
    }));
    const artifact = await ctx.workspace.registerArtifact({
      workspace_id: ctx.workspaceId,
      run_id: ctx.run.id,
      kind: input.kind as ArtifactKind,
      relative_path: input.path,
      sha256,
    });
    ctx.emit('artifact.ready', {
      artifact_id: artifact.artifact_id,
      kind: artifact.kind,
      relative_path: artifact.relative_path,
      sha256: artifact.sha256,
    });
    return {
      summary: `产物已登记:${artifact.kind} ${artifact.relative_path}(sha256=${artifact.sha256})。`,
      references: [artifact],
      next_capabilities: ['analyst.list_artifacts', 'analyst.verify_metrics'],
    };
  },
};

// ------------------------------ analyst.verify_metrics ----------------------

const VerifyMetricsInputSchema = z.object({
  run_id: z.string().min(1).optional(),
});

const LOCATOR_RE = /^artifacts\/([^/]+)\/(metrics|model|stats)\.json#(.+)$/;

const verifyMetricsTool: AgentTool = {
  name: 'analyst.verify_metrics',
  description:
    '对一个 Run 报告的关键指标做独立重算核对(默认当前 Run):从当前数据重算聚合值、用预测文件重算训练指标;数据变更则相关证据标 stale。',
  parameters: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: '目标 Run ID;缺省为当前 Run' },
    },
    required: [],
  },
  phase: 'validate',

  async execute(rawInput, ctx) {
    const input = parseInput(VerifyMetricsInputSchema, rawInput);
    const runId = input.run_id ?? ctx.run.id;
    if (input.run_id) {
      const run = await ctx.repository.runs.get(runId);
      if (!run || run.session_id !== ctx.session_id) {
        throw err('NOT_FOUND', `Run 不存在或不属于当前 Session: ${runId}`);
      }
    }

    const all = await ctx.repository.metricEvidence.list();
    const evidences = all
      .filter((item) => item.run_id === runId)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
      .slice(0, 200);
    if (evidences.length === 0) {
      return {
        summary: `Run ${runId} 没有已登记的指标证据,无内容可核对。`,
        references: [],
        next_capabilities: ['analyst.commit_results', 'analyst.list_artifacts'],
      };
    }

    // 每个数据版本先做哈希复核:数据变更 → 该版本全部证据 stale(T14)
    const staleRefs = new Set<string>();
    const scope = AccessScopeSchema.parse({
      workspace_id: ctx.workspaceId,
      max_bytes: ctx.limits.max_bytes,
      max_rows: ctx.limits.max_rows,
    });
    const refIds = [...new Set(evidences.map((item) => item.data_ref_id))];
    for (const refId of refIds) {
      const ref = await ctx.repository.dataRefs.get(refId);
      if (!ref) continue;
      try {
        await ctx.workspace.resolveData(refId, scope);
      } catch {
        staleRefs.add(refId);
      }
    }
    for (const item of evidences) {
      if (staleRefs.has(item.data_ref_id) && item.verification !== 'stale') {
        await ctx.repository.metricEvidence.put({ ...item, verification: 'stale' });
        item.verification = 'stale';
      }
    }

    let consistent = 0;
    let mismatch = 0;
    let unverifiable = 0;
    for (const item of evidences) {
      if (item.verification === 'stale') {
        unverifiable += 1;
        continue;
      }
      const parsed = LOCATOR_RE.exec(item.locator);
      if (!parsed) {
        unverifiable += 1;
        continue;
      }
      const [, artifactId, file, pointer] = parsed as unknown as [string, string, string, string];
      try {
        const status = await verifyLocator(ctx, artifactId, file, pointer, item);
        if (status !== null) {
          await ctx.repository.metricEvidence.put({ ...item, verification: status });
          item.verification = status;
        }
      } catch {
        unverifiable += 1;
        continue;
      }
      if (item.verification === 'consistent') consistent += 1;
      else if (item.verification === 'mismatch') mismatch += 1;
      else unverifiable += 1;
    }

    const summary =
      `核对完成:${consistent} 项一致,${mismatch} 项不一致,${unverifiable} 项无法独立重算。` +
      (staleRefs.size > 0 ? `另有 ${staleRefs.size} 个数据版本已变更,相关证据标为 stale。` : '');
    return {
      summary,
      references: evidences.map((item) => ({
        evidence_id: item.id,
        locator: item.locator,
        verification: item.verification,
      })),
      next_capabilities: ['analyst.commit_results', 'analyst.list_artifacts'],
    };
  },
};

/** 对单条证据按产物类型重算;返回新的 verification,或 null 表示保持不变。 */
async function verifyLocator(
  ctx: ToolContext,
  artifactId: string,
  file: string,
  pointer: string,
  evidence: MetricEvidence,
): Promise<MetricEvidence['verification'] | null> {
  const ref = await ctx.repository.dataRefs.get(evidence.data_ref_id);
  if (!ref) return null;

  if (file === 'metrics' && pointer.startsWith('overall.values.')) {
    const metricName = pointer.slice('overall.values.'.length);
    const output = await readArtifactJson<AggregationOutput>(
      ctx,
      join('artifacts', artifactId, 'metrics.json'),
    );
    const recomputed = await recomputeAggregationOverall(ctx, output, metricName, ref);
    if (recomputed === undefined) return null;
    const reported = output.overall.values[metricName] ?? null;
    return numbersConsistent(reported, recomputed) ? 'consistent' : 'mismatch';
  }

  if (file === 'model' && pointer.startsWith('metrics.')) {
    const metricName = pointer.slice('metrics.'.length);
    const training = await readArtifactJson<TrainingResult>(
      ctx,
      join('artifacts', artifactId, 'model.json'),
    );
    if (!TrainingResultSchema.safeParse(training).success) return null;
    const predictions = await findPredictionsArtifact(ctx, evidence.run_id);
    if (!predictions) return null;
    const checks = verifyTrainingMetrics(training, predictions);
    const check = checks.find((item) => item.name === metricName);
    if (!check) return null;
    return check.status === 'consistent' ? 'consistent' : check.status === 'mismatch' ? 'mismatch' : null;
  }

  // stats.json 的 Welch 重算需要分组/取值列名,产物未记录列名 → 无法独立重算,保持原状
  return null;
}

async function readArtifactJson<T>(ctx: ToolContext, relativePath: string): Promise<T> {
  const text = await readFile(artifactPath(ctx, relativePath), 'utf8');
  return JSON.parse(text) as T;
}

async function findPredictionsArtifact(
  ctx: ToolContext,
  runId: string | null,
): Promise<{ actual: unknown[]; predicted: unknown[] } | null> {
  if (runId === null) return null;
  const artifacts = await ctx.workspace.listArtifacts(ctx.workspaceId, { run_id: runId });
  const predictionArtifact = [...artifacts]
    .reverse()
    .find((artifact) => artifact.relative_path.endsWith('/predictions.json'));
  if (!predictionArtifact) return null;
  try {
    const payload = await readArtifactJson<Record<string, unknown>>(
      ctx,
      predictionArtifact.relative_path,
    );
    if (!Array.isArray(payload.actual) || !Array.isArray(payload.predicted)) return null;
    return { actual: payload.actual, predicted: payload.predicted };
  } catch {
    return null;
  }
}

/** 用当前数据重算聚合产物 overall 的单个指标;指标名未知 → undefined。语义与 AggregationService 一致。 */
async function recomputeAggregationOverall(
  ctx: ToolContext,
  output: AggregationOutput,
  metricName: string,
  ref: DataRef,
): Promise<MetricValue | undefined> {
  const spec = output.spec;
  const scope = AccessScopeSchema.parse({
    workspace_id: ctx.workspaceId,
    max_bytes: ctx.limits.max_bytes,
    max_rows: ctx.limits.max_rows,
  });
  const resolved = await ctx.workspace.resolveData(ref.ref_id, scope);
  const { header, records } = await readCsvRecords(resolved.absolute_path, {
    delimiter: ref.format === 'tsv' ? '\t' : ',',
    maxBytes: ctx.limits.max_bytes,
    maxRows: ctx.limits.max_rows,
  });
  const columnIndex = new Map(header.map((name, index) => [name, index]));

  const sumOf = (column: string): MetricValue => {
    const index = columnIndex.get(column);
    if (index === undefined) throw err('UNPROCESSABLE', `聚合列 ${column} 不存在`);
    let sum = 0;
    let counted = 0;
    for (const record of records) {
      const cell = record[index];
      if (cell === undefined || cell === '') continue; // 缺失不计入该指标
      const value = Number(cell);
      if (!NUMBER_RE.test(cell) || !Number.isFinite(value)) {
        throw err('UNPROCESSABLE', `列 ${column} 出现非数值内容,无法重算`);
      }
      sum += value;
      counted++;
    }
    return counted === 0 ? null : sum;
  };

  const metric = spec.metrics.find((item) => item.name === metricName);
  if (metric) {
    return metric.kind === 'count' ? records.length : sumOf(metric.column as string);
  }
  const ratio = spec.ratios.find((item) => item.name === metricName);
  if (ratio) {
    const numerator = metricValueOf(spec, ratio.numerator, sumOf, records.length);
    const denominator = metricValueOf(spec, ratio.denominator, sumOf, records.length);
    if (numerator === null || denominator === null || denominator === 0) return null;
    return numerator / denominator;
  }
  if (metricName.endsWith('_percent')) {
    const base = spec.ratios.find((item) => `${item.name}_percent` === metricName);
    if (!base) return undefined;
    const value = await recomputeAggregationOverall(ctx, output, base.name, ref);
    if (value === undefined) return undefined;
    return value === null ? null : Number((value * 100).toFixed(6));
  }
  return undefined;
}

function metricValueOf(
  spec: AggregationSpec,
  name: string,
  sumOf: (column: string) => MetricValue,
  rowCount: number,
): MetricValue {
  const metric = spec.metrics.find((item) => item.name === name);
  if (metric) return metric.kind === 'count' ? rowCount : sumOf(metric.column as string);
  return null;
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// ------------------------------ 注册 ----------------------------------------

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [inspectDataTool, listArtifactsTool, commitResultsTool, verifyMetricsTool]) {
    registry.register(tool);
  }
  return registry;
}
