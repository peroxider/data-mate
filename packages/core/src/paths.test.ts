import { describe, expect, it } from 'vitest';
import { resolvePaths } from './paths.js';
import type { ProductConfig } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §9 目录布局:相对路径以配置目录为基准;业务代码不接受任意拼接绝对路径。
// ---------------------------------------------------------------------------

const configDir = '/cfg/product';

function configWith(paths: { data_dir: string; state_dir: string; cache_dir: string }): ProductConfig {
  return {
    schema_version: 1,
    server: { host: '127.0.0.1', port: 3080 },
    auth: { mode: 'local-token' },
    paths,
    runtime: {
      profile: 'data-analysis',
      python: 'auto',
      compute_device: 'cpu',
      max_active_kernels: 2,
      idle_kernel_timeout_seconds: 1800,
      cell_timeout_seconds: 600,
      interrupt_grace_seconds: 10,
      max_cell_output_mib: 8,
    },
    data: {
      max_upload_mib: 512,
      preview_rows: 100,
      model_sample_rows: 20,
      model_sample_cell_chars: 200,
      quality_ts_max_mib: 50,
      quality_ts_max_rows: 100000,
    },
    database: { readonly: true, statement_timeout_seconds: 60, max_result_rows: 1000000, max_result_mib: 256 },
    network: { mode: 'intranet', allowed_model_endpoints: [], internet_runtime_downloads: false },
    logging: { level: 'info', structured: true, store_data_samples: false },
  } as ProductConfig;
}

describe('resolvePaths', () => {
  it('相对目录以配置目录为基准解析', () => {
    const paths = resolvePaths(
      configWith({ data_dir: './data', state_dir: './state', cache_dir: './cache' }),
      configDir,
    );
    expect(paths.dataDir).toBe('/cfg/product/data');
    expect(paths.stateDir).toBe('/cfg/product/state');
    expect(paths.cacheDir).toBe('/cfg/product/cache');
  });

  it('绝对目录保持不变', () => {
    const paths = resolvePaths(
      configWith({ data_dir: '/srv/data', state_dir: '/srv/state', cache_dir: '/srv/cache' }),
      configDir,
    );
    expect(paths.dataDir).toBe('/srv/data');
    expect(paths.stateDir).toBe('/srv/state');
    expect(paths.cacheDir).toBe('/srv/cache');
  });

  it('派生目录遵循 §9 布局', () => {
    const paths = resolvePaths(
      configWith({ data_dir: './data', state_dir: './state', cache_dir: './cache' }),
      configDir,
    );
    expect(paths.workspacesDir).toBe('/cfg/product/data/workspaces');
    expect(paths.productStateFile).toBe('/cfg/product/state/product.sqlite');
    expect(paths.dshStateDir).toBe('/cfg/product/state/dsh');
    expect(paths.credentialsDir).toBe('/cfg/product/state/credentials');
  });
});
