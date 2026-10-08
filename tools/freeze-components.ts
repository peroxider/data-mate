import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// W6 组件冻结:把五个固定版本组件安装进隔离 profile(§21/计划 D4),
// 记录精确版本、integrity 哈希、peer deps、依赖树与工具清单。
// 断言 genui 必须为 scoped 包(npm 上无 scope 的 dsh-genui 是仿冒包)。
// VERIFIED 字段一律来自真实安装与注册表证据;不可得字段如实标注,绝不伪造。
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url)); // tools/
const repoRoot = resolve(here, '..');
const profileDir = join(repoRoot, '.m0', 'profile');
const compatDir = join(repoRoot, 'compat');

const FROZEN = [
  { key: 'dsh', pkg: '@deepseek-ai/dsh', version: '0.2.0-rc.2' },
  { key: 'dsh_notebook', pkg: '@beihaizb/dsh-notebook', version: '0.2.4' },
  { key: 'dsh_data_quality', pkg: 'dsh-data-quality', version: '0.3.18' },
  { key: 'dsh_data_agent', pkg: '@yejiming/dsh-data-agent', version: '0.2.2' },
  { key: 'dsh_genui', pkg: '@changfenhuang/dsh-genui', version: '0.11.4' },
] as const;

interface FrozenSpec {
  key: string;
  pkg: string;
  version: string;
}

function run(cmd: string, args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  // maxBuffer 需覆盖 `pnpm ls --depth Infinity` 的大输出(默认 1MB 会 ENOBUFS)
  const proc = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false, maxBuffer: 256 * 1024 * 1024 });
  if (proc.error) {
    throw new Error(`${cmd} 启动失败: ${proc.error.message}`);
  }
  return { status: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/** 防仿冒断言:所有 dsh-genui 引用必须是 @changfenhuang/dsh-genui。 */
function assertScopedGenui(): void {
  for (const spec of FROZEN) {
    if (spec.pkg === 'dsh-genui') {
      throw new Error('检测到无 scope 的 dsh-genui(仿冒包),中止冻结');
    }
  }
  const genui = FROZEN.find((spec) => spec.key === 'dsh_genui');
  if (!genui || genui.pkg !== '@changfenhuang/dsh-genui') {
    throw new Error('dsh_genui 必须固定为 scoped 包 @changfenhuang/dsh-genui');
  }
}

function prepareProfile(): void {
  mkdirSync(profileDir, { recursive: true });
  const pkgFile = join(profileDir, 'package.json');
  if (!existsSync(pkgFile)) {
    writeFileSync(
      pkgFile,
      `${JSON.stringify({ name: 'data-analysis-m0-profile', private: true, version: '0.0.0' }, null, 2)}\n`,
      'utf8',
    );
  }
}

function installFrozen(specs: FrozenSpec[]): void {
  const add = run(
    'pnpm',
    ['add', '--save-exact', ...specs.map((spec) => `${spec.pkg}@${spec.version}`)],
    profileDir,
  );
  if (add.status !== 0) {
    throw new Error(`pnpm add 失败(退出码 ${add.status}):\n${add.stderr.slice(0, 2000)}`);
  }
}

interface PkgManifest {
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: Record<string, string> | string;
}

function readInstalled(spec: FrozenSpec): { manifest: PkgManifest; dir: string } {
  const dir = join(profileDir, 'node_modules', spec.pkg);
  const manifestFile = join(dir, 'package.json');
  if (!existsSync(manifestFile)) {
    throw new Error(`安装后未找到 ${spec.pkg} 的 package.json`);
  }
  return { manifest: JSON.parse(readFileSync(manifestFile, 'utf8')) as PkgManifest, dir };
}

/** 优先从 profile 的 pnpm-lock.yaml 读 integrity(离线);读不到时回退 npm view。 */
function integrityFor(spec: FrozenSpec): string {
  const lockFile = join(profileDir, 'pnpm-lock.yaml');
  if (existsSync(lockFile)) {
    const lock = yaml.load(readFileSync(lockFile, 'utf8')) as {
      packages?: Record<string, { resolution?: { integrity?: string } }>;
    };
    const lockKey = Object.keys(lock.packages ?? {}).find((key) =>
      key.startsWith(`${spec.pkg.replace('/', '+')}@${spec.version}`),
    );
    const integrity = lockKey ? lock.packages?.[lockKey]?.resolution?.integrity : undefined;
    if (integrity) return integrity;
  }
  const view = run('npm', ['view', `${spec.pkg}@${spec.version}`, 'dist.integrity'], repoRoot);
  if (view.status !== 0) {
    throw new Error(`无法取得 ${spec.pkg} integrity: ${view.stderr.slice(0, 300)}`);
  }
  return view.stdout.trim().replace(/^'|'$/g, '');
}

function detectPlatform(): string {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  return `${process.platform}-${arch}`;
}

function gitCommit(): string {
  const git = run('git', ['rev-parse', 'HEAD'], repoRoot);
  return git.status === 0 ? git.stdout.trim() : 'unversioned-working-tree';
}

function pythonVersion(): string {
  for (const py of ['python3', 'python']) {
    const probe = run(py, ['--version'], repoRoot);
    if (probe.status === 0) {
      return probe.stdout.trim().replace(/^Python\s*/i, '') || probe.stderr.trim().replace(/^Python\s*/i, '');
    }
  }
  throw new Error('未找到 Python 解释器,无法记录 runtime.python');
}

// ---------------------------------------------------------------------------
// 工具清单:静态正则扫描(仅静态,不启动 profile;确认在 W7)。
// ---------------------------------------------------------------------------

const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

function walkScripts(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.bin' || entry.name === 'node_modules') continue;
      walkScripts(full, out, depth + 1);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name) && statSync(full).size <= MAX_SCAN_FILE_BYTES) {
      out.push(full);
    }
  }
  return out;
}

function scanToolNames(spec: FrozenSpec, dir: string): { tools: string[]; files_scanned: number } {
  const patterns = [
    /defineTool\s*\(\s*[\s\S]{0,160}?name\s*:\s*['"]([a-zA-Z][a-zA-Z0-9_]{2,48})['"]/g,
    /\bnb_[a-z][a-z0-9_]{2,40}\b/g,
    /\bdata_(?:profile|clean|verify|report)\b/g,
    /\b(?:render_ui|validate_dsh_ui)\b/g,
  ];
  const found = new Set<string>();
  let files = 0;
  for (const file of walkScripts(dir)) {
    files += 1;
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        found.add(match[1] ?? match[0]);
      }
    }
  }
  return { tools: [...found].sort(), files_scanned: files };
}

async function main(): Promise<void> {
  assertScopedGenui();
  prepareProfile();

  console.log('冻结五组件到隔离 profile:', profileDir);
  installFrozen(FROZEN.map((spec) => ({ ...spec })));

  const cliPkg = require('../apps/cli/package.json') as { version: string };
  const components: Record<string, unknown> = {};
  const inventoryComponents: Record<string, unknown> = {};

  for (const spec of FROZEN) {
    const { manifest, dir } = readInstalled(spec);
    const installed = manifest.version ?? '';
    if (installed !== spec.version) {
      throw new Error(`${spec.pkg} 安装版本 ${installed} 与冻结目标 ${spec.version} 不一致`);
    }
    const integrity = integrityFor(spec);
    components[spec.key] = {
      package: spec.pkg,
      version: installed,
      integrity,
      peer_dependencies: manifest.peerDependencies ?? {},
      dependencies: manifest.dependencies ?? {},
      source_commit: 'not_published_in_registry_metadata',
      resolved_from: 'npm registry(pnpm 安装 + lockfile integrity)',
    };
    const scan = scanToolNames(spec, dir);
    inventoryComponents[spec.key] = {
      package: spec.pkg,
      version: installed,
      method: 'static-regex-scan(仅静态;运行时确认在 W7 verify-contracts)',
      files_scanned: scan.files_scanned,
      candidate_tools: scan.tools,
      runtime_confirmed: 'pending-W7',
    };
    console.log(`  ✔ ${spec.pkg}@${installed} integrity=${integrity.slice(0, 20)}… 工具候选 ${scan.tools.length} 个`);
  }

  const tree = run('pnpm', ['ls', '--json', '--depth', 'Infinity'], profileDir);
  if (tree.status !== 0) {
    throw new Error(`pnpm ls 失败: ${tree.stderr.slice(0, 500)}`);
  }

  const lock = {
    schema_version: 1,
    release: `data-analyst-${cliPkg.version}`,
    platform: detectPlatform(),
    application: { version: cliPkg.version, commit: gitCommit() },
    components,
    runtime: { node: process.versions.node, python: pythonVersion() },
    locks: {
      javascript: '.m0/profile/pnpm-lock.yaml',
      python: 'python/analyst_runtime 无运行时依赖(M0)',
    },
    verification: {
      compatibility_report: 'compat/compatibility.json (pending-W7)',
      offline_report: 'compat/offline-verification.json (pending-W7)',
    },
    frozen_at: new Date().toISOString(),
    frozen_by: `pnpm freeze (pnpm ${run('pnpm', ['--version'], repoRoot).stdout.trim()})`,
    profile_dir: '.m0/profile',
    profile_name: 'data-analysis-m0',
  };

  mkdirSync(compatDir, { recursive: true });
  writeFileSync(join(compatDir, 'components.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(compatDir, 'dependency-tree.json'),
    `${JSON.stringify({ generated_at: lock.frozen_at, profile: lock.profile_name, tree: JSON.parse(tree.stdout) }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(compatDir, 'tool-inventory.json'),
    `${JSON.stringify({ generated_at: lock.frozen_at, components: inventoryComponents }, null, 2)}\n`,
    'utf8',
  );

  console.log('已生成 compat/components.lock.json、compat/dependency-tree.json、compat/tool-inventory.json');
}

main().catch((error: unknown) => {
  console.error(`freeze 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
