import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { AnalystError } from '@data-analyst/contracts';
import type { ProductConfig } from '@data-analyst/contracts';
import { loadProductConfig, resolveConfigDir, resolvePaths } from '@data-analyst/core';
import { resolveDshBin } from '@data-analyst/dsh-integration';

// ---------------------------------------------------------------------------
// W5 doctor:结构化环境自检。只读探测,绝不安装依赖(§7)。
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function checkNodeVersion(): CheckResult {
  const required = '22.19.0';
  if (compareVersions(process.versions.node, required) >= 0) {
    return { name: 'node', status: 'pass', detail: `node ${process.versions.node} >= ${required}` };
  }
  return { name: 'node', status: 'fail', detail: `node ${process.versions.node} < ${required}` };
}

function checkConfig(configFile: string): { config: ProductConfig; result: CheckResult } {
  try {
    const config = loadProductConfig({ configFile });
    return {
      config,
      result: { name: 'config', status: 'pass', detail: resolve(configFile) },
    };
  } catch (error) {
    const detail = error instanceof AnalystError ? error.payload.message : String(error);
    throw new AnalystError({
      code: 'CONFIG_INVALID',
      message: `配置不可用: ${detail}`,
      request_id: null,
      run_id: null,
      retryable: false,
      details: { config_file: resolve(configFile) },
    });
  }
}

function checkWritableDir(dir: string): CheckResult {
  if (existsSync(dir)) {
    try {
      accessSync(dir, constants.W_OK);
      return { name: `dir:${dir}`, status: 'pass', detail: '存在且可写' };
    } catch {
      return { name: `dir:${dir}`, status: 'fail', detail: '存在但不可写' };
    }
  }
  // 目录缺失时探测最近存在祖先的可写性 —— 不替用户创建目录
  let parent = dirname(dir);
  while (parent !== dirname(parent) && !existsSync(parent)) {
    parent = dirname(parent);
  }
  try {
    accessSync(parent, constants.W_OK);
    return { name: `dir:${dir}`, status: 'warn', detail: `不存在;父目录 ${parent} 可写` };
  } catch {
    return { name: `dir:${dir}`, status: 'fail', detail: `不存在且父目录 ${parent} 不可写` };
  }
}

function checkPython(config: ProductConfig, runtimeDir: string | null): CheckResult {
  const candidates =
    config.runtime.python === 'auto' ? ['python3', 'python'] : [config.runtime.python];
  for (const py of candidates) {
    // 发行物内运行时位于 <configDir>/../python/analyst_runtime(§23 布局),
    // 与 m1 分析上下文同一解析规则,保证安装后 doctor 与分析行为一致
    const probe = spawnSync(
      py,
      ['-m', 'analyst_runtime', 'doctor', '--json'],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: runtimeDir ? { ...process.env, PYTHONPATH: runtimeDir } : process.env,
      },
    );
    if (probe.error) continue; // ENOENT 等 → 尝试下一个候选
    if (probe.status === 0) {
      return { name: 'python', status: 'pass', detail: `${py} analyst_runtime doctor 通过` };
    }
    const stderr = (probe.stderr ?? '').trim();
    if (stderr.includes('No module named')) {
      return {
        name: 'python',
        status: 'warn',
        detail: `${py} 可用但 analyst_runtime 模块缺失(W8 计划项)`,
      };
    }
    return { name: 'python', status: 'warn', detail: `${py} 退出码 ${probe.status}: ${stderr.slice(0, 200)}` };
  }
  return { name: 'python', status: 'warn', detail: '未找到可用的 Python 解释器(runtime.python=auto)' };
}

function checkDshBin(): CheckResult {
  try {
    const bin = resolveDshBin();
    return { name: 'dsh', status: 'pass', detail: bin };
  } catch (error) {
    const detail = error instanceof AnalystError ? error.payload.message : String(error);
    return { name: 'dsh', status: 'warn', detail: `${detail}(serve --dsh 需要)` };
  }
}

function checkComponentsLock(configFile: string): CheckResult {
  // 锁文件是仓库级产物(§21);M0 以配置文件所在目录的上级为仓库根近似
  const lockPath = resolve(resolveConfigDir(configFile), '..', 'compat', 'components.lock.json');
  if (!existsSync(lockPath)) {
    return { name: 'components-lock', status: 'warn', detail: `${lockPath} 不存在(W6 计划项)` };
  }
  const mtime = statSync(lockPath).mtime.toISOString();
  return { name: 'components-lock', status: 'pass', detail: `${lockPath} (mtime ${mtime})` };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('环境自检:Node 版本、配置、目录可写性、Python/DSH 可用性、组件锁新鲜度;绝不安装依赖')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .option('--json', '输出结构化 JSON')
    .action(async (options: { config: string; json?: boolean }) => {
      const checks: CheckResult[] = [checkNodeVersion()];

      const { config, result: configResult } = checkConfig(options.config);
      checks.push(configResult);

      const paths = resolvePaths(config, resolveConfigDir(options.config));
      for (const dir of [paths.dataDir, paths.stateDir, paths.cacheDir]) {
        checks.push(checkWritableDir(dir));
      }

      const configDir = resolveConfigDir(options.config);
      const runtimeDir = resolve(configDir, '..', 'python', 'analyst_runtime');
      checks.push(checkPython(config, existsSync(runtimeDir) ? runtimeDir : null));
      checks.push(checkDshBin());
      checks.push(checkComponentsLock(options.config));

      if (options.json) {
        console.log(JSON.stringify({ checks }, null, 2));
      } else {
        for (const check of checks) {
          const mark = check.status === 'pass' ? '✔' : check.status === 'warn' ? '⚠' : '✘';
          console.log(`${mark} ${check.name}: ${check.detail}`);
        }
      }

      const failed = checks.some((check) => check.status === 'fail');
      if (failed) {
        throw new AnalystError({
          code: 'ENVIRONMENT_INCOMPLETE',
          message: 'doctor 检查存在失败项(见上方 ✘)',
          request_id: null,
          run_id: null,
          retryable: false,
          details: { checks },
        });
      }
    });
}
