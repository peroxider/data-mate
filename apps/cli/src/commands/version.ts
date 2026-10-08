import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// W5 version:离线 BOM 摘要。读取组件锁(§21)但不发起任何网络请求。
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url)); // dist/commands/

interface ComponentsLock {
  schema_version?: number;
  frozen_at?: string;
  components?: Record<string, { version: string }>;
}

function readComponentsLock(): ComponentsLock | null {
  const lockPath = resolve(here, '..', '..', '..', '..', 'compat', 'components.lock.json');
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as ComponentsLock;
  } catch {
    return null;
  }
}

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('离线 BOM 版本摘要')
    .option('--json', '输出 JSON')
    .action((options: { json?: boolean }) => {
      const pkg = require('../../package.json') as { name: string; version: string };
      const lock = readComponentsLock();
      const summary = {
        name: pkg.name,
        version: pkg.version,
        node: process.version,
        components: lock?.components ?? null,
        frozen_at: lock?.frozen_at ?? null,
      };
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`${summary.name} ${summary.version} (node ${summary.node})`);
      }
    });
}
