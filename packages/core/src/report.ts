import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId, nowIso } from '@data-analyst/contracts';
import type { ResolvedPaths } from './paths.js';
import type { AggregationOutput, MetricValue } from './aggregate.js';
import { sha256File } from './hashing.js';

// ---------------------------------------------------------------------------
// §15 离线 HTML 报告:单文件、资源全部内联、无 CDN/远程字体/远程脚本,
// 不访问网络即可在浏览器打开。报告内嵌产物 manifest(schema_version/
// producer/generated_at/inputs 的 sha256),报告文件自身哈希由登记方提交。
// 关键数值一律来自确定性聚合产物(metrics.json),不做二次计算。
// ---------------------------------------------------------------------------

export interface ReportArtifactInput {
  relative_path: string;
  sha256: string;
}

export interface ReportQualityInput extends ReportArtifactInput {
  /** 已解析的质量报告 JSON(quality-adapter persistReport 的内容) */
  report: {
    report?: {
      rowCount?: number;
      profiledRows?: number;
      sampled?: boolean;
      columnCount?: number;
      duplicateRows?: number;
      duplicateRate?: number;
      columns?: Array<{
        name?: string;
        inferredType?: string;
        missing?: number;
        missingRate?: number;
        unique?: number;
        numeric?: { min?: number; max?: number; mean?: number; outliers?: number };
        notes?: string[];
      }>;
    };
    completeness?: string;
  };
}

export interface ReportRequest {
  workspaceId: string;
  title: string;
  aggregation: AggregationOutput;
  metricsArtifact: ReportArtifactInput;
  quality?: ReportQualityInput;
  runId?: string | null;
}

export interface ReportOutcome {
  artifactId: string;
  relative_path: string;
  sha256: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmt(value: MetricValue): string {
  if (value === null) return 'null(不可计算)';
  return String(value);
}

const STYLE = `
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; color: #1a1a1a; }
  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #999; padding: 0.35rem 0.8rem; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  .null { color: #a33; }
  .meta { color: #555; }
  footer { margin-top: 2rem; color: #666; font-size: 0.85rem; }
`;

export class ReportService {
  readonly #paths: ResolvedPaths;

  constructor(options: { paths: ResolvedPaths }) {
    this.#paths = options.paths;
  }

  async generate(request: ReportRequest): Promise<ReportOutcome> {
    const artifactId = newId();
    const relativePath = `artifacts/${artifactId}/report.html`;
    const html = this.#render(request, artifactId);

    const artifactDir = join(
      this.#paths.workspacesDir,
      request.workspaceId,
      'artifacts',
      artifactId,
    );
    await mkdir(artifactDir, { recursive: true });
    const absolutePath = join(artifactDir, 'report.html');
    await writeFile(absolutePath, html, 'utf8');
    const sha256 = await sha256File(absolutePath);
    return { artifactId, relative_path: relativePath, sha256 };
  }

  #render(request: ReportRequest, artifactId: string): string {
    const title = escapeHtml(request.title);
    const overallRows = Object.entries(request.aggregation.overall.values)
      .map(
        ([name, value]) =>
          `<tr><td>${escapeHtml(name)}</td><td${
            value === null ? ' class="null"' : ''
          }>${escapeHtml(fmt(value))}</td></tr>`,
      )
      .join('');

    const metricNames = Object.keys(request.aggregation.overall.values);
    const groupHead = metricNames.map((name) => `<th>${escapeHtml(name)}</th>`).join('');
    const groupRows = request.aggregation.groups
      .map(
        (group) =>
          `<tr><td>${escapeHtml(group.key)}</td>${metricNames
            .map(
              (name) =>
                `<td${
                  group.values[name] === null || group.values[name] === undefined
                    ? ' class="null"'
                    : ''
                }>${escapeHtml(fmt(group.values[name] ?? null))}</td>`,
            )
            .join('')}</tr>`,
      )
      .join('');

    const chart = this.#renderChart(request.aggregation);
    const quality = request.quality ? this.#renderQuality(request.quality) : '';

    const manifest = {
      schema_version: 1 as const,
      producer: 'data-mate core ReportService',
      generated_at: nowIso(),
      artifact_id: artifactId,
      inputs: [
        {
          kind: 'metrics',
          relative_path: request.metricsArtifact.relative_path,
          sha256: request.metricsArtifact.sha256,
        },
        ...(request.quality
          ? [
              {
                kind: 'quality-report',
                relative_path: request.quality.relative_path,
                sha256: request.quality.sha256,
              },
            ]
          : []),
      ],
      dataset_version_id: request.aggregation.dataset_version_id,
      run_id: request.runId ?? null,
    };
    const manifestJson = JSON.stringify(manifest, null, 2).replaceAll('<', '\\u003c');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>${title}</h1>
<p class="meta">生成时间 ${escapeHtml(manifest.generated_at)} · 数据版本 ${escapeHtml(
      request.aggregation.dataset_version_id,
    )}</p>
</header>
<section id="overall">
<h2>总体指标</h2>
<table><tbody>${overallRows}</tbody></table>
</section>
<section id="groups">
<h2>分组指标(按 ${escapeHtml(request.aggregation.spec.group_by)} 分组)</h2>
<table><thead><tr><th>分组</th>${groupHead}</tr></thead><tbody>${groupRows}</tbody></table>
</section>
${chart}
${quality}
<footer>离线报告:所有资源内联,无远程引用;指标来源 metrics.json(sha256 见 manifest)。</footer>
<script type="application/json" id="report-manifest">${manifestJson}</script>
</body>
</html>
`;
  }

  /** 首个非空比率百分位指标的水平条形图;无可用指标时返回空串。 */
  #renderChart(aggregation: AggregationOutput): string {
    const chartMetric = Object.keys(aggregation.overall.values).find(
      (name) =>
        name.endsWith('_percent') &&
        aggregation.groups.some((group) => typeof group.values[name] === 'number'),
    );
    if (chartMetric === undefined) return '';

    const labelWidth = 120;
    const chartWidth = 640;
    const barMaxWidth = chartWidth - labelWidth - 90;
    const barHeight = 26;
    const gap = 10;
    const values = aggregation.groups
      .map((group) => ({ key: group.key, value: group.values[chartMetric] ?? null }))
      .filter((item): item is { key: string; value: number } => item.value !== null);
    const max = Math.max(...values.map((item) => item.value));
    if (!(max > 0)) return '';

    const bars = values
      .map((item, index) => {
        const y = index * (barHeight + gap);
        const width = Math.max(1, (item.value / max) * barMaxWidth);
        return `<g transform="translate(0,${y})">
<text x="${labelWidth - 8}" y="${barHeight / 2 + 5}" text-anchor="end" font-size="13">${escapeHtml(item.key)}</text>
<rect x="${labelWidth}" y="0" width="${width.toFixed(2)}" height="${barHeight}" fill="#3567b0"></rect>
<text x="${(labelWidth + width + 6).toFixed(2)}" y="${barHeight / 2 + 5}" font-size="12">${escapeHtml(
          String(item.value),
        )}</text>
</g>`;
      })
      .join('');
    const height = values.length * (barHeight + gap);
    return `<section id="chart">
<h2>分组比率 · ${escapeHtml(chartMetric)}</h2>
<svg width="${chartWidth}" height="${height}" role="img" aria-label="${escapeHtml(chartMetric)}">${bars}</svg>
</section>`;
  }

  #renderQuality(quality: ReportQualityInput): string {
    const report = quality.report.report ?? {};
    const cards = report.columns ?? [];
    const cardRows = cards
      .filter((card) => card.name !== undefined)
      .map(
        (card) =>
          `<tr><td>${escapeHtml(card.name as string)}</td><td>${escapeHtml(
            card.inferredType ?? '-',
          )}</td><td>${escapeHtml(String(card.missing ?? '-'))}</td><td>${escapeHtml(
            String(card.missingRate ?? '-'),
          )}</td><td>${escapeHtml(String(card.unique ?? '-'))}</td><td>${escapeHtml(
            String(card.numeric?.mean ?? '-'),
          )}</td></tr>`,
      )
      .join('');
    return `<section id="quality">
<h2>质量概要(completeness=${escapeHtml(quality.report.completeness ?? 'unknown')})</h2>
<p>行数 ${escapeHtml(String(report.rowCount ?? '-'))} · 重复行 ${escapeHtml(
      String(report.duplicateRows ?? '-'),
    )} · 重复率 ${escapeHtml(String(report.duplicateRate ?? '-'))}</p>
<table>
<thead><tr><th>列</th><th>推断类型</th><th>缺失数</th><th>缺失率</th><th>唯一值</th><th>均值</th></tr></thead>
<tbody>${cardRows}</tbody>
</table>
</section>`;
  }
}
