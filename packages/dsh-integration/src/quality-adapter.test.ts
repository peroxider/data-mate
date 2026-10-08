import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataRef } from '@data-analyst/contracts';
import { createQualityAdapter } from './quality-adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
// 组件冻结目录:M0 产物,内含 node_modules/dsh-data-quality@0.3.18
const profileDir = resolve(join(here, '..', '..', '..', '.m0', 'profile'));
const pluginAvailable = existsSync(join(profileDir, 'node_modules', 'dsh-data-quality'));

const dirs: string[] = [];

async function tempCsv(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quality-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'table.csv');
  await writeFile(path, content, 'utf8');
  return path;
}

function fakeRef(workspaceId: string): DataRef {
  return {
    ref_id: workspaceId,
    workspace_id: workspaceId,
    dataset_version_id: workspaceId,
    kind: 'table',
    format: 'csv',
    sha256: '0'.repeat(64),
    size_bytes: 100,
    row_count: 4,
    row_count_status: 'exact',
    schema_ref: 'datasets/d/versions/v/schema.json',
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

const FIXTURE = ['channel,visitors,conversions', 'A,100,10', 'A,300,60', 'B,200,20', 'B,100,5'].join('\n');

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!pluginAvailable)('createQualityAdapter(真实冻结插件)', () => {
  it('对 fixture 计算 profile,报告落盘且原文件哈希不变', async () => {
    const csvPath = await tempCsv(FIXTURE);
    const before = createHash('sha256').update(await readFile(csvPath)).digest('hex');
    const workspaceId = '00000000-0000-4000-8000-00000000abc001';
    let persisted = '';

    const adapter = createQualityAdapter({
      profileDir,
      resolveData: async (refId) => {
        expect(refId).toBe(workspaceId);
        return {
          ref: fakeRef(workspaceId),
          absolute_path: csvPath,
          bytes_available: 100,
          within_limits: true,
        };
      },
      limits: { maxBytes: 8 * 1024 * 1024, maxRows: 100_000 },
      persistReport: async (_workspaceId, json) => {
        persisted = json;
        return 'artifacts/quality-report.json';
      },
    });

    const result = await adapter.profile({ data_ref: fakeRef(workspaceId), columns: null, sample: null });
    expect(result.completeness).toBe('complete');
    expect(result.report_artifact).toBe('artifacts/quality-report.json');

    const byMetric = new Map(
      result.findings.filter((f) => f.column === 'visitors').map((f) => [f.metric, f.value]),
    );
    expect(byMetric.get('inferred_type')).toBe('number');
    expect(byMetric.get('missing')).toBe(0);
    expect(byMetric.get('numeric_mean')).toBeCloseTo(175, 6);

    const rowCountFinding = result.findings.find((f) => f.metric === 'row_count');
    expect(rowCountFinding?.value).toBe(4);

    const report = JSON.parse(persisted) as { report: { rowCount: number }; data_ref_id: string };
    expect(report.report.rowCount).toBe(4);
    expect(report.data_ref_id).toBe(workspaceId);

    const after = createHash('sha256').update(await readFile(csvPath)).digest('hex');
    expect(after).toBe(before); // T07:原文件哈希不变
  });

  it('clean/verify 在 M1 如实返回未启用', async () => {
    const adapter = createQualityAdapter({
      profileDir,
      resolveData: async () => {
        throw new Error('不应被调用');
      },
      limits: { maxBytes: 1, maxRows: 1 },
      persistReport: async () => '',
    });
    await expect(
      adapter.clean({
        data_ref: fakeRef('00000000-0000-4000-8000-00000000abc002'),
        rules: [{ rule_id: 'r', kind: 'k', column: null, params: {} }],
        dry_run: true,
      }),
    ).rejects.toMatchObject({ payload: { code: 'UNPROCESSABLE' } });
  });
});
