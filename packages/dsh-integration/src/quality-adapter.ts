import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AnalystError } from '@data-analyst/contracts';
import type {
  AccessScope,
  CleanRequest,
  CleanResult,
  ProfileFinding,
  ProfileRequest,
  ProfileResult,
  QualityPort,
  ResolvedData,
  VerifyRequest,
  VerifyResult,
} from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §11 小表质量计算:进程内复用 dsh-data-quality 的纯函数
// (resolveConfig/loadTable/profileTable),不 fork、不打补丁。
// 插件模块从组件冻结目录(.m0/profile)解析;进程内计算只读原文件。
// 超出 TypeScript 质量边界(§25 T08)的 Python 分路由后续里程碑实现,
// 本适配器如实报错而非静默降级。
// ---------------------------------------------------------------------------

export interface QualityAdapterOptions {
  /** 组件冻结 profile 目录(内含 node_modules/dsh-data-quality) */
  profileDir: string;
  /** DataRef → 已校验文件路径的解析回调(WorkspaceService.resolveData) */
  resolveData: (refId: string, scope: AccessScope) => Promise<ResolvedData>;
  limits: { maxBytes: number; maxRows: number };
  /** 质量报告 JSON 落盘回调;返回 workspace 相对路径 */
  persistReport: (workspaceId: string, json: string) => Promise<string>;
}

interface DqColumnCard {
  name?: string;
  inferredType?: string;
  missing?: number;
  missingRate?: number;
  unique?: number;
  numeric?: { min?: number; max?: number; mean?: number; outliers?: number };
  notes?: string[];
}

interface DqProfileReport {
  rowCount?: number;
  profiledRows?: number;
  sampled?: boolean;
  columnCount?: number;
  duplicateRows?: number;
  duplicateRate?: number;
  columns?: DqColumnCard[];
}

interface DqModule {
  resolveConfig?: (input?: unknown) => unknown;
  loadTable: (
    absolutePath: string,
    config: unknown,
    signal?: undefined,
  ) => Promise<{ columns: Array<{ name?: string } | string>; rows: unknown[] }>;
  profileTable: (table: unknown, options: { dataset: string; generatedAt: number; sample?: number }) => DqProfileReport;
}

function qualityError(message: string, details?: Record<string, unknown>): AnalystError {
  return new AnalystError({
    code: 'UNPROCESSABLE',
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details: { reason: 'QUALITY_COMPUTATION', ...details },
  });
}

export function createQualityAdapter(options: QualityAdapterOptions): QualityPort {
  const requireFromProfile = createRequire(join(options.profileDir, 'package.json'));
  let dq: DqModule;
  try {
    dq = requireFromProfile('dsh-data-quality') as DqModule;
  } catch (error) {
    throw new AnalystError({
      code: 'ENVIRONMENT_INCOMPLETE',
      message: `无法从组件冻结目录加载 dsh-data-quality: ${options.profileDir}`,
      request_id: null,
      run_id: null,
      retryable: false,
      details: { reason: error instanceof Error ? error.message : String(error) },
    });
  }

  async function profile(input: ProfileRequest): Promise<ProfileResult> {
    const ref = input.data_ref;
    const scope: AccessScope = {
      workspace_id: ref.workspace_id,
      max_bytes: options.limits.maxBytes,
      max_rows: options.limits.maxRows,
    };
    const resolved = await options.resolveData(ref.ref_id, scope);

    const config = dq.resolveConfig ? dq.resolveConfig({}) : {};
    let report: DqProfileReport;
    try {
      const table = await dq.loadTable(resolved.absolute_path, config, undefined);
      report = dq.profileTable(table, {
        dataset: ref.schema_ref,
        generatedAt: Date.now(),
        ...(input.sample ? { sample: input.sample.rows } : {}),
      });
    } catch (error) {
      throw qualityError(
        `质量插件计算失败(超出小表边界或格式不受支持): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const scopeText = input.sample
      ? `completeness=sampled; sample_rows=${input.sample.rows}; seed=${input.sample.seed ?? 'n/a'}`
      : `completeness=complete; profiled_rows=${String(report.profiledRows ?? report.rowCount ?? 0)}`;

    const findings: ProfileFinding[] = [
      { metric: 'row_count', column: null, value: report.rowCount ?? null, scope: scopeText },
      { metric: 'duplicate_rows', column: null, value: report.duplicateRows ?? null, scope: scopeText },
      { metric: 'duplicate_rate', column: null, value: report.duplicateRate ?? null, scope: scopeText },
    ];
    for (const card of report.columns ?? []) {
      const name = card.name;
      if (name === undefined) continue;
      findings.push({ metric: 'inferred_type', column: name, value: card.inferredType ?? null, scope: scopeText });
      findings.push({ metric: 'missing', column: name, value: card.missing ?? null, scope: scopeText });
      findings.push({ metric: 'missing_rate', column: name, value: card.missingRate ?? null, scope: scopeText });
      findings.push({ metric: 'unique', column: name, value: card.unique ?? null, scope: scopeText });
      if (card.numeric) {
        findings.push({ metric: 'numeric_mean', column: name, value: card.numeric.mean ?? null, scope: scopeText });
        findings.push({ metric: 'numeric_min', column: name, value: card.numeric.min ?? null, scope: scopeText });
        findings.push({ metric: 'numeric_max', column: name, value: card.numeric.max ?? null, scope: scopeText });
        findings.push({ metric: 'outliers', column: name, value: card.numeric.outliers ?? null, scope: scopeText });
      }
    }

    const reportJson = JSON.stringify(
      { report, data_ref_id: ref.ref_id, completeness: input.sample ? 'sampled' : 'complete' },
      null,
      2,
    );
    const relativePath = await options.persistReport(ref.workspace_id, reportJson);

    return {
      ref,
      completeness: input.sample ? 'sampled' : 'complete',
      findings,
      report_artifact: relativePath,
    };
  }

  return {
    profile,
    clean: async (_input: CleanRequest): Promise<CleanResult> => {
      throw qualityError('M1 闭环仅启用 Profiling;清洗(clean)将在后续里程碑启用');
    },
    verify: async (_input: VerifyRequest): Promise<VerifyResult> => {
      throw qualityError('M1 闭环仅启用 Profiling;验证(verify)将在后续里程碑启用');
    },
  };
}
