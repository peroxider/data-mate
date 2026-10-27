import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// profile 的 pnpm workspace 配置(两个消费方共用,保证 freeze 与 profile:assemble 同源):
// 1. pnpm 10+ 默认拦截依赖 install 脚本(ERR_PNPM_IGNORED_BUILDS 使 pnpm add 退出 1),
//    node-pty/koffi 等原生模块不经脚本无法就位,必须登记审批;
// 2. tools/runtime-patches.ts 按 node_modules/<pkg> 直连补丁目标(documentpreview 是
//    dsh 的传递依赖),需要 hoisted 布局 —— 这也是 dsh 内置 profile 模板自己的约定。
// pnpm v11 把 onlyBuiltDependencies 更名为 allowBuilds(map),写 package.json 的
// pnpm 字段自 v11 起不再读取;按实际运行的 pnpm 大版本选择方言。
// ---------------------------------------------------------------------------

export const BUILD_SCRIPT_PACKAGES = [
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs',
] as const;

/** 以目标目录为 cwd 探测 pnpm 大版本:corepack 会按最近 package.json 的
 * packageManager 解析,仓库内与 profile 目录解析出的版本可能不同,
 * 而消费 workspace 配置的正是从目标目录解析出的那个 pnpm。 */
export function detectPnpmMajor(cwd: string): number {
  const proc = spawnSync('pnpm', ['--version'], { cwd, encoding: 'utf8', shell: false });
  const major = Number.parseInt((proc.stdout ?? '').trim().split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major <= 0) {
    throw new Error(`无法解析 pnpm 版本: ${`${proc.stdout ?? ''} ${proc.stderr ?? ''}`.trim()}`);
  }
  return major;
}

/** 构建脚本审批块;pnpm v11+ 为 allowBuilds 映射,v10 为 onlyBuiltDependencies 列表。 */
export function approvalsBlock(pnpmMajor: number): string {
  if (pnpmMajor >= 11) {
    return `allowBuilds:\n${BUILD_SCRIPT_PACKAGES.map((name) => `  '${name}': true`).join('\n')}\n`;
  }
  return `onlyBuiltDependencies:\n${BUILD_SCRIPT_PACKAGES.map((name) => `  - '${name}'`).join('\n')}\n`;
}

/** freeze 用:独立 workspace 文件全文(仅在目标不存在时整体写入)。 */
export function standaloneWorkspaceYaml(pnpmMajor: number): string {
  return ['packages:', '  - .', 'nodeLinker: hoisted', '', approvalsBlock(pnpmMajor)].join('\n');
}

/** assemble 用:向 dsh 模板生成的 pnpm-workspace.yaml 幂等追加审批块(不碰模板其余设置)。 */
export function ensureApprovalsInWorkspaceYaml(file: string, pnpmMajor: number): 'written' | 'skipped' {
  const text = readFileSync(file, 'utf8');
  if (/^(allowBuilds|onlyBuiltDependencies):/m.test(text)) return 'skipped';
  appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}${approvalsBlock(pnpmMajor)}`);
  return 'written';
}
