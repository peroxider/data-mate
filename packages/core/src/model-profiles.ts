import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  AnalystError,
  ModelProfileSchema,
  nowIso,
} from '@data-analyst/contracts';
import type { ModelProfile, ModelProfileUpdate, ProductConfig } from '@data-analyst/contracts';
import type { RepositoryPort } from './repository.js';

// ---------------------------------------------------------------------------
// §10/§18 ModelProfile 服务:版本化保存(每次保存新 revision)、
// extra_body 禁改字段校验(model/messages/tools/stream/认证字段,保存时拒绝)、
// 不含秘密的 config_hash、YAML model 块仅在 profile 不存在时导入。
// 凭据由服务端解析 credential_ref,绝不写入快照、日志或探测结果。
// ---------------------------------------------------------------------------

/** §10:extra_body 不得覆盖的请求与认证字段(保存时拒绝)。 */
const EXTRA_BODY_FORBIDDEN_KEYS = new Set([
  'model',
  'messages',
  'tools',
  'stream',
  'authorization',
  'api_key',
  'api-key',
  'x-api-key',
  'cookie',
]);

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

/** 规范化 JSON 序列化(键按 codepoint 排序,不用 localeCompare)。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** 不含秘密的配置哈希:覆盖全部请求设置,凭据只包含引用标识本身。 */
export function modelConfigHash(input: {
  protocol: string;
  base_url: string;
  model: string;
  credential_ref: string;
  capabilities: ModelProfile['capabilities'];
  connect_timeout_ms: number;
  response_timeout_ms: number;
  stream_idle_timeout_ms: number;
  temperature: number;
  max_output_tokens: number;
  context_window_tokens: number;
  extra_body: Record<string, unknown>;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/** 校验 extra_body 不含禁改字段;命中即 CONFIG_INVALID(§10 保存时拒绝)。 */
export function assertExtraBodyAllowed(extra_body: Record<string, unknown>): void {
  for (const key of Object.keys(extra_body)) {
    if (EXTRA_BODY_FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw err('CONFIG_INVALID', `extra_body 不得覆盖受保护字段: ${key}`, {
        protected_key: key,
      });
    }
  }
}

export interface ModelProfileServiceOptions {
  repository: RepositoryPort;
  /** file: 凭据单文件读取上限(字节),防误配大文件 */
  maxCredentialFileBytes?: number;
}

export class ModelProfileService {
  readonly #repository: RepositoryPort;
  readonly #maxCredentialFileBytes: number;

  constructor(options: ModelProfileServiceOptions) {
    this.#repository = options.repository;
    this.#maxCredentialFileBytes = options.maxCredentialFileBytes ?? 16 * 1024;
  }

  async get(profileId: string): Promise<ModelProfile | null> {
    return this.#repository.modelProfiles.get(profileId);
  }

  async list(): Promise<ModelProfile[]> {
    const profiles = await this.#repository.modelProfiles.list();
    return profiles.sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
    );
  }

  /**
   * 保存(创建或更新)ModelProfile:每次保存产生新 revision。
   * 已存在时 expected_revision 必须匹配当前 revision,否则 CONFLICT(§17 409);
   * 新建时 expected_revision 必须为 null。
   */
  async save(profileId: string, update: ModelProfileUpdate): Promise<ModelProfile> {
    assertExtraBodyAllowed(update.extra_body);
    const existing = await this.#repository.modelProfiles.get(profileId);

    if (existing) {
      if (update.expected_revision === null) {
        throw err('CONFLICT', 'Profile 已存在,必须携带 expected_revision', {
          current_revision: existing.revision,
        });
      }
      if (update.expected_revision !== existing.revision) {
        throw err('CONFLICT', 'ModelProfile revision 冲突,请读取最新配置后重试', {
          expected_revision: update.expected_revision,
          current_revision: existing.revision,
        });
      }
    } else if (update.expected_revision !== null) {
      throw err('CONFLICT', 'Profile 不存在,创建时 expected_revision 必须为 null', {
        expected_revision: update.expected_revision,
      });
    }

    const settings = {
      connect_timeout_ms: update.connect_timeout_ms,
      response_timeout_ms: update.response_timeout_ms,
      stream_idle_timeout_ms: update.stream_idle_timeout_ms,
      temperature: update.temperature,
      max_output_tokens: update.max_output_tokens,
      context_window_tokens: update.context_window_tokens,
      extra_body: update.extra_body,
    };
    const profile: ModelProfile = ModelProfileSchema.parse({
      id: profileId,
      revision: existing ? existing.revision + 1 : 1,
      protocol: update.protocol,
      base_url: update.base_url,
      model: update.model,
      credential_ref: update.credential_ref,
      capabilities: update.capabilities,
      config_hash: modelConfigHash({
        protocol: update.protocol,
        base_url: update.base_url,
        model: update.model,
        credential_ref: update.credential_ref,
        capabilities: update.capabilities,
        ...settings,
      }),
      created_at: nowIso(),
      ...settings,
    });
    await this.#repository.modelProfiles.put(profile);
    return profile;
  }

  /**
   * §18:YAML model 块仅在对应 profile 不存在时导入为初始配置;
   * 之后 SQLite/快照中的版本化 ModelProfile 为权威来源,重启不以旧 YAML 覆盖。
   */
  async importFromYamlIfAbsent(config: ProductConfig): Promise<ModelProfile | null> {
    const model = config.model;
    if (!model) return null;
    const existing = await this.#repository.modelProfiles.get(model.profile_id);
    if (existing) return null;
    return this.save(model.profile_id, {
      expected_revision: null,
      protocol: model.protocol,
      base_url: model.base_url,
      model: model.model,
      credential_ref: model.credential_ref,
      capabilities: model.capabilities,
      connect_timeout_ms: model.connect_timeout_ms,
      response_timeout_ms: model.response_timeout_ms,
      stream_idle_timeout_ms: model.stream_idle_timeout_ms,
      temperature: model.temperature,
      max_output_tokens: model.max_output_tokens,
      context_window_tokens: model.context_window_tokens,
      extra_body: model.extra_body,
    });
  }

  /**
   * §18 credential_ref 解析:env:NAME → 环境变量;file:PATH → 受控读取;
   * none → null;svc:ID → ENVIRONMENT_INCOMPLETE(产品凭据服务由 DSH 承接,
   * 产品侧不实现)。空值/缺失按 Endpoint 要求由调用方判断;秘密绝不进入日志。
   */
  async resolveCredential(profile: ModelProfile): Promise<string | null> {
    const ref = profile.credential_ref;
    if (ref === 'none' || ref.startsWith('none:')) return null;
    if (ref.startsWith('env:')) {
      const name = ref.slice('env:'.length);
      const value = process.env[name];
      if (value === undefined || value === '') {
        throw err('ENVIRONMENT_INCOMPLETE', `凭据环境变量未设置: ${name}`, {
          credential_ref: ref,
        });
      }
      return value;
    }
    if (ref.startsWith('file:')) {
      const path = ref.slice('file:'.length);
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        throw err('ENVIRONMENT_INCOMPLETE', '凭据文件不可读', { credential_ref: ref });
      }
      if (Buffer.byteLength(content, 'utf8') > this.#maxCredentialFileBytes) {
        throw err('ENVIRONMENT_INCOMPLETE', '凭据文件超过大小上限', { credential_ref: ref });
      }
      const trimmed = content.trim();
      if (trimmed === '') {
        throw err('ENVIRONMENT_INCOMPLETE', '凭据文件为空', { credential_ref: ref });
      }
      return trimmed;
    }
    throw err('ENVIRONMENT_INCOMPLETE', 'svc 凭据引用需由 DSH 凭据服务解析', {
      credential_ref: ref,
    });
  }
}
