import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { AnalystError } from '@data-analyst/contracts';
import type { ProductConfig } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// W4 — DSH 集成(薄)。职责:解析本地已装 DSH 二进制、构造启动 argv、
// 以 argv 数组受控 spawn。禁止 npx/运行时下载(§7/§24),禁止 shell 拼接。
// ---------------------------------------------------------------------------

export const DSH_BIN_ENV = 'DATA_ANALYST_DSH_BIN';

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析本地 DSH 二进制。优先级:显式路径 → DATA_ANALYST_DSH_BIN → PATH 逐目录扫描。
 * 找不到时抛 ENVIRONMENT_INCOMPLETE —— 绝不回退到 npx 下载。
 */
export function resolveDshBin(options: {
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
} = {}): string {
  const env = options.env ?? process.env;

  const candidates: string[] = [];
  if (options.explicit) candidates.push(options.explicit);
  const fromEnv = env[DSH_BIN_ENV];
  if (fromEnv) candidates.push(fromEnv);
  const pathEnv = options.path ?? env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    candidates.push(join(dir, 'dsh'));
  }

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  throw new AnalystError({
    code: 'ENVIRONMENT_INCOMPLETE',
    message: '未找到可执行的 DSH 二进制(已尝试显式路径、DATA_ANALYST_DSH_BIN 与 PATH 中的 dsh)',
    request_id: null,
    run_id: null,
    retryable: false,
    details: {
      explicit: options.explicit ?? null,
      env_key: DSH_BIN_ENV,
      hint: '安装 @deepseek-ai/dsh 后将其 bin 目录加入 PATH,或设置 DATA_ANALYST_DSH_BIN',
    },
  });
}

/** 构造 DSH 启动参数(argv 数组;M0 仅 profile)。纯函数,便于单测。 */
export function buildDshLaunchArgs(config: ProductConfig): string[] {
  return ['--profile', config.runtime.profile];
}

export interface SpawnDshOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** 受控 spawn:仅 argv 数组 + shell:false,stdio 继承,返回子进程句柄。 */
export function spawnDsh(bin: string, args: string[], options: SpawnDshOptions = {}) {
  return spawn(bin, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
    shell: false,
  });
}
