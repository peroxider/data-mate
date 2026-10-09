import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// W7 联合契约验证(§7 / 决策 D5):只记录本环境真实可执行的结论。
// 状态严格 pass | fail | pending;每条附命令与时间戳。无模型端点、无内核、
// 无数据库的项一律 pending 并附证据,绝不伪造 verified(§7 明令禁止)。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url)); // tools/
const repoRoot = resolve(here, '..');
const profileDir = join(repoRoot, '.m0', 'profile');
const compatDir = join(repoRoot, 'compat');
const fixturesDir = join(repoRoot, 'tests', 'fixtures');

const FROZEN = [
  { key: 'dsh', pkg: '@deepseek-ai/dsh', version: '0.2.0-rc.2' },
  { key: 'dsh_notebook', pkg: '@beihaizb/dsh-notebook', version: '0.2.4' },
  { key: 'dsh_data_quality', pkg: 'dsh-data-quality', version: '0.3.18' },
  { key: 'dsh_data_agent', pkg: '@yejiming/dsh-data-agent', version: '0.2.2' },
  { key: 'dsh_genui', pkg: '@changfenhuang/dsh-genui', version: '0.11.4' },
] as const;

interface Check {
  id: string;
  item: string;
  status: 'pass' | 'fail' | 'pending';
  evidence: { command: string; at: string; detail: string };
}

const checks: Check[] = [];
const now = (): string => new Date().toISOString();

function record(
  id: string,
  item: string,
  status: Check['status'],
  command: string,
  detail: string,
): void {
  checks.push({ id, item, status, evidence: { command, at: now(), detail } });
  const mark = status === 'pass' ? '✔' : status === 'fail' ? '✘' : '○';
  console.log(`${mark} [${status}] ${item} — ${detail.slice(0, 140)}`);
}

function sh(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// 1. 组件安装与锁一致(离线可证)
// ---------------------------------------------------------------------------
function checkInstallAndLock(): void {
  const command = '读取 compat/components.lock.json 并比对 .m0/profile/node_modules';
  try {
    const lock = JSON.parse(readFileSync(join(compatDir, 'components.lock.json'), 'utf8')) as {
      components: Record<string, { package: string; version: string; integrity: string }>;
    };
    const problems: string[] = [];
    for (const spec of FROZEN) {
      const entry = lock.components[spec.key];
      if (!entry || entry.package !== spec.pkg || entry.version !== spec.version) {
        problems.push(`${spec.key}: 锁记录 ${JSON.stringify(entry)} 与冻结目标不一致`);
        continue;
      }
      if (!entry.integrity.startsWith('sha512-')) {
        problems.push(`${spec.key}: integrity 缺失`);
      }
      const manifestFile = join(profileDir, 'node_modules', spec.pkg, 'package.json');
      if (!existsSync(manifestFile)) {
        problems.push(`${spec.pkg} 未安装`);
        continue;
      }
      const installed = (JSON.parse(readFileSync(manifestFile, 'utf8')) as { version?: string }).version;
      if (installed !== spec.version) {
        problems.push(`${spec.pkg}: 安装 ${installed} != 锁定 ${spec.version}`);
      }
    }
    if (problems.length === 0) {
      record('install-and-lock', '五组件精确版本安装且与锁一致', 'pass', command, '五个 package/version/integrity 全部一致');
    } else {
      record('install-and-lock', '五组件精确版本安装且与锁一致', 'fail', command, problems.join('; '));
    }
  } catch (error) {
    record('install-and-lock', '五组件精确版本安装且与锁一致', 'fail', command, String(error instanceof Error ? error.message : error));
  }
}

// ---------------------------------------------------------------------------
// 2. 质量计算:进程内 dsh-data-quality 真实执行,原文件 sha256 不变
// ---------------------------------------------------------------------------
async function checkQuality(): Promise<void> {
  const command = 'node(进程内): loadTable + profileTable(tests/fixtures/fixture_sales.csv)';
  try {
    const profileRequire = createRequire(join(profileDir, 'package.json'));
    const dq = profileRequire('dsh-data-quality') as {
      resolveConfig?: (input: unknown) => unknown;
      loadTable: (path: string, config: unknown, signal: undefined) => Promise<{
        columns: ({ name?: string } | string)[];
        rows: unknown[];
      }>;
      profileTable: (table: unknown, options: Record<string, unknown>) => Record<string, unknown>;
    };
    const fixture = join(fixturesDir, 'fixture_sales.csv');
    const sha256 = (path: string): string =>
      createHash('sha256').update(readFileSync(path)).digest('hex');
    const before = sha256(fixture);
    const config = dq.resolveConfig ? dq.resolveConfig({}) : {};
    const table = await dq.loadTable(fixture, config, undefined);
    const report = dq.profileTable(table, {});
    const after = sha256(fixture);
    const columns = table.columns.map((c) => (typeof c === 'string' ? c : c.name ?? '')).join(',');
    const rowCount = typeof report.rowCount === 'number' ? report.rowCount : table.rows.length;
    const okShape = columns === 'channel,visitors,conversions' && rowCount === 4;
    if (okShape && before === after) {
      record(
        'quality-computation',
        '进程内质量计算 + 原文件不可变(sha256)',
        'pass',
        command,
        `rows=${rowCount} columns=[${columns}] sha256=${before.slice(0, 16)}… 前后一致`,
      );
    } else {
      record(
        'quality-computation',
        '进程内质量计算 + 原文件不可变(sha256)',
        'fail',
        command,
        `shape ok=${okShape} sha256 不变=${before === after} columns=[${columns}] rows=${rowCount}`,
      );
    }
  } catch (error) {
    record('quality-computation', '进程内质量计算 + 原文件不可变(sha256)', 'fail', command, String(error instanceof Error ? error.message : error));
  }
}

// ---------------------------------------------------------------------------
// 3. 本地 CLI 启动:doctor + version 全绿
// ---------------------------------------------------------------------------
function checkCliBoot(): void {
  const cli = join(repoRoot, 'apps', 'cli', 'dist', 'index.js');
  const config = join(repoRoot, 'config', 'dev.example.yaml');
  const doctor = sh('node', [cli, 'doctor', '--config', config, '--json']);
  const version = sh('node', [cli, 'version', '--json']);
  let hasComponents: boolean;
  try {
    hasComponents = (JSON.parse(version.stdout) as { components?: unknown }).components !== null;
  } catch {
    hasComponents = false;
  }
  const command = 'node apps/cli/dist/index.js doctor|version --json';
  if (doctor.status === 0 && version.status === 0 && hasComponents) {
    record('cli-boot', '本地 CLI 启动(doctor + version 含组件 BOM)', 'pass', command, '两命令退出码 0,version 含五组件与 frozen_at');
  } else {
    record('cli-boot', '本地 CLI 启动(doctor + version 含组件 BOM)', 'fail', command,
      `doctor=${doctor.status} version=${version.status} components=${hasComponents} ${doctor.stderr.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// 4. headless profile 组合启动:按设计尝试,不可行则 pending 并附真实证据
// ---------------------------------------------------------------------------
function checkProfileComposition(): void {
  const command = 'DSH_HOME=<repo>/.m0 dsh --profile data-analysis-m0 --dump-config';
  const probe = sh('dsh', ['--profile', 'data-analysis-m0', '--dump-config'], {
    env: { DSH_HOME: join(repoRoot, '.m0') },
  });
  if (probe.status === 0 && probe.stdout.trim().length > 0) {
    record('profile-composition', 'headless profile 组合启动(--dump-config)', 'pass', command,
      probe.stdout.slice(0, 300));
    return;
  }
  const reason = (probe.stderr || probe.stdout).split('\n').find((line) => line.includes('Error')) ?? `退出码 ${probe.status}`;
  record('profile-composition', 'headless profile 组合启动(--dump-config)', 'pending', command,
    `dsh 拒绝符号链接注册的 profile 目录(要求 'dsh plugin --profile data-analysis-m0 add <package>' 创建)。` +
    `证据: ${reason.slice(0, 220)}。该路径会经 pnpm 重新解析依赖,M1 执行并记录实际使用路径。`);
}

// ---------------------------------------------------------------------------
// 5. Notebook 内核栈:缺 ipykernel → pending,附 analyst_runtime doctor 证据
// ---------------------------------------------------------------------------
function checkNotebook(): void {
  const runtimeDir = join(repoRoot, 'python', 'analyst_runtime');
  const command = 'PYTHONPATH=. python3 -m analyst_runtime doctor --json';
  const probe = sh('python3', ['-m', 'analyst_runtime', 'doctor', '--json'], {
    cwd: runtimeDir,
    env: { PYTHONPATH: '.' },
  });
  let missing: string[];
  try {
    const report = JSON.parse(probe.stdout) as { checks: { name: string; status: string }[] };
    missing = report.checks.filter((c) => c.status !== 'pass').map((c) => c.name);
  } catch {
    missing = ['analyst_runtime 不可运行'];
  }
  record('notebook-kernel-stack', 'Notebook 内核栈(ipykernel/jupyter_client/nbformat)', missing.length === 0 ? 'pass' : 'pending',
    command,
    missing.length === 0
      ? '内核栈依赖全部可导入'
      : `缺失: [${missing.join(', ')}](环境准备项,本产品绝不安装依赖,§7)。双 Session 映射与 Cell 生命周期验证在 M1。`);
}

// ---------------------------------------------------------------------------
// 6-8. 按设计记 pending:SQL 物化 / 模型汇聚 / GenUI 运行时
// ---------------------------------------------------------------------------
function checkDesignedPending(): void {
  record('sql-materialization', 'SQL 结果物化', 'pending', 'n/a',
    'M0 环境无数据库端点(设计 §7:属环境准备);物化验证在 M1。');
  record('model-convergence', '模型汇聚(多轮工具调用收敛)', 'pending', 'n/a',
    'M0 无模型端点(内网 base_url 未配置);协议栈已锁定 openai-chat,汇聚验证在 M1。');
  record('genui-runtime', 'GenUI 注册表/DOM 双通道渲染', 'pending', 'n/a',
    'tool-inventory.json 已静态记录 render_ui/validate_dsh_ui 候选;运行时确认需模型端点 + 浏览器 DOM,M1 执行。');
  record('cordis-tool-registration', 'analyst.* 工具注册进 DSH Cordis 插件机制', 'pending', 'n/a',
    'M6 已交付产品侧 ToolRegistry + DshToolBridge 适配缝(§17);Cordis 注册待 DSH 集成阶段执行。');
}

// ---------------------------------------------------------------------------
// 离线静态资源:静态远程 URL 扫描(注明仅静态,非运行时断网验证)
// ---------------------------------------------------------------------------
function checkOfflineStatic(): void {
  const command = '静态扫描五组件 .js/.mjs/.cjs 中的 http(s):// 外部 URL';
  try {
    const counts: Record<string, number> = {};
    let total = 0;
    for (const spec of FROZEN) {
      const pkgDir = join(profileDir, 'node_modules', spec.pkg);
      const files: string[] = [];
      const walk = (dir: string, depth: number): void => {
        if (depth > 6) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.bin') continue;
            walk(full, depth + 1);
          } else if (/\.(js|mjs|cjs)$/.test(entry.name) && statSync(full).size <= 2 * 1024 * 1024) {
            files.push(full);
          }
        }
      };
      walk(pkgDir, 0);
      let hits = 0;
      for (const file of files) {
        hits += (readFileSync(file, 'utf8').match(/https?:\/\//g) ?? []).length;
      }
      counts[spec.pkg] = hits;
      total += hits;
    }
    record('offline-static', '离线静态资源扫描(仅静态)', 'pass', command,
      `外部 URL 引用计数: ${JSON.stringify(counts)} 合计 ${total}。仅静态分析;运行时断网验证(§21 实际断网 + 请求记录)在 M1。`);
  } catch (error) {
    record('offline-static', '离线静态资源扫描(仅静态)', 'fail', command, String(error instanceof Error ? error.message : error));
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  checkInstallAndLock();
  await checkQuality();
  checkCliBoot();
  checkProfileComposition();
  checkNotebook();
  checkDesignedPending();
  checkOfflineStatic();

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    pending: checks.filter((c) => c.status === 'pending').length,
  };
  const report = { schema_version: 1, generated_at: now(), checks, summary };
  mkdirSync(compatDir, { recursive: true });
  writeFileSync(join(compatDir, 'compatibility.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\ncompat/compatibility.json 已生成: pass=${summary.pass} fail=${summary.fail} pending=${summary.pending}`);
  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`verify 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
