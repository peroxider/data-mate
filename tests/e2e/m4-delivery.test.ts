import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// M4 验收测试(§24):发行物组装 → 介质校验(O01)→ 防篡改(T14 语义)→
// 宿主安装/升级/回退 → 安装后可运行。构建产物缺失时跳过(环境自检项)。
// Docker 相关断言仅在本地已有基础镜像时执行(离线安全,不拉取)。
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, '..', '..');
const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'index.js');
const coreDist = join(repoRoot, 'packages', 'core', 'dist', 'index.js');

const dirs: string[] = [];
let distOut: string;
let distName: string;
let stagingDir: string;
let tarball: string;

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function localImageExists(tag: string): boolean {
  try {
    const out = execFileSync('docker', ['images', '-q', tag], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function readlinkOf(path: string): string {
  return execFileSync('readlink', [path], { encoding: 'utf8' }).trim();
}

/** 模拟升级介质:拷贝发行物目录并改写版本号,重算 SHA256SUMS(除自身)。 */
function makeUpgradeMedia(version: string): string {
  const v2 = mkdtempSync(join(tmpdir(), 'm4-v2-'));
  dirs.push(v2);
  const target = join(v2, distName);
  cpSync(stagingDir, target, { recursive: true });
  const manifestPath = join(target, 'MANIFEST.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    product: { version: string };
  };
  manifest.product.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  // 重算校验和(跳过 SHA256SUMS 自身),与组装脚本同一覆盖语义
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), childRel);
      else if (entry.isFile() && childRel !== 'SHA256SUMS') files.push(childRel);
    }
  };
  walk(target, '');
  files.sort();
  const sums = files
    .map((rel) => `${createHash('sha256').update(readFileSync(join(target, rel))).digest('hex')}  ${rel}`)
    .join('\n') + '\n';
  writeFileSync(join(target, 'SHA256SUMS'), sums);
  return target;
}

beforeAll(() => {
  if (!existsSync(cliEntry) || !existsSync(coreDist)) {
    console.warn('跳过 M4 验收:构建产物缺失(需先 pnpm build)');
    return;
  }
  distOut = mkdtempSync(join(tmpdir(), 'm4-e2e-dist-'));
  dirs.push(distOut);
  run('pnpm', ['dist:build', '--out', distOut, '--skip-build']);
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { name: string; version: string };
  distName = `${rootPkg.name}-${rootPkg.version}-linux-x86_64`;
  stagingDir = join(distOut, distName);
  tarball = join(distOut, `${distName}.tar.gz`);
}, 600_000);

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('M4 发行物组装(O01)', () => {
  it('产出 tar.gz 介质、介质哈希与发行物目录,介质哈希可校验', () => {
    if (!stagingDir) return;
    expect(existsSync(tarball)).toBe(true);
    expect(existsSync(`${tarball}.sha256`)).toBe(true);
    const sumsRecord = readFileSync(`${tarball}.sha256`, 'utf8').trim();
    const [expected, name] = sumsRecord.split(/\s{2}/);
    const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    expect(name).toBe(`${distName}.tar.gz`);
    expect(actual).toBe(expected);
  });

  it('MANIFEST/BOM/SBOM/LICENSES/SHA256SUMS 齐备且元数据一致', () => {
    if (!stagingDir) return;
    const manifest = JSON.parse(readFileSync(join(stagingDir, 'MANIFEST.json'), 'utf8')) as {
      product: { name: string; version: string; commit: string; platform: string };
      files_total: number;
      fixtures: Array<{ path: string }>;
    };
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { name: string; version: string };
    expect(manifest.product.name).toBe(rootPkg.name);
    expect(manifest.product.version).toBe(rootPkg.version);
    expect(manifest.product.platform).toBe('linux-x86_64');
    expect(manifest.files_total).toBeGreaterThan(1000);
    expect(manifest.fixtures.map((f) => f.path)).toEqual([
      'tests/fixtures/fixture_edge.csv',
      'tests/fixtures/fixture_sales.csv',
    ]);

    const bom = JSON.parse(readFileSync(join(stagingDir, 'BOM.json'), 'utf8')) as {
      application_dependencies: Array<{ name: string }>;
      frozen_components: unknown[];
    };
    expect(bom.frozen_components.length).toBeGreaterThanOrEqual(5);
    const depNames = bom.application_dependencies.map((d) => d.name);
    expect(depNames).toContain('zod');
    expect(depNames).toContain('js-yaml');

    const sbom = JSON.parse(readFileSync(join(stagingDir, 'SBOM.cdx.json'), 'utf8')) as {
      bomFormat: string;
      specVersion: string;
    };
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.specVersion).toBe('1.5');

    const licenses = JSON.parse(readFileSync(join(stagingDir, 'LICENSES.json'), 'utf8')) as {
      packages: unknown[];
    };
    expect(licenses.packages.length).toBeGreaterThanOrEqual(bom.application_dependencies.length);

    expect(existsSync(join(stagingDir, 'app', 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(stagingDir, 'python', 'analyst_runtime', 'analyst_runtime', '__init__.py'))).toBe(true);
    expect(existsSync(join(stagingDir, 'packaging', 'host', 'install.sh'))).toBe(true);
    expect(existsSync(join(stagingDir, 'packaging', 'oci', 'Dockerfile'))).toBe(true);
  });

  it('data-analyst m4 verify-media 通过 tar.gz 介质校验', () => {
    if (!stagingDir) return;
    const out = run('node', [cliEntry, 'm4', 'verify-media', '--media', tarball]);
    const parsed = JSON.parse(out) as { status: string; verified: number };
    expect(parsed.status).toBe('pass');
    expect(parsed.verified).toBeGreaterThan(1000);
  });

  it('篡改发行物文件后校验失败(T14 语义)', () => {
    if (!stagingDir) return;
    const tampered = mkdtempSync(join(tmpdir(), 'm4-tamper-'));
    dirs.push(tampered);
    const target = join(tampered, distName);
    cpSync(stagingDir, target, { recursive: true });
    writeFileSync(join(target, 'config', 'defaults.yaml'), 'schema_version: 1\n# tampered\n');
    // 目录介质:verify-media 读 MANIFEST 仍可行,但哈希必然不匹配 → 退出码 1
    let failed = false;
    try {
      execFileSync('node', [cliEntry, 'm4', 'verify-media', '--media', target], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      failed = true;
      const status = (error as { status?: number }).status;
      expect(status).toBe(1);
    }
    expect(failed).toBe(true);
  });
});

describe('M4 宿主安装/升级/回退(O02/§24)', () => {
  it('install.sh 从 tar.gz 安装并可通过 current 运行 version/doctor', () => {
    if (!stagingDir) return;
    const prefix = mkdtempSync(join(tmpdir(), 'm4-prefix-'));
    dirs.push(prefix);
    run('bash', [join(stagingDir, 'packaging', 'host', 'install.sh'), '--media', tarball, '--prefix', prefix]);

    const versionOut = run('node', [
      join(prefix, 'current', 'app', 'dist', 'index.js'),
      'version', '--json',
    ]);
    expect(JSON.parse(versionOut).version).toBeDefined();

    // bin 包装器经 current 软链定位,行为一致
    const wrapperOut = run(join(prefix, 'bin', 'data-analyst'), ['version', '--json']);
    expect(JSON.parse(wrapperOut).name).toBe('@data-analyst/cli');

    run(join(prefix, 'bin', 'data-analyst'), [
      'doctor', '--config', join(prefix, 'current', 'config', 'config.example.yaml'),
    ]);

    // 升级:同 prefix 安装新版本介质 → current 切换,.previous 记录旧版
    const v2Media = makeUpgradeMedia('9.9.9-test');
    run('bash', [join(v2Media, 'packaging', 'host', 'install.sh'), '--media', v2Media, '--prefix', prefix]);
    expect(readlinkOf(join(prefix, 'current'))).toContain('9.9.9-test');
    expect(readFileSync(join(prefix, '.previous'), 'utf8')).toContain('0.1.0-dev');

    // 回退:current 指回旧版本并可运行
    run('bash', [join(v2Media, 'packaging', 'host', 'rollback.sh'), '--prefix', prefix]);
    expect(readlinkOf(join(prefix, 'current'))).toContain('0.1.0-dev');
    const rolledBack = run(join(prefix, 'bin', 'data-analyst'), ['version', '--json']);
    expect(JSON.parse(rolledBack).name).toBe('@data-analyst/cli');
  });
});

describe('M4 容器交付(O02,可选)', () => {
  it('本地具备基础镜像时可用同一介质构建 OCI 镜像', () => {
    if (!stagingDir) return;
    if (!dockerAvailable() || !localImageExists('node:22.19-bookworm-slim')) {
      console.warn('跳过 OCI 镜像构建:docker 不可用或基础镜像不在本地(离线安全)');
      return;
    }
    const tag = 'data-analyst:m4-e2e';
    run('bash', [join(repoRoot, 'packaging', 'oci', 'build-image.sh'), distOut, tag]);
    const inspect = JSON.parse(
      execFileSync('docker', ['inspect', '--format', '{{json .Config.Entrypoint}}', tag], { encoding: 'utf8' }),
    ) as string[];
    expect(inspect).toContain('/opt/bin/data-analyst');
  });
});
