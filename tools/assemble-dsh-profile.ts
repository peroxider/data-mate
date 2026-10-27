import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRuntimePatches } from './runtime-patches.js';
import { detectPnpmMajor, ensureApprovalsInWorkspaceYaml } from './profile-workspace.js';

// ---------------------------------------------------------------------------
// 组装产品 DSH profile(部署第 5 步):全部走 dsh 官方 CLI,不经 npx、不绕过
// profile 结构 —— 与 .m0/profile(freeze 的裸 pnpm add 路径)互补:
//   1. dsh <name> --from-default-profile web   从内置 web 模板初始化(--dump-config 立即退出)
//   2. 向模板生成的 pnpm-workspace.yaml 追加构建脚本审批(与 freeze 同源)
//   3. dsh plugin --profile <name> add <pkg>@<精确版本> 逐个注册五组件;
//      peer 门禁拒绝时按提示 allow-version 精确版本豁免后重试(notebook 实测需要)
//   4. 自愈校验:dsh.profile.bundles 必须包含四个插件(实测批量 add 中断重试会丢 bundle 登记)
//   5. 安装品牌插件(packaging/brand,logo/侧边栏名/首屏标题的槽位覆盖)并登记 patch 层
//   6. 应用 runtime-patches 兼容层(含品牌文案补丁),--dump-config 验证组合树,.bin/dsh 就位
// 启动必须用 profile 内 CLI(README FAQ:dsh-app-boot 双实例问题)。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url)); // tools/
const repoRoot = resolve(here, '..');

interface FrozenComponent {
  package: string;
  version: string;
}

interface Args {
  name: string;
  home?: string;
  dsh?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { name: 'data-analysis-m0' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') args.name = argv[++i] ?? '';
    else if (argv[i] === '--home') args.home = argv[++i] ?? '';
    else if (argv[i] === '--dsh') args.dsh = argv[++i] ?? '';
    else throw new Error(`未知参数: ${argv[i]}(支持 --name/--home/--dsh)`);
  }
  if (!args.name) throw new Error('--name 不能为空');
  return args;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', shell: false, maxBuffer: 256 * 1024 * 1024, env });
  if (proc.error) throw new Error(`${cmd} 启动失败: ${proc.error.message}`);
  return { status: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

function resolveDshBinary(args: Args): string {
  if (args.dsh) return resolve(args.dsh);
  const frozen = join(repoRoot, '.m0', 'profile', 'node_modules', '.bin', 'dsh');
  if (existsSync(frozen)) return frozen;
  const onPath = spawnSync('dsh', ['--version'], { encoding: 'utf8', shell: false });
  if (onPath.status === 0) return 'dsh';
  throw new Error('未找到 dsh 二进制:先运行 pnpm freeze 生成 .m0/profile,或用 --dsh <路径> 指定');
}

/** 品牌定制(logo/名称/标语/标题)固化:插件源码随仓库分发,装进 profile 的
 * local/ 并以 file: 依赖登记;侧边栏与首屏槽位覆盖经 cordis.patch.yml 注册
 * (新增条目必须用 insert: 语法,裸 id+name 只对已存在条目生效,见 README FAQ)。
 * 文案补丁(hero 标语/页面标题/manifest)由 applyRuntimePatches 的品牌条目负责。
 * 幂等:插件目录、依赖登记、patch 登记各自存在即跳过。 */
function installBrandPlugin(profileDir: string, env: NodeJS.ProcessEnv): void {
  const source = join(repoRoot, 'packaging', 'brand', 'dsh-brand-analyst');
  if (!existsSync(join(source, 'package.json'))) throw new Error(`缺少品牌插件源码: ${source}(应随仓库分发)`);
  const pluginDir = join(profileDir, 'local', 'dsh-brand-analyst');
  if (!existsSync(pluginDir)) {
    cpSync(source, pluginDir, { recursive: true });
    console.log('  品牌插件 → local/dsh-brand-analyst');
  }

  const pkgFile = join(profileDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { dependencies?: Record<string, string> };
  if (pkg.dependencies?.['dsh-brand-analyst'] === undefined) {
    pkg.dependencies = { ...pkg.dependencies, 'dsh-brand-analyst': 'file:./local/dsh-brand-analyst' };
    writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    console.log('  已登记依赖 dsh-brand-analyst(file:./local/dsh-brand-analyst)');
  }

  const patchFile = join(profileDir, 'cordis.patch.yml');
  let patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
  if (!patchText.includes('ui-brand-analyst')) {
    // 模板给出的是注释 + 空数组 `[]`(注释行导致 trim()==='[]' 永不成立);
    // 追加块级条目前必须去掉 `[]` 行,否则 flow 序列后跟块序列是非法 YAML。
    patchText = patchText.replace(/^\s*\[\]\s*$/m, '').replace(/\s*$/, '');
    const entries = [
      ...(patchText.includes('ui-brand-official') ? [] : ['- id: ui-brand-official\n  disabled: true']),
      '- insert:\n    - id: ui-brand-analyst\n      name: dsh-brand-analyst',
    ].join('\n');
    writeFileSync(patchFile, `${patchText}\n${entries}\n`, 'utf8');
    console.log('  cordis.patch.yml 已登记品牌槽位覆盖(并停用 ui-brand-official)');
  }

  const install = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], { cwd: profileDir, encoding: 'utf8', shell: false, maxBuffer: 256 * 1024 * 1024, env });
  if (install.status !== 0) throw new Error(`品牌依赖安装失败(profile 内 pnpm install):\n${(install.stderr || install.stdout).slice(-2000)}`);
  console.log('  profile 内 pnpm install 完成(品牌插件就位)');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lockFile = join(repoRoot, 'compat', 'components.lock.json');
  if (!existsSync(lockFile)) throw new Error('缺少 compat/components.lock.json,先运行 pnpm freeze');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as { components: Record<string, FrozenComponent> };
  const components = Object.values(lock.components);
  const dshRuntime = components.find((c) => c.package === '@deepseek-ai/dsh');
  const plugins = components.filter((c) => c.package !== '@deepseek-ai/dsh');
  if (!dshRuntime || plugins.length !== 4) {
    throw new Error('components.lock.json 应包含 dsh 本体 + 四个插件,当前结构异常');
  }

  const dshBin = resolveDshBinary(args);
  const home = args.home ? resolve(args.home) : join(homedir(), '.dsh');
  const profileDir = join(home, 'profiles', args.name);
  if (existsSync(profileDir)) {
    throw new Error(`profile 已存在: ${profileDir}(换 --name,或确认后手动删除重装)`);
  }
  const env = { ...process.env, DSH_HOME: home };

  console.log(`[1/6] 从内置 web 模板初始化 profile: ${profileDir}(引导: ${dshBin})`);
  const created = run(dshBin, [args.name, '--from-default-profile', 'web', '--dump-config'], env);
  if (created.status !== 0) {
    throw new Error(`profile 初始化失败:\n${(created.stderr || created.stdout).slice(-2000)}`);
  }

  console.log('[2/6] 登记依赖构建脚本审批(pnpm 默认拦截会使安装退出 1)');
  const wsFile = join(profileDir, 'pnpm-workspace.yaml');
  if (!existsSync(wsFile)) throw new Error('模板未生成 pnpm-workspace.yaml,dsh 行为异常');
  console.log(`  审批登记: ${ensureApprovalsInWorkspaceYaml(wsFile, detectPnpmMajor(profileDir))}`);
  // 模板设 autoInstallPeers:false,但 dsh-app-boot 的 peer(cordis-plugin-group 等)
  // 运行时必需,实测缺失即启动崩(ERR_MODULE_NOT_FOUND);开启后与 freeze 路径语义一致。
  const wsText = readFileSync(wsFile, 'utf8');
  if (/^autoInstallPeers:\s*false$/m.test(wsText)) {
    writeFileSync(wsFile, wsText.replace(/^autoInstallPeers:\s*false$/m, 'autoInstallPeers: true'), 'utf8');
    console.log('  autoInstallPeers: false → true(补齐 dsh-app-boot 运行时 peer)');
  }

  console.log('[3/6] 逐个安装五组件(dsh plugin add,peer 门禁拒绝时自动豁免重试)');
  for (const comp of [dshRuntime, ...plugins]) {
    const pin = `${comp.package}@${comp.version}`;
    const addArgs = ['plugin', '--profile', args.name, 'add', pin];
    let added = run(dshBin, addArgs, env);
    if (added.status !== 0 && /allow-version/.test(`${added.stderr}${added.stdout}`)) {
      console.log(`  peer 门禁拒绝 ${pin},登记精确版本豁免后重试`);
      const allow = run(dshBin, [
        'plugin', '--profile', args.name, 'allow-version', pin,
        '--dsh-version', dshRuntime.version, '--accept-risk',
      ], env);
      if (allow.status !== 0) {
        throw new Error(`豁免登记失败:\n${(allow.stderr || allow.stdout).slice(-2000)}`);
      }
      added = run(dshBin, addArgs, env);
    }
    if (added.status !== 0) {
      throw new Error(`安装 ${pin} 失败:\n${(added.stderr || added.stdout).slice(-2000)}`);
    }
    console.log(`  ✔ ${pin}`);
  }

  console.log('[4/6] 校验 bundles 完整性(缺失则自愈补登)');
  const pkgFile = join(profileDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
    dsh: { profile: { bundles: string[] } };
  };
  const bundles = pkg.dsh.profile.bundles;
  const missing = plugins.filter((p) => !bundles.includes(p.package)).map((p) => p.package);
  if (missing.length > 0) {
    bundles.push(...missing);
    writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    console.log(`  补登 bundles: ${missing.join(', ')}`);
  }

  installBrandPlugin(profileDir, env);

  console.log('[6/6] 应用 runtime-patches 兼容层并验证组合树');
  const patched = applyRuntimePatches(profileDir, true);
  console.log(`  补丁目标 ${patched.length} 个,其中变化 ${patched.filter((p) => p.changed).length} 个`);
  const dump = run(dshBin, [args.name, '--dump-config'], env);
  if (dump.status !== 0) {
    throw new Error(`组合树验证失败(--dump-config 非零退出):\n${(dump.stderr || dump.stdout).slice(-2000)}`);
  }
  const cli = join(profileDir, 'node_modules', '.bin', 'dsh');
  if (!existsSync(cli)) throw new Error('profile 内缺少 node_modules/.bin/dsh,无法按纪律引导');

  console.log(`\n产品 profile 组装完成: ${profileDir}`);
  console.log('启动(必须用 profile 内 CLI;带随机 token 的访问链接打印在日志首行):');
  // 自定义 DSH_HOME 时引导也要带同名变量,否则 dsh 仍按 ~/.dsh 找 profile(实测报 profile does not exist)。
  const homePrefix = args.home ? `DSH_HOME=${profileDir.replace(/\/profiles\/[^/]+$/, '')} ` : '';
  console.log(`  ${homePrefix}nohup ${cli} --profile ${args.name} --no-open --host 127.0.0.1 --port 8081 > dsh-web.log 2>&1 &`);
}

main().catch((error: unknown) => {
  console.error(`profile:assemble 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
