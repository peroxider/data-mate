import type { Command } from 'commander';
import { loadProductConfig } from '@data-analyst/core';
import { buildDshLaunchArgs, resolveDshBin, spawnDsh } from '@data-analyst/dsh-integration';

// ---------------------------------------------------------------------------
// W5 serve:M0 桩 —— 校验配置;仅当显式传入 --dsh 时受控启动本地 DSH
// (argv 数组 + shell:false,见 dsh-integration)。绝不下载、绝不安装。
// ---------------------------------------------------------------------------

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('M0 桩:校验配置;--dsh 时受控启动本地 DSH')
    .requiredOption('--config <file>', '配置 YAML 路径')
    .option('--dsh', '受控启动本地 DSH(需要环境中已安装)')
    .action(async (options: { config: string; dsh?: boolean }) => {
      const config = loadProductConfig({ configFile: options.config });
      if (!options.dsh) {
        console.log(
          `配置有效 (profile=${config.runtime.profile})。M0 serve 桩:传入 --dsh 以受控启动本地 DSH。`,
        );
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
