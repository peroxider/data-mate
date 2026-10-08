import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';
import { ProductConfigSchema, AnalystError } from '@data-analyst/contracts';
import type { ProductConfig } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §18 加载顺序:内置默认 → 配置文件 → 固定映射环境变量。
// 禁止把任意环境变量拼入配置;仅接受下列显式映射。
// ---------------------------------------------------------------------------

export const SUPPORTED_ENV_KEYS = [
  'DATA_ANALYST_SERVER_HOST',
  'DATA_ANALYST_SERVER_PORT',
  'DATA_ANALYST_DATA_DIR',
  'DATA_ANALYST_STATE_DIR',
  'DATA_ANALYST_CACHE_DIR',
] as const;

interface BuiltinDefaults {
  server: Record<string, unknown>;
  auth: Record<string, unknown>;
  paths: Record<string, unknown>;
  runtime: Record<string, unknown>;
  data: Record<string, unknown>;
  database: Record<string, unknown>;
  network: Record<string, unknown>;
  logging: Record<string, unknown>;
}

/** 镜像 config/defaults.yaml,并补齐 network 默认段。 */
const BUILTIN_DEFAULTS: BuiltinDefaults = {
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
    quality_ts_max_rows: 100000,
  },
  database: {
    readonly: true,
    statement_timeout_seconds: 60,
    max_result_rows: 1000000,
    max_result_mib: 256,
  },
  network: {
    mode: 'intranet',
    allowed_model_endpoints: [],
    internet_runtime_downloads: false,
  },
  logging: { level: 'info', structured: true, store_data_samples: false },
};

function configInvalid(message: string, details?: Record<string, unknown>): AnalystError {
  return new AnalystError({
    code: 'CONFIG_INVALID',
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details: details ?? null,
  });
}

/** 段级浅合并:用户文件覆盖内置默认,未提供的子键保留默认值。 */
function mergeSection(
  defaults: Record<string, unknown>,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (override === undefined) return defaults;
  return { ...defaults, ...override };
}

export function resolveConfigDir(configFile: string): string {
  return dirname(resolve(configFile));
}

export function loadProductConfig(options: {
  configFile: string;
  env?: NodeJS.ProcessEnv;
}): ProductConfig {
  const env = options.env ?? process.env;

  let userDoc: unknown;
  try {
    const raw = readFileSync(resolve(options.configFile), 'utf8');
    userDoc = yaml.load(raw);
  } catch (error) {
    throw configInvalid(
      `配置文件读取或解析失败: ${options.configFile}`,
      error instanceof Error ? { reason: error.message } : undefined,
    );
  }
  if (userDoc === null || typeof userDoc !== 'object' || Array.isArray(userDoc)) {
    throw configInvalid('配置文件顶层必须是 YAML 映射');
  }
  const user = userDoc as Record<string, unknown>;
  if (user.schema_version !== undefined && user.schema_version !== 1) {
    throw configInvalid(`不支持的 schema_version: ${String(user.schema_version)}`);
  }

  const merged: Record<string, unknown> = {
    schema_version: 1,
    server: mergeSection(BUILTIN_DEFAULTS.server, user.server as Record<string, unknown>),
    auth: mergeSection(BUILTIN_DEFAULTS.auth, user.auth as Record<string, unknown>),
    paths: mergeSection(BUILTIN_DEFAULTS.paths, user.paths as Record<string, unknown>),
    runtime: mergeSection(BUILTIN_DEFAULTS.runtime, user.runtime as Record<string, unknown>),
    data: mergeSection(BUILTIN_DEFAULTS.data, user.data as Record<string, unknown>),
    database: mergeSection(BUILTIN_DEFAULTS.database, user.database as Record<string, unknown>),
    model: user.model,
    network: mergeSection(BUILTIN_DEFAULTS.network, user.network as Record<string, unknown>),
    logging: mergeSection(BUILTIN_DEFAULTS.logging, user.logging as Record<string, unknown>),
  };

  // 固定映射环境变量覆盖(§18)
  if (env.DATA_ANALYST_SERVER_HOST) {
    (merged.server as Record<string, unknown>).host = env.DATA_ANALYST_SERVER_HOST;
  }
  if (env.DATA_ANALYST_SERVER_PORT) {
    (merged.server as Record<string, unknown>).port = Number(env.DATA_ANALYST_SERVER_PORT);
  }
  if (env.DATA_ANALYST_DATA_DIR) {
    (merged.paths as Record<string, unknown>).data_dir = env.DATA_ANALYST_DATA_DIR;
  }
  if (env.DATA_ANALYST_STATE_DIR) {
    (merged.paths as Record<string, unknown>).state_dir = env.DATA_ANALYST_STATE_DIR;
  }
  if (env.DATA_ANALYST_CACHE_DIR) {
    (merged.paths as Record<string, unknown>).cache_dir = env.DATA_ANALYST_CACHE_DIR;
  }

  const result = ProductConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw configInvalid('配置校验失败', { issues });
  }
  return result.data;
}
