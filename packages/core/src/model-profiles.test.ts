import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnalystError,
  ModelProfileUpdateSchema,
  ProductConfigSchema,
} from '@data-analyst/contracts';
import type { ModelProfileUpdate, ProductConfig } from '@data-analyst/contracts';
import { InMemoryRepository } from './repository.js';
import {
  ModelProfileService,
  assertExtraBodyAllowed,
  modelConfigHash,
} from './model-profiles.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000005001';

function updateInput(overrides: Partial<ModelProfileUpdate> = {}): ModelProfileUpdate {
  return ModelProfileUpdateSchema.parse({
    expected_revision: null,
    protocol: 'openai-chat',
    base_url: 'http://model-gateway.internal:8000/v1',
    model: 'analyst-model',
    credential_ref: 'none',
    capabilities: { streaming: 'required', tool_calling: 'required', vision: 'disabled' },
    connect_timeout_ms: 10_000,
    response_timeout_ms: 120_000,
    stream_idle_timeout_ms: 60_000,
    temperature: 0.2,
    max_output_tokens: 8192,
    context_window_tokens: 65_536,
    extra_body: {},
    ...overrides,
  });
}

function yamlConfig(overrides: Partial<ProductConfig['model']> = {}): ProductConfig {
  return ProductConfigSchema.parse({
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
    },
    data: {
      max_upload_mib: 512,
      preview_rows: 100,
      model_sample_rows: 20,
      model_sample_cell_chars: 200,
      quality_ts_max_mib: 50,
      quality_ts_max_rows: 100_000,
    },
    database: {
      readonly: true,
      statement_timeout_seconds: 60,
      max_result_rows: 1_000_000,
      max_result_mib: 256,
    },
    network: {
      mode: 'intranet',
      allowed_model_endpoints: ['http://model-gateway.internal:8000/v1'],
      internet_runtime_downloads: false,
    },
    logging: { level: 'info', structured: true, store_data_samples: false },
    model: {
      profile_id: PROFILE_ID,
      protocol: 'openai-chat',
      base_url: 'http://model-gateway.internal:8000/v1',
      model: 'analyst-model',
      credential_ref: 'none',
      connect_timeout_ms: 10_000,
      response_timeout_ms: 120_000,
      stream_idle_timeout_ms: 60_000,
      temperature: 0.2,
      max_output_tokens: 8192,
      context_window_tokens: 65_536,
      capabilities: { streaming: 'required', tool_calling: 'required', vision: 'disabled' },
      extra_body: {},
      ...overrides,
    },
  });
}

describe('modelConfigHash', () => {
  it('对相同配置产生稳定哈希,不同 model 产生不同哈希', () => {
    const base = {
      protocol: 'openai-chat',
      base_url: 'http://gw:8000/v1',
      model: 'analyst-model',
      credential_ref: 'none',
      capabilities: {
        streaming: 'required' as const,
        tool_calling: 'required' as const,
        vision: 'disabled' as const,
      },
      connect_timeout_ms: 10_000,
      response_timeout_ms: 120_000,
      stream_idle_timeout_ms: 60_000,
      temperature: 0.2,
      max_output_tokens: 8192,
      context_window_tokens: 65_536,
      extra_body: { top_p: 0.9 },
    };
    const a = modelConfigHash(base);
    expect(modelConfigHash({ ...base, extra_body: { top_p: 0.9 } })).toBe(a);
    expect(a).toHaveLength(64);
    expect(modelConfigHash({ ...base, model: 'other' })).not.toBe(a);
  });
});

describe('assertExtraBodyAllowed', () => {
  it('允许普通参数,拒绝受保护字段(含大小写变体)', () => {
    expect(() => assertExtraBodyAllowed({ top_p: 0.9, user_tags: ['a'] })).not.toThrow();
    for (const key of ['model', 'messages', 'tools', 'stream', 'Authorization', 'API_KEY']) {
      expect(() => assertExtraBodyAllowed({ [key]: 'x' })).toThrowError(AnalystError);
    }
  });
});

describe('ModelProfileService.save', () => {
  it('新建 revision=1;每次保存 revision 递增且 config_hash 随内容变化', async () => {
    const service = new ModelProfileService({ repository: new InMemoryRepository() });
    const first = await service.save(PROFILE_ID, updateInput());
    expect(first.revision).toBe(1);

    const second = await service.save(
      PROFILE_ID,
      updateInput({ expected_revision: 1, temperature: 0.1 }),
    );
    expect(second.revision).toBe(2);
    expect(second.temperature).toBe(0.1);
    expect(second.config_hash).not.toBe(first.config_hash);
  });

  it('extra_body 含受保护字段时保存被拒绝且不产生新版本', async () => {
    const repository = new InMemoryRepository();
    const service = new ModelProfileService({ repository });
    await service.save(PROFILE_ID, updateInput());
    await expect(
      service.save(
        PROFILE_ID,
        updateInput({ expected_revision: 1, extra_body: { stream: true } }),
      ),
    ).rejects.toMatchObject({ payload: { code: 'CONFIG_INVALID' } });
    const after = await repository.modelProfiles.get(PROFILE_ID);
    expect(after?.revision).toBe(1);
  });

  it('expected_revision 不匹配 → CONFLICT;创建时带 expected_revision → CONFLICT', async () => {
    const service = new ModelProfileService({ repository: new InMemoryRepository() });
    await service.save(PROFILE_ID, updateInput());
    await expect(
      service.save(PROFILE_ID, updateInput({ expected_revision: 99 })),
    ).rejects.toMatchObject({
      payload: { code: 'CONFLICT', details: { current_revision: 1 } },
    });
    await expect(
      service.save('00000000-0000-4000-8000-000000005002', updateInput({ expected_revision: 1 })),
    ).rejects.toMatchObject({ payload: { code: 'CONFLICT' } });
  });

  it('凭据仅存引用,实体不含秘密值', async () => {
    const service = new ModelProfileService({ repository: new InMemoryRepository() });
    const saved = await service.save(
      PROFILE_ID,
      updateInput({ credential_ref: 'env:MODEL_API_KEY' }),
    );
    const stored = JSON.stringify(saved);
    expect(stored).toContain('env:MODEL_API_KEY');
    expect(stored.toLowerCase()).not.toContain('sk-');
  });
});

describe('ModelProfileService.importFromYamlIfAbsent', () => {
  it('profile 不存在时导入 YAML model 块;已存在时不动权威配置', async () => {
    const repository = new InMemoryRepository();
    const service = new ModelProfileService({ repository });

    const imported = await service.importFromYamlIfAbsent(yamlConfig());
    expect(imported?.revision).toBe(1);

    // 手动升级到 revision 2 后,重启加载同一 YAML 不得覆盖(§18)
    const second = await service.save(
      PROFILE_ID,
      updateInput({ expected_revision: 1, model: 'analyst-model-v2' }),
    );
    expect(second.revision).toBe(2);

    const again = await service.importFromYamlIfAbsent(yamlConfig());
    expect(again).toBeNull();
    const after = await repository.modelProfiles.get(PROFILE_ID);
    expect(after?.revision).toBe(2);
    expect(after?.model).toBe('analyst-model-v2');
  });

  it('配置无 model 块时不导入', async () => {
    const service = new ModelProfileService({ repository: new InMemoryRepository() });
    const config = yamlConfig();
    delete (config as { model?: unknown }).model;
    expect(await service.importFromYamlIfAbsent(config)).toBeNull();
  });
});

describe('ModelProfileService.resolveCredential', () => {
  it('env: 缺失 → ENVIRONMENT_INCOMPLETE;none → null;file: 可读且裁剪空白', async () => {
    const service = new ModelProfileService({ repository: new InMemoryRepository() });
    const profile = await service.save(PROFILE_ID, updateInput());

    await expect(
      service.resolveCredential({ ...profile, credential_ref: 'env:M5_MISSING_KEY_XYZ' }),
    ).rejects.toMatchObject({ payload: { code: 'ENVIRONMENT_INCOMPLETE' } });

    expect(await service.resolveCredential(profile)).toBeNull();

    const dir = await mkdtemp(join(tmpdir(), 'm5-cred-'));
    const credPath = join(dir, 'cred.txt');
    await writeFile(credPath, '  file-credential-value  \n', 'utf8');
    const fileProfile = { ...profile, credential_ref: `file:${credPath}` };
    expect(await service.resolveCredential(fileProfile)).toBe('file-credential-value');
  });
});
