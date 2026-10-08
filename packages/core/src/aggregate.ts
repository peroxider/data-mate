import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AnalystError, newId, nowIso } from '@data-analyst/contracts';
import type { DataRef, MetricEvidence } from '@data-analyst/contracts';
import type { RepositoryPort } from './repository.js';
import type { ResolvedPaths } from './paths.js';
import { readCsvRecords } from './csv-scan.js';
import { sha256File } from './hashing.js';

// ---------------------------------------------------------------------------
// §13 关键结论必须来自确定性计算:聚合(sum/count/比率)在产品代码中执行,
// 指标文件落盘为 metrics 产物并登记 MetricEvidence。
// 语义(§25 固定数值验收):总转化率 = 总成交/总访客,绝不平均各渠道比率;
// 零分母 → null(不可计算,不得伪造 0);缺失单元格 → 该行不计入该指标;
// sum 列出现负值 → 数据质量违规错误。
// ---------------------------------------------------------------------------

export interface AggregationSpec {
  group_by: string;
  metrics: Array<{
    name: string;
    kind: 'sum' | 'count';
    /** sum 必填 */
    column?: string;
  }>;
  /** 比率:分子/分母引用上方已定义的指标名 */
  ratios: Array<{ name: string; numerator: string; denominator: string }>;
}

export type MetricValue = number | null;

export interface AggregationOutput {
  schema_version: 1;
  dataset_version_id: string;
  data_ref_id: string;
  spec: AggregationSpec;
  groups: Array<{ key: string; values: Record<string, MetricValue> }>;
  overall: { values: Record<string, MetricValue> };
  generated_at: string;
}

export interface AggregateRequest {
  workspaceId: string;
  dataRef: DataRef;
  /** 已由 WorkspaceService.resolveData 校验哈希后的绝对路径 */
  absolutePath: string;
  spec: AggregationSpec;
  runId?: string | null;
}

export interface AggregateOutcome {
  artifact: {
    relative_path: string;
    sha256: string;
    artifactId: string;
  };
  output: AggregationOutput;
  evidence: MetricEvidence[];
}

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

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function parseMetricCell(cell: string, column: string, row: number): number {
  const value = Number(cell);
  if (!NUMBER_RE.test(cell) || !Number.isFinite(value)) {
    throw err('UNPROCESSABLE', `第 ${row} 行列 ${column} 的值「${cell.slice(0, 20)}」不是数值`);
  }
  if (value < 0) {
    throw err('UNPROCESSABLE', `第 ${row} 行列 ${column} 出现负值 ${value};聚合前应先完成质量清洗`, {
      reason: 'NEGATIVE_VALUE',
    });
  }
  if (!Number.isSafeInteger(value) && Number.isInteger(value)) {
    throw err('UNPROCESSABLE', `第 ${row} 行列 ${column} 的整数值超出安全范围,拒绝静默精度损失`);
  }
  return value;
}

function ratioOf(numerator: MetricValue, denominator: MetricValue): MetricValue {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

const PERCENT_DECIMALS = 6;

export class AggregationService {
  readonly #repository: RepositoryPort;
  readonly #paths: ResolvedPaths;
  readonly #maxBytes: number;
  readonly #maxRows: number;

  constructor(options: {
    repository: RepositoryPort;
    paths: ResolvedPaths;
    maxBytes: number;
    maxRows: number;
  }) {
    this.#repository = options.repository;
    this.#paths = options.paths;
    this.#maxBytes = options.maxBytes;
    this.#maxRows = options.maxRows;
  }

  async aggregate(request: AggregateRequest): Promise<AggregateOutcome> {
    if (request.dataRef.format !== 'csv' && request.dataRef.format !== 'tsv') {
      throw err('UNPROCESSABLE', 'M1 聚合仅支持已导入的 CSV/TSV 数据版本');
    }
    const { header, records } = await readCsvRecords(request.absolutePath, {
      delimiter: request.dataRef.format === 'tsv' ? '\t' : ',',
      maxBytes: this.#maxBytes,
      maxRows: this.#maxRows,
    });
    const columnIndex = new Map(header.map((name, index) => [name, index]));
    const groupIndex = columnIndex.get(request.spec.group_by);
    if (groupIndex === undefined) {
      throw err('UNPROCESSABLE', `分组列 ${request.spec.group_by} 不存在`);
    }
    for (const metric of request.spec.metrics) {
      if (metric.kind === 'sum' && (metric.column === undefined || !columnIndex.has(metric.column))) {
        throw err('UNPROCESSABLE', `聚合列 ${metric.column ?? '(未指定)'} 不存在`);
      }
    }
    const metricNames = new Set(request.spec.metrics.map((metric) => metric.name));
    for (const ratio of request.spec.ratios) {
      if (!metricNames.has(ratio.numerator) || !metricNames.has(ratio.denominator)) {
        throw err('UNPROCESSABLE', `比率 ${ratio.name} 的分子/分母必须是已定义指标`);
      }
    }

    const computeValues = (rows: string[][], rowOffset: number): Record<string, MetricValue> => {
      const values: Record<string, MetricValue> = {};
      for (const metric of request.spec.metrics) {
        if (metric.kind === 'count') {
          values[metric.name] = rows.length;
          continue;
        }
        const index = columnIndex.get(metric.column as string) as number;
        let sum = 0;
        let counted = 0;
        rows.forEach((record, position) => {
          const cell = record[index];
          if (cell === undefined || cell === '') return; // 缺失不计入该指标
          sum += parseMetricCell(cell, metric.column as string, rowOffset + position + 1);
          counted++;
        });
        values[metric.name] = counted === 0 ? null : sum;
      }
      for (const ratio of request.spec.ratios) {
        const ratioValue = ratioOf(
          values[ratio.numerator] ?? null,
          values[ratio.denominator] ?? null,
        );
        values[ratio.name] = ratioValue;
        values[`${ratio.name}_percent`] =
          ratioValue === null ? null : Number((ratioValue * 100).toFixed(PERCENT_DECIMALS));
      }
      return values;
    };

    const byGroup = new Map<string, { rows: string[][]; firstRow: number }>();
    records.forEach((record, rowNumber) => {
      const key = record[groupIndex];
      if (key === undefined || key === '') {
        throw err('UNPROCESSABLE', `第 ${rowNumber + 1} 行分组列为空`);
      }
      const bucket = byGroup.get(key);
      if (bucket) bucket.rows.push(record);
      else byGroup.set(key, { rows: [record], firstRow: rowNumber });
    });

    const groups = [...byGroup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, bucket]) => ({ key, values: computeValues(bucket.rows, bucket.firstRow) }));
    const overall = { values: computeValues(records, 0) };

    const output: AggregationOutput = {
      schema_version: 1,
      dataset_version_id: request.dataRef.dataset_version_id as string,
      data_ref_id: request.dataRef.ref_id,
      spec: request.spec,
      groups,
      overall,
      generated_at: nowIso(),
    };
    const content = JSON.stringify(output, null, 2);

    const artifactId = newId();
    const workspaceRootDir = join(this.#paths.workspacesDir, request.workspaceId);
    const artifactDir = join(workspaceRootDir, 'artifacts', artifactId);
    await mkdir(artifactDir, { recursive: true });
    const fileName = 'metrics.json';
    const artifactPath = join(artifactDir, fileName);
    await writeFile(artifactPath, content, 'utf8');
    const sha256 = await sha256File(artifactPath);

    const evidence: MetricEvidence[] = [];
    for (const [name, value] of Object.entries(overall.values)) {
      if (value === null) continue;
      evidence.push({
        id: newId(),
        run_id: request.runId ?? null,
        data_ref_id: request.dataRef.ref_id,
        locator: `artifacts/${artifactId}/metrics.json#overall.values.${name}`,
        value_type: name.endsWith('_percent') ? 'percent' : 'number',
        unit: name.endsWith('_percent') ? '%' : null,
        scope: `overall; group_by=${request.spec.group_by}`,
        verification: 'unverified',
        created_at: nowIso(),
      });
    }
    for (const item of evidence) {
      await this.#repository.metricEvidence.put(item);
    }

    return {
      artifact: {
        relative_path: `artifacts/${artifactId}/${fileName}`,
        sha256,
        artifactId,
      },
      output,
      evidence,
    };
  }
}
