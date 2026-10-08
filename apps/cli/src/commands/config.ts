import type { Command } from 'commander';
import { loadProductConfig, resolveConfigDir, resolvePaths } from '@data-analyst/core';

// ---------------------------------------------------------------------------
// W5 config validate:YAML → 合并 → zod 严格校验(§18),失败输出
// CONFIG_INVALID 负载 JSON 并以非零码退出。
// ---------------------------------------------------------------------------

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('产品配置工具(§18)');

  config
    .command('validate')
    .description('校验配置文件(内置默认 → 文件 → 固定环境变量 → zod)')
    .requiredOption('--config <file>', '配置 YAML 路径')
    .option('--json', '输出结构化 JSON')
    .action((options: { config: string; json?: boolean }) => {
      const product = loadProductConfig({ configFile: options.config });
      const paths = resolvePaths(product, resolveConfigDir(options.config));
      const summary = {
        ok: true,
        schema_version: product.schema_version,
        server: `${product.server.host}:${product.server.port}`,
        runtime_profile: product.runtime.profile,
        data_dir: paths.dataDir,
        state_dir: paths.stateDir,
        cache_dir: paths.cacheDir,
      };
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`✔ 配置有效: ${summary.server} (profile=${summary.runtime_profile})`);
      }
    });
}
