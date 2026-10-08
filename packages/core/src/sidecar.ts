import { spawn } from 'node:child_process';
import { AnalystError } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// Python sidecar 执行助手:pythonBin -m analyst_runtime <subcommand>。
// 单次执行、JSON stdout;进程错误/非 JSON 输出如实转 ENVIRONMENT_INCOMPLETE,
// 不静默降级、不安装依赖(§7/§14)。
// ---------------------------------------------------------------------------

export interface SidecarRun {
  stdout: string;
  stderr: string;
}

export function runSidecar(options: {
  pythonBin: string;
  runtimeDir: string | null;
  args: string[];
  timeoutSeconds: number;
}): Promise<SidecarRun> {
  return new Promise<SidecarRun>((fulfil, reject) => {
    const child = spawn(options.pythonBin, ['-m', 'analyst_runtime', ...options.args], {
      env: options.runtimeDir ? { ...process.env, PYTHONPATH: options.runtimeDir } : process.env,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const fail = (error: unknown): void => {
      clearTimeout(timer);
      reject(
        new AnalystError({
          code: 'ENVIRONMENT_INCOMPLETE',
          message: `无法执行 Python 运行时 (${options.pythonBin}): ${
            error instanceof Error ? error.message : String(error)
          }`,
          request_id: null,
          run_id: null,
          retryable: false,
          details: null,
        }),
      );
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), (options.timeoutSeconds + 30) * 1000);
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });
    child.once('error', fail);
    child.once('exit', () => {
      clearTimeout(timer);
      fulfil({ stdout, stderr });
    });
  });
}

export function parseSidecarJson<T>(run: SidecarRun): T {
  try {
    return JSON.parse(run.stdout) as T;
  } catch {
    throw new AnalystError({
      code: 'ENVIRONMENT_INCOMPLETE',
      message: 'analyst_runtime 输出不是合法 JSON',
      request_id: null,
      run_id: null,
      retryable: false,
      details: { stderr: run.stderr.slice(0, 500) },
    });
  }
}
