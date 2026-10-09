import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataRef, ProductConfig } from '@data-analyst/contracts';
import { AggregationService, InMemoryRepository, resolvePaths } from './index.js';

const dirs: string[] = [];

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

async function makeSetup(): Promise<{ service: AggregationService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agg-'));
  dirs.push(root);
  const repository = new InMemoryRepository();
  const service = new AggregationService({
    repository,
    paths: resolvePaths(testConfig(root), root),
    maxBytes: 16 * 1024 * 1024,
    maxRows: 100_000,
  });
  return { service, root };
}

function fakeRef(dataRefId: string, format: 'csv' | 'tsv' = 'csv'): DataRef {
  return {
    ref_id: dataRefId,
    workspace_id: dataRefId,
    dataset_version_id: dataRefId,
    kind: 'table',
    format,
    sha256: '0'.repeat(64),
    size_bytes: 100,
    row_count: 4,
    row_count_status: 'exact',
    schema_ref: 'schema.json',
    completeness: 'complete',
    scope: {
      source_ref: null,
      filter_description: null,
      sample_method: null,
      sample_seed: null,
      sampled_rows: null,
      query_result_complete: null,
    },
  };
}

const CONVERSION_SPEC = {
  group_by: 'channel',
  metrics: [
    { name: 'visitors_total', kind: 'sum' as const, column: 'visitors' },
    { name: 'conversions_total', kind: 'sum' as const, column: 'conversions' },
  ],
  ratios: [
    { name: 'conversion_rate', numerator: 'conversions_total', denominator: 'visitors_total' },
  ],
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AggregationService', () => {
  it('§25 固定数值:A=17.5%、B≈8.333333%、总体≈13.571429%', async () => {
    const { service, root } = await makeSetup();
    const csvPath = join(root, 'fixture_sales.csv');
    await writeFile(
      csvPath,
      ['channel,visitors,conversions', 'A,100,10', 'A,300,60', 'B,200,20', 'B,100,5'].join('\n'),
      'utf8',
    );
    const outcome = await service.aggregate({
      workspaceId: '00000000-0000-4000-8000-000000000000',
      dataRef: fakeRef('00000000-0000-4000-8000-000000000001'),
      absolutePath: csvPath,
      spec: CONVERSION_SPEC,
    });

    const groupA = outcome.output.groups.find((g) => g.key === 'A');
    const groupB = outcome.output.groups.find((g) => g.key === 'B');
    expect(groupA?.values.visitors_total).toBe(400);
    expect(groupA?.values.conversions_total).toBe(70);
    expect(groupA?.values.conversion_rate).toBe(0.175);
    expect(groupA?.values.conversion_rate_percent).toBe(17.5);
    expect(groupB?.values.conversion_rate).toBeCloseTo(25 / 300, 12);
    expect(groupB?.values.conversion_rate_percent).toBe(8.333333);
    expect(outcome.output.overall.values.visitors_total).toBe(700);
    expect(outcome.output.overall.values.conversions_total).toBe(95);
    expect(outcome.output.overall.values.conversion_rate).toBeCloseTo(95 / 700, 12);
    expect(outcome.output.overall.values.conversion_rate_percent).toBe(13.571429);
    expect(outcome.evidence.length).toBeGreaterThan(0);
  });

  it('零分母 → null,不伪造 0', async () => {
    const { service, root } = await makeSetup();
    const csvPath = join(root, 'edge.csv');
    await writeFile(csvPath, ['channel,visitors,conversions', 'A,0,0', 'B,200,25'].join('\n'), 'utf8');
    const outcome = await service.aggregate({
      workspaceId: '00000000-0000-4000-8000-000000000000',
      dataRef: fakeRef('00000000-0000-4000-8000-000000000002'),
      absolutePath: csvPath,
      spec: CONVERSION_SPEC,
    });
    const groupA = outcome.output.groups.find((g) => g.key === 'A');
    expect(groupA?.values.visitors_total).toBe(0);
    expect(groupA?.values.conversion_rate).toBeNull();
    expect(groupA?.values.conversion_rate_percent).toBeNull();
  });

  it('sum 列全缺失 → null;负值 → 明确错误', async () => {
    const { service, root } = await makeSetup();
    const nullCsv = join(root, 'nulls.csv');
    await writeFile(
      nullCsv,
      ['channel,visitors,conversions', 'ZERO,,3', 'NULLS,50,'].join('\n'),
      'utf8',
    );
    const outcome = await service.aggregate({
      workspaceId: '00000000-0000-4000-8000-000000000000',
      dataRef: fakeRef('00000000-0000-4000-8000-000000000003'),
      absolutePath: nullCsv,
      spec: CONVERSION_SPEC,
    });
    const nulls = outcome.output.groups.find((g) => g.key === 'NULLS');
    expect(nulls?.values.conversions_total).toBeNull();

    const negCsv = join(root, 'neg.csv');
    await writeFile(negCsv, ['channel,visitors,conversions', 'NEG,-1,2'].join('\n'), 'utf8');
    await expect(
      service.aggregate({
        workspaceId: '00000000-0000-4000-8000-000000000000',
        dataRef: fakeRef('00000000-0000-4000-8000-000000000004'),
        absolutePath: negCsv,
        spec: CONVERSION_SPEC,
      }),
    ).rejects.toMatchObject({ payload: { code: 'UNPROCESSABLE' } });
  });
});
