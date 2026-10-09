import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AggregationOutput } from './aggregate.js';
import type { ProductConfig } from '@data-analyst/contracts';
import { resolvePaths, ReportService } from './index.js';

function testConfig(root: string): ProductConfig {
  return {
    schema_version: 1,
    server: { host: '127.0.0.1', port: 3080 },
    auth: { mode: 'local-token' },
    paths: {
      data_dir: join(root, 'data'),
      state_dir: join(root, 'state'),
      cache_dir: join(root, 'cache'),
    },
    runtime: {
      profile: 'data-analysis',
      python: 'python3',
      compute_device: 'cpu',
      max_active_kernels: 2,
      idle_kernel_timeout_seconds: 1800,
      cell_timeout_seconds: 600,
      interrupt_grace_seconds: 10,
      max_cell_output_mib: 8,
      agent_max_turns: 12,
    },
    data: {
      max_upload_mib: 16,
      preview_rows: 100,
      model_sample_rows: 20,
      model_sample_cell_chars: 200,
      quality_ts_max_mib: 8,
      quality_ts_max_rows: 100_000,
    },
    database: {
      readonly: true,
      statement_timeout_seconds: 60,
      max_result_rows: 1000,
      max_result_mib: 64,
    },
    network: {
      mode: 'intranet',
      allowed_model_endpoints: [],
      internet_runtime_downloads: false,
    },
    logging: { level: 'info', structured: true, store_data_samples: false },
  };
}

// §25 固定数值:总转化率 = 总成交/总访客 = 95/700,绝不平均渠道比率。
const AGGREGATION: AggregationOutput = {
  schema_version: 1,
  dataset_version_id: '00000000-0000-4000-8000-00000000ver0',
  data_ref_id: '00000000-0000-4000-8000-00000000ref0',
  spec: {
    group_by: 'channel',
    metrics: [
      { name: 'visitors', kind: 'sum', column: 'visitors' },
      { name: 'conversions', kind: 'sum', column: 'conversions' },
    ],
    ratios: [{ name: 'conversion_rate', numerator: 'conversions', denominator: 'visitors' }],
  },
  groups: [
    {
      key: 'A',
      values: { visitors: 400, conversions: 70, conversion_rate: 0.175, conversion_rate_percent: 17.5 },
    },
    {
      key: 'B',
      values: {
        visitors: 300,
        conversions: 25,
        conversion_rate: 0.083333,
        conversion_rate_percent: 8.333333,
      },
    },
  ],
  overall: {
    values: {
      visitors: 700,
      conversions: 95,
      conversion_rate: 0.135714,
      conversion_rate_percent: 13.571429,
    },
  },
  generated_at: '2026-01-01T00:00:00.000Z',
};

const ROOT = join(tmpdir(), 'data-mate-report-test-');
let root = '';
let service: ReportService;

beforeAll(async () => {
  root = await mkdtemp(ROOT);
  service = new ReportService({ paths: resolvePaths(testConfig(root), root) });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const WORKSPACE_ID = '00000000-0000-4000-8000-00000000cafe';

describe('ReportService(§15 离线 HTML 报告)', () => {
  it('生成含 fixture 数值、内嵌 manifest 且零远程引用的 HTML', async () => {
    const outcome = await service.generate({
      workspaceId: WORKSPACE_ID,
      title: '渠道转化分析',
      aggregation: AGGREGATION,
      metricsArtifact: {
        relative_path: 'artifacts/metrics-1/metrics.json',
        sha256: 'b'.repeat(64),
      },
    });

    expect(outcome.relative_path).toMatch(/^artifacts\/[0-9a-f-]{36}\/report\.html$/);
    expect(outcome.sha256).toHaveLength(64);

    const html = await readFile(
      join(root, 'data', 'workspaces', WORKSPACE_ID, outcome.relative_path),
      'utf8',
    );

    // §25 固定数值必须原样出现在报告中
    expect(html).toContain('13.571429');
    expect(html).toContain('17.5');
    expect(html).toContain('8.333333');
    expect(html).toContain('conversion_rate_percent');

    // 内嵌 manifest 记录 metrics 产物 sha256
    expect(html).toContain('b'.repeat(64));
    expect(html).toContain('report-manifest');
    expect(html).toContain('data-mate core ReportService');

    // 离线:无任何远程引用
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('<script src');
    expect(html).not.toContain('@import');
    expect(html.toLowerCase()).not.toContain('url(');
    expect(html).not.toContain('<link ');
  });

  it('空分母(null 指标)如实呈现为不可计算,不伪造 0', async () => {
    const withNull: AggregationOutput = {
      ...AGGREGATION,
      groups: [
        { key: 'A', values: { visitors: 400, conversions: 70, conversion_rate_percent: 17.5 } },
        { key: 'C', values: { visitors: 0, conversions: 0, conversion_rate_percent: null } },
      ],
      overall: {
        values: { visitors: 400, conversions: 70, conversion_rate_percent: 17.5 },
      },
    };
    const outcome = await service.generate({
      workspaceId: WORKSPACE_ID,
      title: '零分母场景<script>alert(1)</script>',
      aggregation: withNull,
      metricsArtifact: {
        relative_path: 'artifacts/metrics-2/metrics.json',
        sha256: 'c'.repeat(64),
      },
    });
    const html = await readFile(
      join(root, 'data', 'workspaces', WORKSPACE_ID, outcome.relative_path),
      'utf8',
    );
    expect(html).toContain('null(不可计算)');
    // XSS 注入样本必须被转义
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    // 图表只画非空组
    expect(html).toContain('>A</text>');
    expect(html).not.toContain('>C</text>');
  });

  it('附带质量报告时渲染质量概要区块', async () => {
    const outcome = await service.generate({
      workspaceId: WORKSPACE_ID,
      title: '带质量概要',
      aggregation: AGGREGATION,
      metricsArtifact: {
        relative_path: 'artifacts/metrics-1/metrics.json',
        sha256: 'b'.repeat(64),
      },
      quality: {
        relative_path: 'artifacts/quality-1/quality.json',
        sha256: 'd'.repeat(64),
        report: {
          completeness: 'complete',
          report: {
            rowCount: 4,
            duplicateRows: 0,
            duplicateRate: 0,
            columns: [
              {
                name: 'visitors',
                inferredType: 'integer',
                missing: 0,
                missingRate: 0,
                unique: 3,
                numeric: { min: 100, max: 300, mean: 175, outliers: 0 },
              },
            ],
          },
        },
      },
    });
    const html = await readFile(
      join(root, 'data', 'workspaces', WORKSPACE_ID, outcome.relative_path),
      'utf8',
    );
    expect(html).toContain('质量概要');
    expect(html).toContain('d'.repeat(64));
    expect(html).toContain('visitors');
    expect(html).toContain('175');
    expect(html).toContain('quality-report');
  });
});
