#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  buildBom,
  buildLicenses,
  buildManifest,
  buildSbom,
  collectDistFiles,
  scanAppDependencies,
  sha256File,
  sha256SumsText,
  verifySha256Sums,
  type ComponentsLock,
} from '@data-analyst/core';

// ---------------------------------------------------------------------------
// M4 发行与离线交付(§24):组装应用发行物并生成 BOM、SBOM、许可证与校验文件。
// 唯一输入是本仓库构建产物;组装过程绝不访问网络(ADR007)。
// 发行物布局以 <root>/config/*.yaml 为锚,使 configDir/.. 的既有解析
// (python/analyst_runtime、compat/components.lock.json、.m0/profile)零改动可用。
// 用法:tsx distributions/assemble.ts [--out <dir>] [--skip-build]
// ---------------------------------------------------------------------------

const here = resolve(import.meta.dirname);
const repoRoot = resolve(here, '..');

function parseArgs(argv: string[]): { out: string; skipBuild: boolean } {
  let out = join(repoRoot, 'dist', 'distributions');
  let skipBuild = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = resolve(process.cwd(), argv[++i] ?? '');
    } else if (argv[i] === '--skip-build') {
      skipBuild = true;
    } else {
      throw new Error(`未知参数: ${argv[i]}`);
    }
  }
  return { out, skipBuild };
}

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function gitCommit(): string {
  try {
    return run('git', ['rev-parse', '--short', 'HEAD'], repoRoot).trim();
  } catch {
    return 'unversioned-working-tree';
  }
}

function copyDirFiltered(src: string, dest: string, skip: (name: string) => boolean): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const from = join(src, entry.name);
    if (entry.isDirectory()) {
      copyDirFiltered(from, join(dest, entry.name), skip);
    } else if (entry.isFile()) {
      cpSync(from, join(dest, entry.name));
    }
  }
}

const PY_JUNK = new Set(['__pycache__', '.ruff_cache', '.pytest_cache', '.venv', '*.egg-info']);

async function main(): Promise<void> {
  const { out, skipBuild } = parseArgs(process.argv);

  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const version = rootPkg.version;
  const commit = gitCommit();
  const lock: ComponentsLock = JSON.parse(
    readFileSync(join(repoRoot, 'compat', 'components.lock.json'), 'utf8'),
  );
  const platform = lock.platform ?? 'unknown';

  const distName = `${rootPkg.name}-${version}-${platform}`;
  const stagingRoot = join(out, distName);
  const tarball = join(out, `${distName}.tar.gz`);

  rmSync(stagingRoot, { recursive: true, force: true });
  rmSync(tarball, { force: true });
  mkdirSync(stagingRoot, { recursive: true });

  if (!skipBuild) {
    console.log('[1/7] pnpm build(tsc -b)');
    run('pnpm', ['build'], repoRoot);
  } else {
    console.log('[1/7] 跳过构建(--skip-build)');
  }

  console.log('[2/7] pnpm deploy 自包含 app/');
  run(
    'pnpm',
    ['deploy', '--legacy', '--prod', '--filter=@data-analyst/cli', join(stagingRoot, 'app')],
    repoRoot,
  );

  console.log('[3/7] 拷贝 Python 运行时、配置、fixtures、组件档案');
  copyDirFiltered(
    join(repoRoot, 'python', 'analyst_runtime'),
    join(stagingRoot, 'python', 'analyst_runtime'),
    (n) => PY_JUNK.has(n),
  );
  mkdirSync(join(stagingRoot, 'config'), { recursive: true });
  cpSync(join(repoRoot, 'config', 'defaults.yaml'), join(stagingRoot, 'config', 'defaults.yaml'));
  cpSync(join(repoRoot, 'config', 'dev.example.yaml'), join(stagingRoot, 'config', 'config.example.yaml'));
  copyDirFiltered(join(repoRoot, 'tests', 'fixtures'), join(stagingRoot, 'tests', 'fixtures'), () => false);
  mkdirSync(join(stagingRoot, 'compat'), { recursive: true });
  cpSync(join(repoRoot, 'compat', 'components.lock.json'), join(stagingRoot, 'compat', 'components.lock.json'));
  if (existsSync(join(repoRoot, '.m0', 'profile'))) {
    copyDirFiltered(join(repoRoot, '.m0', 'profile'), join(stagingRoot, '.m0', 'profile'), (n) => n === 'node_modules');
  }

  console.log('[4/7] 拷贝安装与 OCI 打包资产');
  cpSync(join(repoRoot, 'packaging', 'host', 'install.sh'), join(stagingRoot, 'packaging', 'host', 'install.sh'));
  cpSync(join(repoRoot, 'packaging', 'host', 'rollback.sh'), join(stagingRoot, 'packaging', 'host', 'rollback.sh'));
  cpSync(join(repoRoot, 'packaging', 'host', 'systemd'), join(stagingRoot, 'packaging', 'host', 'systemd'), { recursive: true });
  cpSync(join(repoRoot, 'packaging', 'oci'), join(stagingRoot, 'packaging', 'oci'), { recursive: true });

  console.log('[5/7] 生成 BOM / SBOM / LICENSES');
  const appDependencies = scanAppDependencies(join(stagingRoot, 'app', 'node_modules'));
  const pyproject = readFileSync(join(repoRoot, 'python', 'analyst_runtime', 'pyproject.toml'), 'utf8');
  const pyVersion = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? 'unknown';
  const pyRequires = /^requires-python\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? 'unknown';
  const bomInput = {
    productName: rootPkg.name,
    version,
    commit,
    platform,
    componentsLock: lock,
    appDependencies,
    pythonRuntime: { name: 'analyst-runtime', version: pyVersion, requires_python: pyRequires },
    sourceHashes: {
      components_lock: await sha256File(join(repoRoot, 'compat', 'components.lock.json')),
      pnpm_lock: existsSync(join(repoRoot, 'pnpm-lock.yaml'))
        ? await sha256File(join(repoRoot, 'pnpm-lock.yaml'))
        : null,
    },
  };
  writeFileSync(join(stagingRoot, 'BOM.json'), JSON.stringify(buildBom(bomInput), null, 2) + '\n');
  writeFileSync(join(stagingRoot, 'SBOM.cdx.json'), JSON.stringify(buildSbom(bomInput), null, 2) + '\n');
  writeFileSync(join(stagingRoot, 'LICENSES.json'), JSON.stringify(buildLicenses(appDependencies), null, 2) + '\n');

  console.log('[6/7] 生成 MANIFEST 与 SHA256SUMS');
  // 语义:MANIFEST 描述 payload(除 MANIFEST.json 与 SHA256SUMS 外的全部文件);
  // SHA256SUMS 覆盖 payload + MANIFEST.json,仅自身不列入。
  const payloadEntries = collectDistFiles(stagingRoot);
  const fixtureEntries = payloadEntries.filter((e) => e.path.startsWith('tests/fixtures/'));
  const manifest = buildManifest({
    productName: rootPkg.name,
    version,
    commit,
    platform,
    entries: payloadEntries,
    fixtures: fixtureEntries.map((e) => ({ path: e.path, sha256: e.sha256 })),
    componentsLockSha256: bomInput.sourceHashes.components_lock,
  });
  const manifestFile = join(stagingRoot, 'MANIFEST.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const manifestEntry = {
    path: 'MANIFEST.json',
    sha256: await sha256File(manifestFile),
    bytes: statSync(manifestFile).size,
  };
  const sumsEntries = [...payloadEntries, manifestEntry].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  writeFileSync(join(stagingRoot, 'SHA256SUMS'), sha256SumsText(sumsEntries));

  // 组装自检:全部哈希一致,且未列入者仅允许 SHA256SUMS 自身(O01 语义)
  const selfCheck = await verifySha256Sums(
    stagingRoot,
    readFileSync(join(stagingRoot, 'SHA256SUMS'), 'utf8'),
  );
  if (
    selfCheck.mismatches.length > 0 ||
    selfCheck.missing.length > 0 ||
    selfCheck.unlisted.join(',') !== 'SHA256SUMS'
  ) {
    throw new Error(`发行物自检失败: ${JSON.stringify(selfCheck)}`);
  }

  console.log('[7/7] 打包 tar.gz(确定性元数据)+ 介质哈希');
  const plainTar = join(out, `${distName}.tar`);
  run(
    'tar',
    [
      '--sort=name',
      '--mtime=UTC 2026-01-01',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-cf',
      plainTar,
      distName,
    ],
    out,
  );
  // gzip -n:头部不写时间戳,同输入产生字节一致介质
  execFileSync('bash', ['-c', `gzip -n -c "$1" > "$2"`, 'gzip', plainTar, tarball], { cwd: out });
  rmSync(plainTar, { force: true });
  writeFileSync(`${tarball}.sha256`, `${await sha256File(tarball)}  ${basename(tarball)}\n`);

  const mediaBytes = statSync(tarball).size;
  console.log(
    `发行物完成: ${tarball} (${(mediaBytes / 1024 / 1024).toFixed(1)} MiB, ${manifest.files_total} 文件, version=${version}, commit=${commit})`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
