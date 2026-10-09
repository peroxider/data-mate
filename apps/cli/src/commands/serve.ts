import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  AggregationService,
  ApiServer,
  InMemoryRepository,
  ModelProfileService,
  RunGovernor,
  WorkspaceService,
  createDefaultToolRegistry,
  loadProductConfig,
  resolveConfigDir,
  resolvePaths,
} from '@data-analyst/core';
import { buildDshLaunchArgs, resolveDshBin, spawnDsh } from '@data-analyst/dsh-integration';

// ---------------------------------------------------------------------------
// §17 serve：校验配置，启动产品 REST API(/api/v1)；--dsh 时受控启动本地 DSH。
// 启动流程（§18/§19）：配置校验 → 快照恢复 → YAML model 块按需导入 →
// 启动对账（遗留 Run 终结）→ local-token 生成/加载 → 监听 → 优雅关闭落盘。
// 绝不下载、绝不安装。
// ---------------------------------------------------------------------------

async function loadOrCreateToken(credentialsDir: string): Promise<string> {
  const tokenPath = join(credentialsDir, 'local-token');
  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // 首次启动生成
  }
  await mkdir(credentialsDir, { recursive: true });
  const token = randomBytes(32).toString('hex');
  await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('校验配置并启动产品 REST API；--dsh 时受控启动本地 DSH')
    .requiredOption('--config <file>', '配置 YAML 路径')
    .option('--dsh', '受控启动本地 DSH(需要环境中已安装)')
    .action(async (options: { config: string; dsh?: boolean }) => {
      const config = loadProductConfig({ configFile: options.config });
      const paths = resolvePaths(config, resolveConfigDir(options.config));

      if (!options.dsh) {
        // 产品 API 服务
        const repository = new InMemoryRepository();
        await repository.restoreFrom(paths.productStateFile).catch(() => undefined);
        const modelProfiles = new ModelProfileService({ repository });
        const imported = await modelProfiles.importFromYamlIfAbsent(config);
        if (imported) {
          console.log(`已从配置导入初始 ModelProfile: ${imported.id} (revision=${imported.revision})`);
        }
        const governor = new RunGovernor({
          repository,
          maxActiveKernels: config.runtime.max_active_kernels,
        });
        const recovery = await governor.recoverOnStartup();
        if (recovery.interruptedRuns > 0 || recovery.cancelledQueued > 0) {
          console.log(
            `启动对账：interrupted=${recovery.interruptedRuns} cancelledQueued=${recovery.cancelledQueued}`,
          );
        }

        const persist = async (): Promise<void> => {
          await repository.snapshotTo(paths.productStateFile);
        };
        const token = await loadOrCreateToken(paths.credentialsDir);

        // §17 Agent 工具接入:领域服务 + 工具注册表,启用多轮 Agent 回路
        const configDir = resolveConfigDir(options.config);
        const repoRoot = resolve(configDir, '..');
        const pythonBin = config.runtime.python === 'auto' ? 'python3' : config.runtime.python;
        const runtimeDirEnv = process.env.DATA_ANALYST_RUNTIME_DIR;
        const runtimeDirCandidate = runtimeDirEnv ?? join(repoRoot, 'python', 'analyst_runtime');
        const runtimeDir = existsSync(runtimeDirCandidate) ? runtimeDirCandidate : null;
        const workspace = new WorkspaceService({
          repository,
          paths,
          pythonBin,
          runtimeDir,
          limits: {
            maxUploadBytes: config.data.max_upload_mib * 1024 * 1024,
            maxRows: config.data.quality_ts_max_rows,
          },
        });
        const aggregation = new AggregationService({
          repository,
          paths,
          maxBytes: config.data.quality_ts_max_mib * 1024 * 1024,
          maxRows: config.data.quality_ts_max_rows,
        });

        const api = new ApiServer({
          config,
          repository,
          runGovernor: governor,
          modelProfiles,
          token,
          artifactsRoot: paths.workspacesDir,
          onStateChange: persist,
          toolRegistry: createDefaultToolRegistry(),
          toolServices: {
            workspace,
            aggregation,
            workspacesDir: paths.workspacesDir,
            limits: {
              max_bytes: config.data.max_upload_mib * 1024 * 1024,
              max_rows: config.data.quality_ts_max_rows,
              preview_rows: config.data.preview_rows,
              model_sample_rows: config.data.model_sample_rows,
              model_sample_cell_chars: config.data.model_sample_cell_chars,
            },
          },
          agentLimits: { max_turns: config.runtime.agent_max_turns },
        });
        await api.start();
        const addr = api.address;
        console.log(
          `产品 API 已监听 http://${addr?.host ?? config.server.host}:${addr?.port ?? config.server.port}/api/v1`,
        );

        let closing = false;
        const shutdown = async (): Promise<void> => {
          if (closing) return;
          closing = true;
          console.log('优雅关闭：停止监听并落盘状态…');
          await api.stop();
          await persist().catch(() => undefined);
          process.exit(0);
        };
        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
        // 周期落盘（30s，不阻塞退出）
        const timer = setInterval(() => void persist().catch(() => undefined), 30_000);
        timer.unref();
        return;
      }

      const bin = resolveDshBin();
      const args = buildDshLaunchArgs(config);
      console.log(`启动 DSH: ${bin} ${args.join(' ')}`);
      const child = spawnDsh(bin, args);
      await new Promise<void>((fulfil) => {
        child.once('exit', (code) => {
          process.exitCode = code ?? 1;
          fulfil();
        });
        child.once('error', () => {
          process.exitCode = 1;
          fulfil();
        });
      });
    });
}
