import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId, nowIso } from '@data-analyst/contracts';
import type { TrainingResult } from '@data-analyst/contracts';
import type { ResolvedPaths } from './paths.js';
import type { MetricCheck } from './evidence.js';
import { renderCoefficientSvg } from './figure.js';
import { sha256File } from './hashing.js';

// ---------------------------------------------------------------------------
// §15 离线训练报告:单文件 HTML,资源全部内联(解释图 SVG 直接嵌入),
// 内嵌 manifest(inputs 的 sha256)。数值来自训练产物与产品侧重算结果,
// 不做二次计算;evidence 状态如实展示(consistent/mismatch/unverified/stale)。
// ---------------------------------------------------------------------------

export interface ReportArtifactRef {
  artifact_id: string;
  relative_path: string;
  sha256: string;
}

export interface TrainReportRequest {
  workspaceId: string;
  title: string;
  training: TrainingResult;
  checks: MetricCheck[];
  evidence: Array<{ locator: string; verification: string }>;
  inputs: Array<{ kind: string; relative_path: string; sha256: string }>;
}

export interface TrainReportOutcome {
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

const STYLE = `
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; color: #1a1a1a; }
  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #999; padding: 0.35rem 0.8rem; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  .meta { color: #555; }
  .ok { color: #2a7a2a; } .bad { color: #a33; } .warn { color: #a66b00; }
  footer { margin-top: 2rem; color: #666; font-size: 0.85rem; }
`;

function verificationClass(verification: string): string {
  if (verification === 'consistent') return 'ok';
  if (verification === 'mismatch' || verification === 'stale') return 'bad';
  return 'warn';
}

export class TrainReportService {
  readonly #paths: ResolvedPaths;

  constructor(options: { paths: ResolvedPaths }) {
    this.#paths = options.paths;
  }

  async generate(request: TrainReportRequest): Promise<TrainReportOutcome> {
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

  #render(request: TrainReportRequest, artifactId: string): string {
    const training = request.training;
    const title = escapeHtml(request.title);
    const metricRows = Object.entries(training.metrics)
      .map(
        ([name, value]) =>
          `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(
            value === null ? 'null(不可计算)' : String(value),
          )}</td><td>${escapeHtml(
            training.baseline[name] === undefined
              ? '-'
              : training.baseline[name] === null
                ? 'null'
                : String(training.baseline[name]),
          )}</td></tr>`,
      )
      .join('');
    const confusion = training.confusion_matrix
      ? `<section id="confusion">
<h2>混淆矩阵(测试集)</h2>
<table><thead><tr><th></th>${training.confusion_matrix.labels
        .map((label) => `<th>预测 ${escapeHtml(label)}</th>`)
        .join('')}</tr></thead>
<tbody>${training.confusion_matrix.matrix
        .map(
          (row, index) =>
            `<tr><td>实际 ${escapeHtml(training.confusion_matrix!.labels[index] as string)}</td>${row
              .map((cell) => `<td>${cell}</td>`)
              .join('')}</tr>`,
        )
        .join('')}</tbody></table>
</section>`
      : '';
    const leakageRows = training.split.leakage.excluded_fields
      .map(
        (field) =>
          `<tr><td>${escapeHtml(field.column)}</td><td>${escapeHtml(field.reason)}</td></tr>`,
      )
      .join('');
    const checkRows = request.checks
      .map(
        (check) =>
          `<tr><td>${escapeHtml(check.name)}</td><td>${
            check.reported === null ? '-' : escapeHtml(String(check.reported))
          }</td><td>${
            check.recomputed === null ? '-' : escapeHtml(String(check.recomputed))
          }</td><td class="${verificationClass(check.status)}">${escapeHtml(check.status)}</td></tr>`,
      )
      .join('');
    const evidenceRows = request.evidence
      .map(
        (item) =>
          `<tr><td>${escapeHtml(item.locator)}</td><td class="${verificationClass(
            item.verification,
          )}">${escapeHtml(item.verification)}</td></tr>`,
      )
      .join('');
    const figure = renderCoefficientSvg(training);
    const manifest = {
      schema_version: 1 as const,
      producer: 'data-mate core TrainReportService',
      generated_at: nowIso(),
      artifact_id: artifactId,
      inputs: request.inputs,
      dataset_version_id: training.split.dataset_version_id,
      data_sha256: training.split.data_sha256,
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
<p class="meta">任务 ${escapeHtml(training.task)} · 模型 ${escapeHtml(
      training.model.kind,
    )} · 训练/测试 ${training.n_train}/${training.n_test} · 种子 ${training.split.split_seed} · 生成时间 ${escapeHtml(
      manifest.generated_at,
    )}</p>
</header>
<section id="metrics">
<h2>指标(测试集,对比基线)</h2>
<table><thead><tr><th>指标</th><th>模型</th><th>基线</th></tr></thead><tbody>${metricRows}</tbody></table>
<p class="meta">数据 sha256:${escapeHtml(training.split.data_sha256)} · 缺失策略:特征或目标缺失的行整行剔除</p>
</section>
${confusion}
<section id="leakage">
<h2>泄漏检查</h2>
${
  leakageRows
    ? `<table><thead><tr><th>剔除列</th><th>原因</th></tr></thead><tbody>${leakageRows}</tbody></table>`
    : '<p>无剔除列(所有候选特征均通过泄漏检查)</p>'
}
</section>
<section id="figure">
<h2>特征解释图</h2>
${figure ?? '<p>无可视化系数(模型无可用特征)</p>'}
</section>
<section id="verification">
<h2>关键结论验证(§13 产品侧独立重算)</h2>
<table><thead><tr><th>指标</th><th>自报值</th><th>重算值</th><th>状态</th></tr></thead><tbody>${checkRows}</tbody></table>
<h2>MetricEvidence 登记</h2>
<table><thead><tr><th>locator</th><th>verification</th></tr></thead><tbody>${evidenceRows}</tbody></table>
</section>
<footer>离线报告:所有资源内联,无远程引用;来源工件 sha256 见 manifest。结论限于训练数据分布,不表达因果。</footer>
<script type="application/json" id="report-manifest">${manifestJson}</script>
</body>
</html>
`;
  }
}
