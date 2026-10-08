import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AnalystError } from '@data-analyst/contracts';
import { SUPPORTED_ENV_KEYS, loadProductConfig, resolveConfigDir } from './config-loader.js';

// ---------------------------------------------------------------------------
// §18 加载顺序:内置默认 → 配置文件 → 固定映射环境变量 → zod 严格校验。
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'da-config-'));
});

function writeConfig(name: string, yaml: string): string {
  const file = join(dir, name);
  writeFileSync(file, yaml, 'utf8');
  return file;
}

const ENV_KEYS = Object.fromEntries(SUPPORTED_ENV_KEYS.map((key) => [key, ''])) as Record<
  (typeof SUPPORTED_ENV_KEYS)[number],
  string | undefined
>;

describe('loadProductConfig', () => {
  it('空文件使用内置默认', () => {
    const file = writeConfig('defaults.yaml', 'schema_version: 1\n');
    const config = loadProductConfig({ configFile: file, env: { ...ENV_KEYS } });
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(3080);
    expect(config.network.internet_runtime_downloads).toBe(false);
    expect(config.logging.store_data_samples).toBe(false);
  });

  it('配置文件覆盖默认(段级浅合并)', () => {
    const file = writeConfig('override.yaml', 'server:\n  port: 3200\n');
    const config = loadProductConfig({ configFile: file, env: { ...ENV_KEYS } });
    expect(config.server.port).toBe(3200);
    expect(config.server.host).toBe('127.0.0.1'); // 未覆盖的子键保留默认
  });

  it('固定映射环境变量覆盖文件与默认', () => {
    const file = writeConfig('env.yaml', 'server:\n  port: 3200\n');
    const config = loadProductConfig({
      configFile: file,
      env: { ...ENV_KEYS, DATA_ANALYST_SERVER_PORT: '3199', DATA_ANALYST_DATA_DIR: '/tmp/da-data' },
    });
    expect(config.server.port).toBe(3199);
    expect(config.paths.data_dir).toBe('/tmp/da-data');
  });

  it('非法 schema_version → CONFIG_INVALID', () => {
    const file = writeConfig('bad-version.yaml', 'schema_version: 2\n');
    try {
      loadProductConfig({ configFile: file, env: { ...ENV_KEYS } });
      expect.unreachable('应当抛出 CONFIG_INVALID');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalystError);
      expect((error as AnalystError).payload.code).toBe('CONFIG_INVALID');
    }
  });

  it('顶层不是 YAML 映射 → CONFIG_INVALID', () => {
    const file = writeConfig('list.yaml', '- a\n- b\n');
    expect(() => loadProductConfig({ configFile: file, env: { ...ENV_KEYS } })).toThrowError(AnalystError);
  });

  it('段内未知字段 → CONFIG_INVALID(strictObject)', () => {
    const file = writeConfig('bogus.yaml', 'server:\n  bogus_key: 1\n');
    expect(() => loadProductConfig({ configFile: file, env: { ...ENV_KEYS } })).toThrowError(AnalystError);
  });

  it('文件不可读 → CONFIG_INVALID', () => {
    expect(() =>
      loadProductConfig({ configFile: join(dir, 'missing.yaml'), env: { ...ENV_KEYS } }),
    ).toThrowError(AnalystError);
  });
});

describe('resolveConfigDir', () => {
  it('返回配置文件的绝对目录', () => {
    const file = writeConfig('x.yaml', 'schema_version: 1\n');
    expect(resolveConfigDir(file)).toBe(dir);
  });
});
