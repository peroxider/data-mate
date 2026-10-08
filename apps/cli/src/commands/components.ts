import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// W5 components:lock 委托给 tools/freeze-components.ts(W6 已交付);
// verify 属 W7 契约验证,CLI 层诚实报告未实现,绝不伪造。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url)); // dist/commands/

function stub(action: string): never {
  console.error(`components ${action} 尚未实现:由 tools/verify-contracts.ts 提供(W7 计划项)`);
  process.exitCode = 1;
  throw new Error(`components ${action} 未实现(W7)`);
}

export function registerComponentsCommand(program: Command): void {
  const components = program
    .command('components')
    .description('组件冻结与校验(lock 已交付;verify 在 W7)');

  components
    .command('lock')
    .description('把五个固定版本组件安装进隔离 profile 并生成 compat/components.lock.json(委托 W6 freeze)')
    .action(() => {
      const freeze = resolve(here, '..', '..', '..', '..', 'tools', 'freeze-components.ts');
      const proc = spawnSync('tsx', [freeze], { stdio: 'inherit', shell: false });
      if (proc.status !== 0) process.exitCode = proc.status ?? 1;
    });

  components
    .command('verify')
    .description('校验组件锁完整性(W6)')
    .action(() => stub('verify'));
}
