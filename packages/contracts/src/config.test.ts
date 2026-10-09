import { describe, expect, it } from 'vitest';
import { CredentialRefSchema, ProductConfigSchema } from './config.js';

// ---------------------------------------------------------------------------
// §18 产品配置 Schema 契约测试:严格字段、固定枚举、credential_ref 形态。
// ---------------------------------------------------------------------------

function validConfig(): Record<string, unknown> {
  return {
    schema_version: 1,
    server: { host: '127.0.0.1', port: 3080 },
    auth: { mode: 'local-token' },
    paths: { data_dir: './data', state_dir: './state', cache_dir: './cache' },
    runtime: {
      profile: 'data-analysis',
      python: 'auto',
      compute_device: 'cpu',
      max_active_kernels: 2,
      idle_kernel_timeout_seconds: 1800,
      cell_timeout_seconds: 600,
      interrupt_grace_seconds: 10,
      max_cell_output_mib: 8,
      agent_max_turns: 12,
    },
    data: {
      max_upload_mib: 512,
      preview_rows: 100,
      model_sample_rows: 20,
      model_sample_cell_chars: 200,
      quality_ts_max_mib: 50,
      quality_ts_max_rows: 100000,
    },
    database: {
      readonly: true,
      statement_timeout_seconds: 60,
      max_result_rows: 1000000,
      max_result_mib: 256,
    },
    model: {
      profile_id: 'mp-default',
      protocol: 'openai-chat',
      base_url: 'https://model.intranet.example/v1',
      model: 'deepseek-chat',
      credential_ref: 'env:DSH_API_KEY',
      connect_timeout_ms: 5000,
      response_timeout_ms: 120000,
      stream_idle_timeout_ms: 30000,
      temperature: 0.7,
      max_output_tokens: 4096,
      context_window_tokens: 131072,
      capabilities: { streaming: 'required', tool_calling: 'required', vision: 'optional' },
      extra_body: {},
    },
    network: {
      mode: 'intranet',
      allowed_model_endpoints: ['https://model.intranet.example/v1'],
      internet_runtime_downloads: false,
    },
    logging: { level: 'info', structured: true, store_data_samples: false },
  };
}

describe('ProductConfigSchema(§18)', () => {
  it('接受完整的合法配置', () => {
    const result = ProductConfigSchema.safeParse(validConfig());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model?.credential_ref).toBe('env:DSH_API_KEY');
    }
  });

  it('拒绝未知顶层字段(strictObject)', () => {
    const doc = { ...validConfig(), bogus_section: { x: 1 } };
    expect(ProductConfigSchema.safeParse(doc).success).toBe(false);
  });

  it('拒绝错误的 schema_version', () => {
    const doc = { ...validConfig(), schema_version: 2 };
    expect(ProductConfigSchema.safeParse(doc).success).toBe(false);
  });

  it('network.mode 只允许 intranet', () => {
    const doc = { ...validConfig(), network: { ...validConfig().network as Record<string, unknown>, mode: 'internet' } };
    expect(ProductConfigSchema.safeParse(doc).success).toBe(false);
  });

  it('internet_runtime_downloads 必须为 false(§7 禁止运行时下载)', () => {
    const doc = {
      ...validConfig(),
      network: { ...(validConfig().network as Record<string, unknown>), internet_runtime_downloads: true },
    };
    expect(ProductConfigSchema.safeParse(doc).success).toBe(false);
  });

  it('logging.store_data_samples 必须为 false(§17 数据样本不入日志)', () => {
    const doc = {
      ...validConfig(),
      logging: { ...(validConfig().logging as Record<string, unknown>), store_data_samples: true },
    };
    expect(ProductConfigSchema.safeParse(doc).success).toBe(false);
  });

  it('database.readonly 必须为 true(§9 只读数据库)', () => {
    const doc = {
      ...validConfig(),
      database: { ...(validConfig().database as Record<string, unknown>), readonly: false },
    };
    expect(ProductConfigSchema.safeParse(doc).success).toBe(false);
  });
});

describe('CredentialRefSchema(§18)', () => {
  it.each(['env:DSH_API_KEY', 'file:/etc/dsh/key', 'svc:vault-cred-1', 'none'])(
    '接受 %s',
    (ref) => {
      expect(CredentialRefSchema.safeParse(ref).success).toBe(true);
    },
  );

  it.each(['plain-secret', 'env:', 'http://key', 'ENV:NAME'])('拒绝 %s', (ref) => {
    expect(CredentialRefSchema.safeParse(ref).success).toBe(false);
  });
});
