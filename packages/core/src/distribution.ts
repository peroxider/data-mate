import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from './hashing.js';

// ---------------------------------------------------------------------------
// M4 发行与离线交付(§24):发行物清单、校验和与 BOM/SBOM 生成。
// 只使用发行物内已打包的依赖;离线环境不读取网络。所有输出确定性排序,
// 同一输入产生字节一致的清单,便于验收哈希比对。
// ---------------------------------------------------------------------------

export interface DistFileEntry {
  /** POSIX 风格相对路径(以 / 分隔,与 SHA256SUMS 行一致) */
  path: string;
  sha256: string;
  bytes: number;
}

/** 确定性遍历目录(相对路径字典序);排除调用方指定的相对路径。 */
export function collectDistFiles(
  root: string,
  options?: { exclude?: (relativePath: string) => boolean },
): DistFileEntry[] {
  const files: string[] = [];
  const walk = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const childAbs = join(absolute, entry.name);
      const childRel = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  };
  walk(root, '');
  const exclude = options?.exclude;
  const selected = exclude ? files.filter((f) => !exclude(f)) : files;
  selected.sort();
  return selected.map((rel) => {
    const abs = join(root, rel);
    const st = statSync(abs);
    return {
      path: rel,
      sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
      bytes: st.size,
    };
  });
}

/** `sha256sum -c` 兼容格式:`<hash>␣␣<path>`(两个空格)。 */
export function sha256SumsText(entries: DistFileEntry[]): string {
  return entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n';
}

export interface ParsedSumsLine {
  path: string;
  sha256: string;
}

export function parseSha256Sums(text: string): ParsedSumsLine[] {
  const lines: ParsedSumsLine[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
    if (!match) {
      throw new Error(`SHA256SUMS 行格式非法: ${rawLine.slice(0, 120)}`);
    }
    lines.push({ sha256: match[1]!, path: match[2]! });
  }
  return lines;
}

export interface Sha256VerifyResult {
  ok: boolean;
  verified: number;
  mismatches: Array<{ path: string; expected: string; actual: string }>;
  missing: string[];
  /** 存在于目录但未列入校验清单的文件(防夹带) */
  unlisted: string[];
}

/** 完整性校验:清单内逐文件比对 + 目录内未登记文件检查(T14/O01 语义)。 */
export async function verifySha256Sums(root: string, sumsText: string): Promise<Sha256VerifyResult> {
  const listed = parseSha256Sums(sumsText);
  const listedPaths = new Set(listed.map((line) => line.path));
  const mismatches: Sha256VerifyResult['mismatches'] = [];
  const missing: string[] = [];
  for (const line of listed) {
    let actual: string;
    try {
      actual = await sha256File(join(root, line.path));
    } catch {
      missing.push(line.path);
      continue;
    }
    if (actual !== line.sha256) {
      mismatches.push({ path: line.path, expected: line.sha256, actual });
    }
  }
  const present = collectDistFiles(root);
  const unlisted = present.map((entry) => entry.path).filter((p) => !listedPaths.has(p));
  return {
    ok: mismatches.length === 0 && missing.length === 0 && unlisted.length === 0,
    verified: listed.length - missing.length - mismatches.length,
    mismatches,
    missing,
    unlisted,
  };
}

// ---------------------------------------------------------------------------
// BOM / SBOM / LICENSES
// ---------------------------------------------------------------------------

export interface AppDependency {
  name: string;
  version: string;
  license: string;
}

export interface ComponentsLock {
  schema_version: number;
  release: string;
  platform: string;
  application: { version: string; commit: string };
  components: Record<
    string,
    {
      package: string;
      version: string;
      integrity: string;
      peer_dependencies?: Record<string, string>;
    }
  >;
}

export interface BomInput {
  productName: string;
  version: string;
  commit: string;
  platform: string;
  componentsLock: ComponentsLock | null;
  appDependencies: AppDependency[];
  pythonRuntime: { name: string; version: string; requires_python: string };
  sourceHashes: { components_lock: string | null; pnpm_lock: string | null };
}

/** 逐字面 BOM:冻结组件 + 应用依赖 + Python 运行时;输入哈希可追溯。 */
export function buildBom(input: BomInput): Record<string, unknown> {
  return {
    schema_version: 1,
    product: {
      name: input.productName,
      version: input.version,
      commit: input.commit,
      platform: input.platform,
    },
    frozen_components: input.componentsLock
      ? Object.entries(input.componentsLock.components)
          .map(([key, spec]) => ({
            key,
            package: spec.package,
            version: spec.version,
            integrity: spec.integrity,
          }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      : [],
    application_dependencies: [...input.appDependencies].sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
    ),
    python_runtime: input.pythonRuntime,
    source_hashes: input.sourceHashes,
  };
}

/** CycloneDX 1.5 最小 SBOM(离线生成,不含时间戳/序列号等非确定字段)。 */
export function buildSbom(input: BomInput): Record<string, unknown> {
  const npmPurl = (name: string, version: string): string => {
    const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
    return `pkg:npm/${encoded}@${version}`;
  };
  const components = [
    ...input.appDependencies.map((dep) => ({
      type: 'library',
      name: dep.name,
      version: dep.version,
      purl: npmPurl(dep.name, dep.version),
      licenses: [{ license: { id: dep.license } }],
    })),
    {
      type: 'framework',
      name: input.pythonRuntime.name,
      version: input.pythonRuntime.version,
      purl: `pkg:pypi/${input.pythonRuntime.name}@${input.pythonRuntime.version}`,
      licenses: [] as unknown[],
    },
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (String(a.version) < String(b.version) ? -1 : String(a.version) > String(b.version) ? 1 : 0));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: input.productName,
        version: input.version,
      },
      properties: [
        { name: 'platform', value: input.platform },
        { name: 'commit', value: input.commit },
      ],
    },
    components,
  };
}

/** 许可证汇总:逐依赖列出 license 字段;缺失如实标 UNKNOWN。 */
export function buildLicenses(appDependencies: AppDependency[]): Record<string, unknown> {
  return {
    schema_version: 1,
    note: '来自各依赖包 package.json 的 license 字段;UNKNOWN 表示该包未声明。',
    packages: [...appDependencies]
      .map((dep) => ({ name: dep.name, version: dep.version, license: dep.license }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0)),
  };
}

/**
 * 递归扫描 node_modules(含 @scope 与嵌套依赖,跟随符号链接;pnpm 布局下
 * 嵌套依赖位于各包自身 node_modules 内),汇总 name/version/license。
 * 以真实路径去重防环,depth 兜底;无 package.json 的目录如实跳过。
 */
export function scanAppDependencies(nodeModulesDir: string): AppDependency[] {
  const seen = new Map<string, AppDependency>();
  const visited = new Set<string>();
  const MAX_DEPTH = 16;

  const readPkg = (dir: string, depth: number): void => {
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
        license?: string | { type?: string };
      };
      if (typeof raw.name === 'string' && typeof raw.version === 'string') {
        const license =
          typeof raw.license === 'string'
            ? raw.license
            : typeof raw.license?.type === 'string'
              ? raw.license.type
              : 'UNKNOWN';
        const key = `${raw.name}@${raw.version}`;
        if (!seen.has(key)) {
          seen.set(key, { name: raw.name, version: raw.version, license });
        }
      }
    } catch {
      // 无 package.json 或解析失败:如实跳过条目,但仍继续下钻(如 pnpm .pnpm 目录)
    }
    scanNodeModules(join(dir, 'node_modules'), depth + 1);
  };

  const scanNodeModules = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of dirents) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      // .bin 只含可执行符号链接,不是依赖包
      if (entry.name === '.bin') continue;
      if (entry.name.startsWith('@')) {
        scanNodeModules(join(dir, entry.name), depth + 1);
      } else {
        readPkg(join(dir, entry.name), depth);
      }
    }
  };

  scanNodeModules(nodeModulesDir, 0);
  return [...seen.values()].sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------
// MANIFEST
// ---------------------------------------------------------------------------

export interface DistManifest {
  schema_version: 1;
  product: { name: string; version: string; commit: string; platform: string };
  /** 顶层目录摘要:文件数与字节数(不含 SHA256SUMS 自身) */
  contents: Array<{ path: string; files: number; bytes: number }>;
  /** 验收样例数据哈希(§25 固定数值验收) */
  fixtures: Array<{ path: string; sha256: string }>;
  files_total: number;
  checksums_file: 'SHA256SUMS';
  components_lock_sha256: string | null;
}

export function buildManifest(input: {
  productName: string;
  version: string;
  commit: string;
  platform: string;
  entries: DistFileEntry[];
  fixtures: Array<{ path: string; sha256: string }>;
  componentsLockSha256: string | null;
}): DistManifest {
  const byTop = new Map<string, { files: number; bytes: number }>();
  for (const entry of input.entries) {
    const top = entry.path.includes('/') ? entry.path.slice(0, entry.path.indexOf('/')) : entry.path;
    const agg = byTop.get(top) ?? { files: 0, bytes: 0 };
    agg.files += 1;
    agg.bytes += entry.bytes;
    byTop.set(top, agg);
  }
  return {
    schema_version: 1,
    product: {
      name: input.productName,
      version: input.version,
      commit: input.commit,
      platform: input.platform,
    },
    contents: [...byTop.entries()]
      .map(([path, agg]) => ({ path, ...agg }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    fixtures: input.fixtures,
    files_total: input.entries.length,
    checksums_file: 'SHA256SUMS',
    components_lock_sha256: input.componentsLockSha256,
  };
}
