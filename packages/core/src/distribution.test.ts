import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildBom,
  buildLicenses,
  buildManifest,
  buildSbom,
  collectDistFiles,
  parseSha256Sums,
  scanAppDependencies,
  sha256SumsText,
  verifySha256Sums,
  type ComponentsLock,
} from './distribution.js';

// ---------------------------------------------------------------------------
// M4 发行物域逻辑:确定性遍历、校验和生成/验证(含防篡改与防夹带)、
// BOM/SBOM/LICENSES/MANIFEST 构造。fixture 均为合成数据。
// ---------------------------------------------------------------------------

const dirs: string[] = [];

function makeDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'dist-test-'));
  dirs.push(root);
  mkdirSync(join(root, 'app', 'dist'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'app', 'dist', 'index.js'), 'console.log("v1");\n');
  writeFileSync(join(root, 'app', 'package.json'), '{"name":"app","version":"1.0.0"}\n');
  writeFileSync(join(root, 'config', 'defaults.yaml'), 'schema_version: 1\n');
  return root;
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('collectDistFiles / sha256SumsText', () => {
  it('按字典序产出 POSIX 相对路径与稳定哈希', () => {
    const root = makeDist();
    const entries = collectDistFiles(root);
    expect(entries.map((e) => e.path)).toEqual([
      'app/dist/index.js',
      'app/package.json',
      'config/defaults.yaml',
    ]);
    const sums = sha256SumsText(entries);
    const lines = sums.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f]{64} {2}\S+$/);
    }
    const index = entries.find((e) => e.path === 'app/dist/index.js')!;
    expect(index.sha256).toHaveLength(64);
  });
});

describe('verifySha256Sums', () => {
  it('完整发行物通过校验', async () => {
    const root = makeDist();
    const sums = sha256SumsText(collectDistFiles(root));
    const result = await verifySha256Sums(root, sums);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(3);
    expect(result.mismatches).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.unlisted).toEqual([]);
  });

  it('篡改文件 → mismatch;新增文件 → unlisted;删除文件 → missing', async () => {
    const root = makeDist();
    const sums = sha256SumsText(collectDistFiles(root));

    writeFileSync(join(root, 'config', 'defaults.yaml'), 'schema_version: 999\n'); // 篡改
    rmSync(join(root, 'app', 'package.json')); // 删除
    writeFileSync(join(root, 'smuggled.txt'), 'extra\n'); // 夹带

    const result = await verifySha256Sums(root, sums);
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((m) => m.path)).toEqual(['config/defaults.yaml']);
    expect(result.missing).toEqual(['app/package.json']);
    expect(result.unlisted).toEqual(['smuggled.txt']);
  });

  it('解析非法行报错,注释与空行被忽略', () => {
    expect(() => parseSha256Sums('nothash  file.txt')).toThrow(/格式非法/);
    const parsed = parseSha256Sums(`# comment\n\n${'a'.repeat(64)}  x.txt`);
    expect(parsed).toEqual([{ sha256: 'a'.repeat(64), path: 'x.txt' }]);
  });
});

describe('scanAppDependencies', () => {
  it('扫描顶层与 @scope 包并去重排序,license 缺失记 UNKNOWN', () => {
    const nm = mkdtempSync(join(tmpdir(), 'nm-test-'));
    dirs.push(nm);
    mkdirSync(join(nm, 'zlib-pkg'), { recursive: true });
    mkdirSync(join(nm, '@scope', 'lib'), { recursive: true });
    mkdirSync(join(nm, 'broken'), { recursive: true });
    writeFileSync(
      join(nm, 'zlib-pkg', 'package.json'),
      '{"name":"zlib-pkg","version":"2.0.0","license":"MIT"}',
    );
    writeFileSync(
      join(nm, '@scope', 'lib', 'package.json'),
      '{"name":"@scope/lib","version":"0.3.1","license":{"type":"Apache-2.0"}}',
    );
    writeFileSync(join(nm, 'broken', 'README.md'), 'no package.json here');

    const deps = scanAppDependencies(nm);
    expect(deps).toEqual([
      { name: '@scope/lib', version: '0.3.1', license: 'Apache-2.0' },
      { name: 'zlib-pkg', version: '2.0.0', license: 'MIT' },
    ]);
    expect(scanAppDependencies(join(nm, 'does-not-exist'))).toEqual([]);
  });

  it('递归扫描嵌套依赖(跟随符号链接)且防环', () => {
    const nm = mkdtempSync(join(tmpdir(), 'nm-nested-'));
    dirs.push(nm);
    mkdirSync(join(nm, 'outer', 'node_modules', 'inner'), { recursive: true });
    writeFileSync(
      join(nm, 'outer', 'package.json'),
      '{"name":"outer","version":"1.0.0","license":"MIT"}',
    );
    writeFileSync(
      join(nm, 'outer', 'node_modules', 'inner', 'package.json'),
      '{"name":"inner","version":"0.1.0","license":"ISC"}',
    );
    // 防环:inner 的 node_modules 指回 outer(符号链接)
    mkdirSync(join(nm, 'outer', 'node_modules', 'inner', 'node_modules'), { recursive: true });
    symlinkSync(join(nm, 'outer'), join(nm, 'outer', 'node_modules', 'inner', 'node_modules', 'outer'));

    const deps = scanAppDependencies(nm);
    expect(deps).toEqual([
      { name: 'inner', version: '0.1.0', license: 'ISC' },
      { name: 'outer', version: '1.0.0', license: 'MIT' },
    ]);
  });
});

describe('buildBom / buildSbom / buildLicenses / buildManifest', () => {
  const lock: ComponentsLock = {
    schema_version: 1,
    release: 'data-analyst-0.1.0-dev',
    platform: 'linux-x86_64',
    application: { version: '0.1.0-dev', commit: 'abc1234' },
    components: {
      dsh: { package: '@deepseek-ai/dsh', version: '0.2.0-rc.2', integrity: 'sha512-xxx' },
      dsh_notebook: { package: '@beihaizb/dsh-notebook', version: '0.2.4', integrity: 'sha512-yyy' },
    },
  };
  const input = {
    productName: 'data-analyst',
    version: '0.1.0-dev',
    commit: 'abc1234',
    platform: 'linux-x86_64',
    componentsLock: lock,
    appDependencies: [
      { name: 'zlib-pkg', version: '2.0.0', license: 'MIT' },
      { name: '@scope/lib', version: '0.3.1', license: 'Apache-2.0' },
    ],
    pythonRuntime: { name: 'analyst-runtime', version: '0.1.0.dev0', requires_python: '>=3.10' },
    sourceHashes: { components_lock: 'hash-lock', pnpm_lock: 'hash-pnpm' },
  };

  it('BOM 含冻结组件、排序依赖与来源哈希', () => {
    const bom = buildBom(input) as {
      frozen_components: Array<{ key: string }>;
      application_dependencies: Array<{ name: string }>;
      source_hashes: { components_lock: string };
    };
    expect(bom.frozen_components.map((c) => c.key)).toEqual(['dsh', 'dsh_notebook']);
    expect(bom.application_dependencies.map((d) => d.name)).toEqual(['@scope/lib', 'zlib-pkg']);
    expect(bom.source_hashes.components_lock).toBe('hash-lock');
    // 无锁文件时冻结组件为空数组而非报错
    const bomNoLock = buildBom({ ...input, componentsLock: null });
    expect((bomNoLock as { frozen_components: unknown[] }).frozen_components).toEqual([]);
  });

  it('SBOM 为 CycloneDX 1.5,scoped 包 purl 正确编码', () => {
    const sbom = buildSbom(input) as {
      bomFormat: string;
      specVersion: string;
      components: Array<{ name: string; purl: string }>;
    };
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.specVersion).toBe('1.5');
    const lib = sbom.components.find((c) => c.name === '@scope/lib');
    expect(lib?.purl).toBe('pkg:npm/%40scope/lib@0.3.1');
    const py = sbom.components.find((c) => c.name === 'analyst-runtime');
    expect(py?.purl).toBe('pkg:pypi/analyst-runtime@0.1.0.dev0');
  });

  it('LICENSES 逐包列出并排序', () => {
    const licenses = buildLicenses(input.appDependencies) as {
      packages: Array<{ name: string; license: string }>;
    };
    expect(licenses.packages.map((p) => p.license)).toEqual(['Apache-2.0', 'MIT']);
  });

  it('MANIFEST 按顶层目录聚合文件数与字节数', () => {
    const entries = [
      { path: 'app/dist/index.js', sha256: 'f'.repeat(64), bytes: 21 },
      { path: 'app/package.json', sha256: 'e'.repeat(64), bytes: 42 },
      { path: 'SHA256SUMS', sha256: 'd'.repeat(64), bytes: 100 },
    ];
    const manifest = buildManifest({
      productName: 'data-analyst',
      version: '0.1.0-dev',
      commit: 'abc1234',
      platform: 'linux-x86_64',
      entries,
      fixtures: [{ path: 'tests/fixtures/fixture_sales.csv', sha256: 'c'.repeat(64) }],
      componentsLockSha256: 'hash-lock',
    });
    expect(manifest.contents).toEqual([
      { path: 'SHA256SUMS', files: 1, bytes: 100 },
      { path: 'app', files: 2, bytes: 63 },
    ]);
    expect(manifest.files_total).toBe(3);
    expect(manifest.checksums_file).toBe('SHA256SUMS');
  });

  it('端到端:真实临时目录的 SHA256SUMS 可写盘后再校验', async () => {
    const root = makeDist();
    const sums = sha256SumsText(collectDistFiles(root));
    writeFileSync(join(root, 'SHA256SUMS'), sums);
    const withSelf = readFileSync(join(root, 'SHA256SUMS'), 'utf8');
    const result = await verifySha256Sums(root, withSelf);
    // SHA256SUMS 自身未列入清单 → unlisted 包含它,ok 为 false;
    // 组装脚本最终以 exclude 排除自身,这里验证未列入行为符合防夹带语义
    expect(result.unlisted).toEqual(['SHA256SUMS']);
    expect(result.verified).toBe(3);
  });
});
