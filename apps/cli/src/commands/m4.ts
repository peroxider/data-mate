import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { AnalystError } from '@data-analyst/contracts';
import {
  loadProductConfig,
  parseSha256Sums,
  resolveConfigDir,
  sha256File,
  verifySha256Sums,
} from '@data-analyst/core';

// ---------------------------------------------------------------------------
// M4 命令(§24/§25):介质完整性验证与离线验收记录生成。
// 验收记录如实标注:能自动核验的给 pass/fail,需要离线隔离环境人工执行的
// 用例给 not_run 并附原因,绝不伪造(§25 O01–O12)。
// ---------------------------------------------------------------------------

interface MediaCheck {
  status: 'pass' | 'fail';
  verified: number;
  mismatches: Array<{ path: string; expected: string; actual: string }>;
  missing: string[];
  unlisted: string[];
  /** 介质目录(tar.gz 输入时为解包后的临时目录) */
  dir: string;
  /** 临时解包目录需要清理时记录 */
  tempDir: string | null;
}

interface ManifestProduct {
  name: string;
  version: string;
  commit: string;
  platform: string;
}

function readManifest(mediaDir: string): ManifestProduct {
  const manifestPath = join(mediaDir, 'MANIFEST.json');
  let parsed: { product?: Partial<ManifestProduct> };
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new AnalystError({
      code: 'ENVIRONMENT_INCOMPLETE',
      message: `MANIFEST.json 读取失败: ${manifestPath}`,
      request_id: null,
      run_id: null,
      retryable: false,
      details: { reason: error instanceof Error ? error.message : String(error) },
    });
  }
  const product = parsed.product ?? {};
  if (!product.version || !product.platform) {
    throw new AnalystError({
      code: 'ENVIRONMENT_INCOMPLETE',
      message: 'MANIFEST.json 缺少 product.version / product.platform',
      request_id: null,
      run_id: null,
      retryable: false,
      details: { manifest: manifestPath },
    });
  }
  return {
    name: product.name ?? 'unknown',
    version: product.version,
    commit: product.commit ?? 'unknown',
    platform: product.platform,
  };
}

/** O01 介质校验:支持目录或 tar.gz;SHA256SUMS 覆盖全部文件(仅自身除外)。 */
async function checkMedia(mediaPath: string): Promise<MediaCheck> {
  const absolute = resolve(mediaPath);
  if (!existsSync(absolute)) {
    throw new AnalystError({
      code: 'NOT_FOUND',
      message: `介质不存在: ${absolute}`,
      request_id: null,
      run_id: null,
      retryable: false,
      details: null,
    });
  }

  let dir = absolute;
  let tempDir: string | null = null;
  if (statSync(absolute).isFile() && /\.tar\.gz$/.test(absolute)) {
    tempDir = mkdtempSync(join(tmpdir(), 'm4-media-'));
    spawnSync('tar', ['-xzf', absolute, '-C', tempDir], { encoding: 'utf8' });
    const entries = readdirSync(tempDir);
    const inner = entries[0];
    if (!inner || entries.length !== 1) {
      throw new AnalystError({
        code: 'ENVIRONMENT_INCOMPLETE',
        message: '介质 tar.gz 顶层应恰有一个发行物目录',
        request_id: null,
        run_id: null,
        retryable: false,
        details: { entries },
      });
    }
    dir = join(tempDir, inner);
  }

  const sumsPath = join(dir, 'SHA256SUMS');
  let sumsText: string;
  try {
    sumsText = readFileSync(sumsPath, 'utf8');
  } catch (error) {
    throw new AnalystError({
      code: 'ENVIRONMENT_INCOMPLETE',
      message: `SHA256SUMS 读取失败: ${sumsPath}`,
      request_id: null,
      run_id: null,
      retryable: false,
      details: { reason: error instanceof Error ? error.message : String(error) },
    });
  }

  const result = await verifySha256Sums(dir, sumsText);
  const expectedSelf = parseSha256Sums(sumsText).length + 1; // + SHA256SUMS 自身
  const unlistedOther = result.unlisted.filter((p) => p !== 'SHA256SUMS');
  const ok =
    result.mismatches.length === 0 &&
    result.missing.length === 0 &&
    unlistedOther.length === 0 &&
    result.verified + 1 === expectedSelf;
  return {
    status: ok ? 'pass' : 'fail',
    verified: result.verified,
    mismatches: result.mismatches,
    missing: result.missing,
    unlisted: unlistedOther,
    dir,
    tempDir,
  };
}

function mediaError(check: MediaCheck): AnalystError {
  return new AnalystError({
    code: 'ENVIRONMENT_INCOMPLETE',
    message: '介质完整性校验失败(T14/O01 语义:篡改、缺失或夹带均判失败)',
    request_id: null,
    run_id: null,
    retryable: false,
    details: {
      mismatches: check.mismatches,
      missing: check.missing,
      unlisted: check.unlisted,
    },
  });
}

interface AcceptanceCheck {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'not_run';
  detail: string;
}

export function registerM4Commands(program: Command): void {
  const m4 = program.command('m4').description('M4 发行与离线交付:介质校验与验收记录');

  m4
    .command('verify-media')
    .description('校验发行物介质完整性(SHA256SUMS + MANIFEST,O01)')
    .requiredOption('--media <path>', '发行物目录或 tar.gz 路径')
    .action(async (options: { media: string }) => {
      const check = await checkMedia(options.media);
      try {
        const product = readManifest(check.dir);
        if (check.status !== 'pass') {
          throw mediaError(check);
        }
        console.log(
          JSON.stringify(
            {
              status: 'pass',
              product,
              verified: check.verified,
              mismatches: [],
              missing: [],
              unlisted: [],
            },
            null,
            2,
          ),
        );
      } finally {
        if (check.tempDir) rmSync(check.tempDir, { recursive: true, force: true });
      }
    });

  m4
    .command('acceptance')
    .description('生成 M4 验收记录 JSON(产品版本、平台、Endpoint、数据哈希、O01–O12 用例结果)')
    .requiredOption('--config <file>', '产品配置 YAML 路径')
    .requiredOption('--media <path>', '发行物目录或 tar.gz 路径')
    .requiredOption('--endpoint <url>', '外部测试模型 Endpoint(验收记录必填)')
    .option('--out <file>', '验收记录写入路径(缺省仅打印)')
    .action(
      async (options: { config: string; media: string; endpoint: string; out?: string }) => {
        const checks: AcceptanceCheck[] = [];
        const notRun = (id: string, title: string, reason: string): void => {
          checks.push({ id, title, status: 'not_run', detail: reason });
        };

        const mediaCheck = await checkMedia(options.media);
        let product: ManifestProduct;
        try {
          product = readManifest(mediaCheck.dir);
          checks.push({
            id: 'O01',
            title: '介质校验并导入',
            status: mediaCheck.status,
            detail: `SHA256SUMS 校验 ${mediaCheck.verified} 文件(mismatches=${mediaCheck.mismatches.length}, missing=${mediaCheck.missing.length}, unlisted=${mediaCheck.unlisted.length})`,
          });
        } finally {
          if (mediaCheck.tempDir) rmSync(mediaCheck.tempDir, { recursive: true, force: true });
        }

        try {
          const config = loadProductConfig({ configFile: options.config });
          checks.push({
            id: 'O02',
            title: '配置加载与校验',
            status: 'pass',
            detail: `profile=${config.runtime.profile}, network.mode=${config.network.mode}`,
          });
        } catch (error) {
          checks.push({
            id: 'O02',
            title: '配置加载与校验',
            status: 'fail',
            detail: error instanceof Error ? error.message : String(error),
          });
        }

        // fixture 数据哈希(§25 固定数值验收样例),来自介质内文件实算
        const mediaDir = resolve(options.media);
        const fixtureHashes: Array<{ path: string; sha256: string }> = [];
        if (statSync(mediaDir).isDirectory()) {
          const fixturesDir = join(mediaDir, 'tests', 'fixtures');
          if (existsSync(fixturesDir)) {
            for (const name of readdirSync(fixturesDir).sort()) {
              fixtureHashes.push({
                path: `tests/fixtures/${name}`,
                sha256: await sha256File(join(fixturesDir, name)),
              });
            }
          }
        }

        // Python 运行时导入探测(O04 的本地可执行部分)
        const runtimeDir = resolve(resolveConfigDir(options.config), '..', 'python', 'analyst_runtime');
        const pyProbe = spawnSync('python3', ['-m', 'analyst_runtime', 'doctor', '--json'], {
          encoding: 'utf8',
          timeout: 20_000,
          env: existsSync(runtimeDir) ? { ...process.env, PYTHONPATH: runtimeDir } : process.env,
        });
        checks.push({
          id: 'O04',
          title: 'Python 运行时导入探测',
          status: pyProbe.status === 0 ? 'pass' : 'fail',
          detail:
            pyProbe.status === 0
              ? 'analyst_runtime doctor 通过'
              : (pyProbe.stderr ?? '').trim().slice(0, 200) || `退出码 ${pyProbe.status}`,
        });

        // O03/O05–O12 需要离线隔离环境、内网模型/数据库或真实 DSH,
        // CLI 无法在本机单进程内如实判定,一律记 not_run 并附原因
        notRun('O03', '前端无外部请求', '需要浏览器与网络监测,离线隔离环境人工执行');
        notRun('O05', '内网模型实际分析', '需要内网模型服务与 Chat 交互验证');
        notRun('O06', 'CSV 质量检查与统计', '使用 m1/m2 命令在验收环境中执行后回填');
        notRun('O07', '表格 ML 训练与解释图', '使用 m2 train-model 在验收环境中执行后回填');
        notRun('O08', '内网 PostgreSQL/MySQL 查询', '需要内网数据库与 m3 命令执行后回填');
        notRun('O09', '离线浏览器打开报告', '需要隔离浏览器环境人工核验');
        notRun('O10', '重启后 Workspace 保留', '需要重启应用场景人工核验');
        notRun('O11', '进程与网络行为监测', '需要全系统监测设施,离线隔离环境执行');
        notRun('O12', '断开模型/数据库恢复', '需要故障注入场景人工核验');

        const summary = {
          pass: checks.filter((c) => c.status === 'pass').length,
          fail: checks.filter((c) => c.status === 'fail').length,
          not_run: checks.filter((c) => c.status === 'not_run').length,
        };
        const record = {
          schema_version: 1,
          record_type: 'm4-acceptance',
          product,
          test_endpoint: options.endpoint,
          media: {
            path: resolve(options.media),
            sha256_sums_verified: mediaCheck.verified,
          },
          fixture_hashes: fixtureHashes,
          checks,
          summary,
        };
        const text = JSON.stringify(record, null, 2) + '\n';
        if (options.out) {
          writeFileSync(resolve(options.out), text);
          console.log(`验收记录已写入: ${resolve(options.out)}`);
        } else {
          console.log(text);
        }
        if (summary.fail > 0) {
          throw new AnalystError({
            code: 'ENVIRONMENT_INCOMPLETE',
            message: `M4 验收存在失败项(${summary.fail} 个),记录已如实标注`,
            request_id: null,
            run_id: null,
            retryable: false,
            details: { summary },
          });
        }
      },
    );
}
