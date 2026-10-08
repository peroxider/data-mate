import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// M3 验收测试(§24):SQL→Notebook→报告 全链路经真实 CLI 执行。
// 需要先 `pnpm -s build`;python3 或构建产物缺失时跳过(环境自检项)。
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, '..', '..');
const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'index.js');

const dirs: string[] = [];
let configDir: string;

function pythonBin(): string | null {
  for (const candidate of ['python3', 'python']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'm3-e2e-'));
  dirs.push(configDir);
  await writeFile(
    join(configDir, 'config.yaml'),
    [
      'schema_version: 1',
      'server: { host: 127.0.0.1, port: 3080 }',
      'auth: { mode: local-token }',
      'paths:',
      '  data_dir: ./.m0/data',
      '  state_dir: ./.m0/state',
      '  cache_dir: ./.m0/cache',
      'runtime:',
      '  profile: data-analysis',
      '  python: auto',
      '  compute_device: cpu',
      '  max_active_kernels: 2',
      '  idle_kernel_timeout_seconds: 1800',
      '  cell_timeout_seconds: 120',
      '  interrupt_grace_seconds: 10',
      '  max_cell_output_mib: 8',
      'data:',
      '  max_upload_mib: 16',
      '  preview_rows: 100',
      '  model_sample_rows: 20',
      '  model_sample_cell_chars: 200',
      '  quality_ts_max_mib: 8',
      '  quality_ts_max_rows: 100000',
      'database:',
      '  readonly: true',
      '  statement_timeout_seconds: 60',
      '  max_result_rows: 1000',
      '  max_result_mib: 64',
      'network:',
      '  mode: intranet',
      '  allowed_model_endpoints: []',
      '  internet_runtime_downloads: false',
      'logging: { level: info, structured: true, store_data_samples: false }',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runCli(args: string[], timeoutMs: number): string {
  return execFileSync(process.execPath, [cliEntry, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATA_ANALYST_RUNTIME_DIR: join(repoRoot, 'python', 'analyst_runtime'),
    },
    timeout: timeoutMs,
  });
}

describe.skipIf(!existsSync(cliEntry) || pythonBin() === null)('M3 全链路(SQL→Notebook→报告)', () => {
  it('m3-demo 产出可追溯数据版本、Run 快照、Cell 复算与离线报告', { timeout: 180_000 }, () => {
    const stdout = runCli(['m3-demo', '--config', join(configDir, 'config.yaml')], 120_000);
    const summary = JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
      workspace_id: string;
      datasource: { id: string; driver: string };
      sql: {
        statement: string;
        rows_fetched: number;
        truncated: boolean;
        completeness: string;
        data_ref_id: string;
        version_id: string;
      };
      run: { id: string; config_revision: number; model_profile_snapshot_id: string | null };
      cell: { events: number; execute_result: { 'text/plain'?: string } | null };
      aggregation: { overall: { values: Record<string, number | null> } };
      report: { relative_path: string; sha256: string };
    };

    // SQL 只读查询与 T09 完整性语义
    expect(summary.datasource.driver).toBe('sqlite');
    expect(summary.sql.rows_fetched).toBe(3);
    expect(summary.sql.truncated).toBe(false);
    expect(summary.sql.completeness).toBe('complete');

    // 运行治理:config revision 快照(T12)
    expect(summary.run.config_revision).toBe(1);
    expect(summary.run.model_profile_snapshot_id).not.toBeNull();

    // Notebook 复算与 SQL 聚合一致(grand_total = 100+260+40+200+120+80)
    expect(summary.cell.events).toBeGreaterThan(0);
    expect(summary.cell.execute_result?.['text/plain'] ?? '').toContain('800');

    // 确定性聚合与离线报告产物
    expect(summary.aggregation.overall.values['total_amount']).toBe(800);
    expect(summary.report.relative_path).toContain('report.html');

    // 报告文件真实落盘(路径相对临时 config 目录解析)
    const reportFile = join(
      configDir,
      '.m0',
      'data',
      'workspaces',
      summary.workspace_id,
      summary.report.relative_path,
    );
    expect(existsSync(reportFile)).toBe(true);

    // 快照可恢复(落盘实体全部通过契约校验)
    runCli(['datasource', 'list', '--config', join(configDir, 'config.yaml')], 60_000);
  });
});
