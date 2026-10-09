import type { Command } from 'commander';
import {
  InMemoryRepository,
  ModelProfileService,
  probeModelProfile,
  loadProductConfig,
  resolvePaths,
  resolveConfigDir,
} from '@data-analyst/core';

// ---------------------------------------------------------------------------
// §17 CLI：test-model —— 测试配置的外部模型服务，能力状态结构化输出。
// 只读探测，不修改生产状态；探测失败退出码 1。
// ---------------------------------------------------------------------------

export function registerM5Commands(program: Command): void {
  program
    .command('test-model')
    .description('测试配置的外部模型服务（分层能力探测：网络/认证/Chat/流式/工具调用）')
    .requiredOption('--config <file>', '配置 YAML 路径')
    .option('--profile <id>', '指定 ModelProfile（默认取配置 model.profile_id）')
    .action(async (options: { config: string; profile?: string }) => {
      const config = loadProductConfig({ configFile: options.config });
      const paths = resolvePaths(config, resolveConfigDir(options.config));

      // 快照中已有版本化 profile 为权威；YAML model 块仅在缺失时导入（§18）
      const repository = new InMemoryRepository();
      await repository.restoreFrom(paths.productStateFile).catch(() => undefined);
      const service = new ModelProfileService({ repository });
      await service.importFromYamlIfAbsent(config);

      const profileId = options.profile ?? config.model?.profile_id;
      if (!profileId) {
        console.error('未指定模型配置：配置缺少 model 块，也未传 --profile');
        process.exitCode = 1;
        return;
      }
      const profile = await service.get(profileId);
      if (!profile) {
        console.error(`ModelProfile 不存在: ${profileId}`);
        process.exitCode = 1;
        return;
      }

      const credential = await service.resolveCredential(profile);
      const result = await probeModelProfile({ profile, credential });
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'failed') {
        process.exitCode = 1;
      }
    });
}
