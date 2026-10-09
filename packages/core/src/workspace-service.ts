import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  AnalystError,
  DatasetSchema,
  DatasetVersionSchema,
  WorkspaceSchema,
  newId,
  nowIso,
} from '@data-analyst/contracts';
import type {
  AccessScope,
  ArtifactCommit,
  ArtifactRef,
  DataRef,
  Dataset,
  DatasetVersion,
  ImportRequest,
  ResolvedData,
  Workspace,
} from '@data-analyst/contracts';
import type { RepositoryPort } from './repository.js';
import type { ResolvedPaths } from './paths.js';
import { sha256File } from './hashing.js';
import { scanCsvFile } from './csv-scan.js';
import { scanJsonlFile } from './jsonl-scan.js';
import { inferColumnProfiles, toCsv } from './csv-write.js';

// ---------------------------------------------------------------------------
// §9/§11 Workspace 与数据版本服务:WorkspacePort 的产品实现。
// 原文件按 sha256 寻址不可变保留;数据版本登记 schema/manifest;
// resolveData 在读取时复核哈希(T14/T15)。
// ---------------------------------------------------------------------------

export interface WorkspaceServiceOptions {
  repository: RepositoryPort;
  paths: ResolvedPaths;
  /** §18 runtime.python;用于 Parquet 等需科学库格式的只读检查 */
  pythonBin: string;
  /** analyst_runtime 包所在目录(PYTHONPATH);开发环境为仓库 python/ 目录 */
  runtimeDir: string | null;
  limits: {
    /** data.max_upload_mib 对应的字节数 */
    maxUploadBytes: number;
    /** data.quality_ts_max_rows */
    maxRows: number;
  };
}

const PARQUET_MAGIC = 'PAR1';

export interface QueryMaterializationInput {
  workspace_id: string;
  dataset_name: string;
  sql: string;
  columns: string[];
  rows: Array<Array<unknown>>;
  truncated: boolean;
  source_id: string;
  driver: string;
  max_rows: number;
  idempotency_key: string | null;
}

interface ManifestFile {
  schema_version: 1;
  dataset_id: string;
  version_id: string;
  format: 'csv' | 'tsv' | 'parquet' | 'xlsx' | 'jsonl';
  /** 数据文件(data_file)哈希;xlsx/jsonl 为受控 CSV 快照,原件溯源见 original_* 字段 */
  sha256: string;
  size_bytes: number;
  row_count: number | null;
  row_count_status: 'exact' | 'unknown';
  encoding: string | null;
  delimiter: string | null;
  has_header: boolean | null;
  original_name: string;
  /** 相对版本目录的数据文件路径 */
  data_file: string;
  columns: Array<{ name: string; type: string; null_count: number | null }>;
  field_count_mismatch_rows?: number;
  imported_at: string;
  /** xlsx/jsonl:上传原件溯源(数据文件为受控 CSV 快照,§502) */
  original_sha256?: string;
  original_size_bytes?: number;
  /** xlsx:工作表清单与用户指定的分析对象(§496) */
  sheets?: Array<{ name: string; rows: number; cols: number }>;
  selected_sheet?: string;
  /** xlsx:公式值缺少已缓存结果、快照中记为 unavailable(空值)的单元格数 */
  formula_unavailable?: number;
  /** xlsx/jsonl:快照转换说明 */
  snapshot?: string;
  /** jsonl:嵌套字段展开规则(§496) */
  jsonl_expansion?: 'flat' | 'dotted_path';
}

type ErrorCode = AnalystError['payload']['code'];

function error(code: ErrorCode, message: string, details?: Record<string, unknown>): AnalystError {
  return new AnalystError({
    code,
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details: details ?? null,
  });
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot) : '';
  return ext.length > 1 && ext.length <= 6 ? ext : '';
}

export class WorkspaceService {
  readonly #repository: RepositoryPort;
  readonly #paths: ResolvedPaths;
  readonly #pythonBin: string;
  readonly #runtimeDir: string | null;
  readonly #limits: WorkspaceServiceOptions['limits'];

  constructor(options: WorkspaceServiceOptions) {
    this.#repository = options.repository;
    this.#paths = options.paths;
    this.#pythonBin = options.pythonBin;
    this.#runtimeDir = options.runtimeDir;
    this.#limits = options.limits;
  }

  // ------------------------------- Workspace --------------------------------

  async createWorkspace(name: string): Promise<Workspace> {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      throw error('UNPROCESSABLE', 'Workspace 名称长度须为 1–200 字符');
    }
    const id = newId();
    const workspace: Workspace = WorkspaceSchema.parse({
      id,
      name: trimmed,
      root: id, // 服务解析的相对根:workspaces/<id>,不接受调用方绝对路径
      created_at: nowIso(),
      state: 'active',
    });
    await ensureDir(join(this.#paths.workspacesDir, id));
    await this.#repository.workspaces.put(workspace);
    return workspace;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return this.#repository.workspaces.list();
  }

  // --------------------------------- 导入 -----------------------------------

  /** 将用户文件复制进服务端受控暂存目录;返回 staged_path。 */
  async stageUpload(sourcePath: string): Promise<string> {
    const source = resolve(sourcePath);
    const info = await stat(source).catch(() => {
      throw error('NOT_FOUND', `源文件不存在: ${basename(source)}`);
    });
    if (!info.isFile()) throw error('UNPROCESSABLE', '源路径不是普通文件');
    if (info.size > this.#limits.maxUploadBytes) {
      throw error('PAYLOAD_TOO_LARGE', `文件超出上传大小上限: ${info.size} 字节`, {
        size_bytes: info.size,
      });
    }
    const uploadsDir = join(this.#paths.stateDir, 'uploads');
    await ensureDir(uploadsDir);
    const staged = join(uploadsDir, `${newId()}${extOf(source)}`);
    await copyFile(source, staged);
    return staged;
  }

  async importFile(input: ImportRequest): Promise<{
    dataset: Dataset;
    version: DatasetVersion;
    dataRef: DataRef;
  }> {
    if (
      input.format !== 'csv' &&
      input.format !== 'tsv' &&
      input.format !== 'parquet' &&
      input.format !== 'xlsx' &&
      input.format !== 'jsonl'
    ) {
      throw error('UNPROCESSABLE', `支持的导入格式: csv, tsv, parquet, xlsx, jsonl(收到 ${input.format})`);
    }
    if (input.sheet !== undefined && input.format !== 'xlsx') {
      throw error('UNPROCESSABLE', '仅 XLSX 导入支持 sheet 工作表选择');
    }
    const staged = this.#assertStagedPath(input.staged_path);
    const workspace = await this.#repository.workspaces.get(input.workspace_id);
    if (!workspace || workspace.state !== 'active') {
      throw error('NOT_FOUND', `Workspace 不存在或未激活: ${input.workspace_id}`);
    }

    const sha256 = await sha256File(staged);
    const sizeBytes = (await stat(staged)).size;

    let manifest: ManifestFile;
    let snapshotCsv: string | null = null;
    if (input.format === 'parquet') {
      await this.#assertParquetSignature(staged);
      manifest = await this.#buildParquetManifest(staged, sha256, sizeBytes);
    } else if (input.format === 'xlsx') {
      const built = await this.#buildXlsxManifest(staged, input.sheet ?? null);
      manifest = built.manifest;
      snapshotCsv = built.snapshotCsv;
    } else if (input.format === 'jsonl') {
      const built = await this.#buildJsonlManifest(staged);
      manifest = built.manifest;
      snapshotCsv = built.snapshotCsv;
    } else {
      manifest = await this.#buildCsvManifest(input.format, staged, sha256, sizeBytes);
    }

    // §24 结果版本化:同名导入追加为同一 Dataset 的新版本(可追溯 parents),
    // 不再另立兄弟 Dataset;首次导入才创建 Dataset
    const existingDatasets = await this.listDatasets(workspace.id);
    const existing = existingDatasets.find((item) => item.name === input.dataset_name);
    const latestVersion = existing
      ? (await this.listVersions(existing.id)).at(-1) ?? null
      : null;
    const datasetId = existing ? existing.id : newId();
    const versionId = newId();
    const workspaceRootDir = join(this.#paths.workspacesDir, workspace.id);
    const originalDir = join(workspaceRootDir, 'datasets', datasetId, 'original');
    const versionDir = join(workspaceRootDir, 'datasets', datasetId, 'versions', versionId);
    await ensureDir(originalDir);
    await ensureDir(versionDir);

    const dataName = `${sha256}.${manifest.format}`;
    await copyFile(staged, join(originalDir, dataName));
    if (snapshotCsv === null) {
      // csv/tsv/parquet:数据文件即保留的原件
      manifest.data_file = relative(versionDir, join(originalDir, dataName));
    } else {
      // xlsx/jsonl:原件按哈希保留,数据文件为受控 CSV 快照(§502);
      // sha256/size_bytes 与 DataRef 一致地指向快照,保证 resolveData 复核有效
      const snapshotSha = createHash('sha256').update(snapshotCsv, 'utf8').digest('hex');
      const snapshotName = `${snapshotSha}.csv`;
      await this.#writeFile(join(versionDir, snapshotName), snapshotCsv);
      manifest.original_sha256 = sha256;
      manifest.original_size_bytes = sizeBytes;
      manifest.sha256 = snapshotSha;
      manifest.size_bytes = Buffer.byteLength(snapshotCsv, 'utf8');
      manifest.data_file = snapshotName;
    }
    manifest.dataset_id = datasetId;
    manifest.version_id = versionId;
    manifest.imported_at = nowIso();

    const schemaJson = JSON.stringify(manifest.columns, null, 2);
    await this.#writeFile(join(versionDir, 'schema.json'), schemaJson);
    await this.#writeFile(join(versionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const dataset: Dataset = DatasetSchema.parse({
      id: datasetId,
      workspace_id: workspace.id,
      name: input.dataset_name,
      source_kind: 'file_upload',
      created_at: existing ? existing.created_at : nowIso(),
    });
    const dataRef: DataRef = {
      ref_id: newId(),
      workspace_id: workspace.id,
      dataset_version_id: versionId,
      kind: 'table',
      format: manifest.format,
      // xlsx/jsonl:与数据文件(受控 CSV 快照)一致,resolveData 复核有效
      sha256: manifest.sha256,
      size_bytes: manifest.size_bytes,
      row_count: manifest.row_count,
      row_count_status: manifest.row_count_status === 'exact' ? 'exact' : 'unknown',
      schema_ref: `${datasetId}/versions/${versionId}/schema.json`,
      completeness: 'complete',
      scope: {
        source_ref: null,
        filter_description: null,
        sample_method: null,
        sample_seed: null,
        sampled_rows: null,
        query_result_complete: null,
      },
    };
    const version: DatasetVersion = DatasetVersionSchema.parse({
      id: versionId,
      dataset_id: datasetId,
      parents: latestVersion ? [latestVersion.id] : [],
      data_ref_id: dataRef.ref_id,
      operation: 'import',
      scope: `format=${manifest.format}; original=${manifest.original_name}`,
      schema_json: schemaJson,
      manifest: manifest as unknown as Record<string, unknown>,
      sha256: manifest.sha256,
      created_at: nowIso(),
      state: 'ready',
    });

    await this.#repository.datasets.put(dataset);
    await this.#repository.datasetVersions.put(version);
    await this.#repository.dataRefs.put(dataRef);
    return { dataset, version, dataRef };
  }

  // --------------------------- SQL 查询结果物化 -------------------------------

  /**
   * 将 SQL 查询结果物化为不可变数据版本(§8 查询结果成为可追溯的数据版本)。
   * scope 记录 SQL 与截断语义:truncated → completeness=truncated,
   * 不计算虚假的全量结论(T09)。
   */
  async materializeQueryResult(input: QueryMaterializationInput): Promise<{
    dataset: Dataset;
    version: DatasetVersion;
    dataRef: DataRef;
  }> {
    const workspace = await this.#repository.workspaces.get(input.workspace_id);
    if (!workspace || workspace.state !== 'active') {
      throw error('NOT_FOUND', `Workspace 不存在或未激活: ${input.workspace_id}`);
    }

    const csv = toCsv(input.columns, input.rows);
    const columnsProfile = inferColumnProfiles(input.columns, input.rows);

    const existingDatasets = await this.listDatasets(workspace.id);
    const existing = existingDatasets.find((item) => item.name === input.dataset_name);
    const latestVersion = existing ? (await this.listVersions(existing.id)).at(-1) ?? null : null;
    const datasetId = existing ? existing.id : newId();
    const versionId = newId();
    const workspaceRootDir = join(this.#paths.workspacesDir, workspace.id);
    const versionDir = join(workspaceRootDir, 'datasets', datasetId, 'versions', versionId);
    await ensureDir(versionDir);

    // 先写临时文件,再原子发布(§9 文件与元数据提交)
    const tempFile = join(versionDir, `.query-result.${newId()}.tmp`);
    await this.#writeFile(tempFile, csv);
    const sha256 = await sha256File(tempFile);
    const dataFile = `${sha256}.csv`;
    const { rename } = await import('node:fs/promises');
    await rename(tempFile, join(versionDir, dataFile));
    const sizeBytes = Buffer.byteLength(csv, 'utf8');

    const manifest = {
      schema_version: 1,
      dataset_id: datasetId,
      version_id: versionId,
      format: 'csv',
      sha256,
      size_bytes: sizeBytes,
      row_count: input.rows.length,
      row_count_status: 'exact',
      encoding: 'utf-8',
      delimiter: ',',
      has_header: true,
      original_name: 'query-result.csv',
      data_file: dataFile,
      columns: columnsProfile,
      source: {
        kind: 'sql_query',
        source_id: input.source_id,
        driver: input.driver,
        sql: input.sql,
        truncated: input.truncated,
        max_rows: input.max_rows,
        idempotency_key: input.idempotency_key,
      },
      generated_at: nowIso(),
    } as Record<string, unknown>;

    const schemaJson = JSON.stringify(columnsProfile, null, 2);
    await this.#writeFile(join(versionDir, 'schema.json'), schemaJson);
    await this.#writeFile(join(versionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const dataset: Dataset = DatasetSchema.parse({
      id: datasetId,
      workspace_id: workspace.id,
      name: input.dataset_name,
      source_kind: 'sql_query',
      created_at: existing ? existing.created_at : nowIso(),
    });
    const dataRef: DataRef = {
      ref_id: newId(),
      workspace_id: workspace.id,
      dataset_version_id: versionId,
      kind: 'table',
      format: 'csv',
      sha256,
      size_bytes: sizeBytes,
      row_count: input.rows.length,
      row_count_status: 'exact',
      schema_ref: `${datasetId}/versions/${versionId}/schema.json`,
      completeness: input.truncated ? 'truncated' : 'complete',
      scope: {
        // §8 scope.source_ref 为数据源 UUID;绑定信息记录在版本 manifest.source
        source_ref: input.source_id,
        filter_description: input.sql,
        sample_method: null,
        sample_seed: null,
        sampled_rows: null,
        query_result_complete: !input.truncated,
      },
    };
    const version: DatasetVersion = DatasetVersionSchema.parse({
      id: versionId,
      dataset_id: datasetId,
      parents: latestVersion ? [latestVersion.id] : [],
      data_ref_id: dataRef.ref_id,
      operation: 'sql_extract',
      scope: `sql_extract; driver=${input.driver}; truncated=${input.truncated ? 'true' : 'false'}`,
      schema_json: schemaJson,
      manifest,
      sha256,
      created_at: nowIso(),
      state: 'ready',
    });

    await this.#repository.datasets.put(dataset);
    await this.#repository.datasetVersions.put(version);
    await this.#repository.dataRefs.put(dataRef);
    return { dataset, version, dataRef };
  }

  async #writeFile(path: string, content: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, content, 'utf8');
  }

  #assertStagedPath(stagedPath: string): string {
    const resolved = resolve(stagedPath);
    const uploadsDir = resolve(join(this.#paths.stateDir, 'uploads'));
    if (dirname(resolved) !== uploadsDir) {
      throw error('FORBIDDEN', 'staged_path 必须位于服务端受控暂存目录');
    }
    return resolved;
  }

  async #assertParquetSignature(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      const head = Buffer.alloc(4);
      await handle.read(head, 0, 4, 0);
      const tail = Buffer.alloc(4);
      await handle.read(tail, 0, 4, Math.max(0, size - 4));
      if (head.toString('latin1') !== PARQUET_MAGIC || tail.toString('latin1') !== PARQUET_MAGIC) {
        throw error('UNPROCESSABLE', '文件内容与声明的 Parquet 格式不一致', {
          reason: 'DATA_FORMAT',
        });
      }
    } finally {
      await handle.close();
    }
  }

  async #buildCsvManifest(
    format: 'csv' | 'tsv',
    staged: string,
    sha256: string,
    sizeBytes: number,
  ): Promise<ManifestFile> {
    const delimiter = format === 'tsv' ? '\t' : ',';
    const scan = await scanCsvFile(staged, {
      delimiter,
      maxBytes: this.#limits.maxUploadBytes,
      maxRows: this.#limits.maxRows,
    });
    return {
      schema_version: 1,
      dataset_id: '',
      version_id: '',
      format,
      sha256,
      size_bytes: sizeBytes,
      row_count: scan.row_count,
      row_count_status: 'exact',
      encoding: 'utf-8',
      delimiter,
      has_header: true,
      original_name: basename(staged),
      data_file: '',
      columns: scan.columns.map((column) => ({
        name: column.name,
        type: column.inferred_type,
        null_count: column.null_count,
      })),
      ...(scan.field_count_mismatch_rows > 0
        ? { field_count_mismatch_rows: scan.field_count_mismatch_rows }
        : {}),
      imported_at: nowIso(),
    };
  }

  async #buildParquetManifest(
    staged: string,
    sha256: string,
    sizeBytes: number,
  ): Promise<ManifestFile> {
    const report = await this.#runInspectParquet(staged);
    return {
      schema_version: 1,
      dataset_id: '',
      version_id: '',
      format: 'parquet',
      sha256,
      size_bytes: sizeBytes,
      row_count: report.row_count,
      row_count_status: 'exact',
      encoding: null,
      delimiter: null,
      has_header: null,
      original_name: basename(staged),
      data_file: '',
      columns: report.columns.map((column) => ({ ...column, null_count: null })),
      imported_at: nowIso(),
    };
  }

  /** 经 runtime.python 调用 analyst_runtime inspect-parquet(只读)。 */
  async #runInspectParquet(path: string): Promise<{
    row_count: number;
    columns: Array<{ name: string; type: string }>;
  }> {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (fulfil, reject) => {
        const child = spawn(
          this.#pythonBin,
          ['-m', 'analyst_runtime', 'inspect-parquet', '--input', path],
          {
            env: this.#runtimeDir ? { ...process.env, PYTHONPATH: this.#runtimeDir } : process.env,
            shell: false,
          },
        );
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString('utf8');
        });
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8');
        });
        child.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          fulfil({ code, stdout, stderr });
        });
      },
    ).catch(() => {
      throw error(
        'ENVIRONMENT_INCOMPLETE',
        `无法启动 Python 运行时 (${this.#pythonBin});Parquet 检查需要配置 runtime.python`,
      );
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw error('ENVIRONMENT_INCOMPLETE', 'analyst_runtime inspect-parquet 输出不是合法 JSON', {
        stderr: result.stderr.slice(0, 500),
      });
    }
    const report = parsed as {
      ok?: boolean;
      reason?: string;
      row_count?: number;
      columns?: Array<{ name: string; type: string }>;
    };
    if (!report.ok) {
      throw error('ENVIRONMENT_INCOMPLETE', report.reason ?? 'Parquet 检查失败(环境准备项缺失)');
    }
    if (typeof report.row_count !== 'number' || !Array.isArray(report.columns)) {
      throw error('INTERNAL', 'Parquet 检查输出缺少必需字段');
    }
    return { row_count: report.row_count, columns: report.columns };
  }

  async #assertZipSignature(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try {
      const head = Buffer.alloc(4);
      await handle.read(head, 0, 4, 0);
      if (head.toString('latin1') !== 'PK\x03\x04') {
        throw error('UNPROCESSABLE', '文件内容与声明的 XLSX 格式不一致', {
          reason: 'DATA_FORMAT',
        });
      }
    } finally {
      await handle.close();
    }
  }

  /** 经 runtime.python 调用 analyst_runtime inspect-xlsx(只读,§788)。 */
  async #runInspectXlsx(
    path: string,
    sheet: string | null,
  ): Promise<{
    sheets?: Array<{ name: string; rows: number; cols: number }>;
    row_count?: number;
    columns?: string[];
    rows?: Array<Array<unknown>>;
    formula_unavailable?: number;
  }> {
    const args = [
      '-m',
      'analyst_runtime',
      'inspect-xlsx',
      '--input',
      path,
      '--max-rows',
      String(this.#limits.maxRows),
    ];
    if (sheet !== null) args.push('--sheet', sheet);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (fulfil, reject) => {
        const child = spawn(this.#pythonBin, args, {
          env: this.#runtimeDir ? { ...process.env, PYTHONPATH: this.#runtimeDir } : process.env,
          shell: false,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString('utf8');
        });
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8');
        });
        child.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          fulfil({ code, stdout, stderr });
        });
      },
    ).catch(() => {
      throw error(
        'ENVIRONMENT_INCOMPLETE',
        `无法启动 Python 运行时 (${this.#pythonBin});XLSX 检查需要配置 runtime.python`,
      );
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw error('ENVIRONMENT_INCOMPLETE', 'analyst_runtime inspect-xlsx 输出不是合法 JSON', {
        stderr: result.stderr.slice(0, 500),
      });
    }
    const report = parsed as {
      ok?: boolean;
      error_kind?: string;
      reason?: string;
      sheets?: Array<{ name: string; rows: number; cols: number }>;
      row_count?: number;
      columns?: string[];
      rows?: Array<Array<unknown>>;
      formula_unavailable?: number;
    };
    if (!report.ok) {
      if (report.error_kind === 'environment') {
        throw error('ENVIRONMENT_INCOMPLETE', report.reason ?? 'XLSX 检查失败(环境准备项缺失)');
      }
      if (report.error_kind === 'row_limit') {
        throw error('PAYLOAD_TOO_LARGE', report.reason ?? '数据行数超出导入上限', {
          max_rows: this.#limits.maxRows,
        });
      }
      throw error('UNPROCESSABLE', report.reason ?? 'XLSX 检查失败', {
        reason: 'DATA_FORMAT',
        sheets: report.sheets ?? null,
      });
    }
    return report;
  }

  async #buildXlsxManifest(
    staged: string,
    sheet: string | null,
  ): Promise<{ manifest: ManifestFile; snapshotCsv: string }> {
    await this.#assertZipSignature(staged);
    const listing = await this.#runInspectXlsx(staged, null);
    const sheets = listing.sheets ?? [];
    if (sheets.length === 0) {
      throw error('UNPROCESSABLE', 'XLSX 不含任何工作表', { reason: 'DATA_FORMAT' });
    }
    // §496:多工作表由用户指定分析对象;单一工作表自动选定
    const selected = sheet ?? (sheets.length === 1 ? sheets[0]!.name : null);
    if (selected === null) {
      throw error('UNPROCESSABLE', 'XLSX 含多个工作表,请指定 sheet 分析对象', {
        sheets: sheets.map((item) => item.name),
      });
    }
    if (!sheets.some((item) => item.name === selected)) {
      throw error('UNPROCESSABLE', `工作表不存在: ${selected}`, {
        reason: 'DATA_FORMAT',
        sheets: sheets.map((item) => item.name),
      });
    }
    const dump = await this.#runInspectXlsx(staged, selected);
    const columns = dump.columns ?? [];
    const rows = dump.rows ?? [];
    if (columns.length === 0) {
      throw error('UNPROCESSABLE', `工作表为空或缺少表头行: ${selected}`, {
        reason: 'DATA_FORMAT',
      });
    }
    return {
      manifest: {
        schema_version: 1,
        dataset_id: '',
        version_id: '',
        format: 'xlsx',
        sha256: '',
        size_bytes: 0, // 快照哈希与大小在物化快照后回填
        row_count: dump.row_count ?? rows.length,
        row_count_status: 'exact',
        encoding: null,
        delimiter: ',',
        has_header: true,
        original_name: basename(staged),
        data_file: '',
        columns: inferColumnProfiles(columns, rows),
        sheets,
        selected_sheet: selected,
        formula_unavailable: dump.formula_unavailable ?? 0,
        snapshot: '选定工作表物化为受控 CSV 快照(§502);公式缺缓存值记为 unavailable',
        imported_at: nowIso(),
      },
      snapshotCsv: toCsv(columns, rows),
    };
  }

  async #buildJsonlManifest(staged: string): Promise<{ manifest: ManifestFile; snapshotCsv: string }> {
    const scan = await scanJsonlFile(staged, {
      maxBytes: this.#limits.maxUploadBytes,
      maxRows: this.#limits.maxRows,
    });
    return {
      manifest: {
        schema_version: 1,
        dataset_id: '',
        version_id: '',
        format: 'jsonl',
        sha256: '',
        size_bytes: 0, // 快照哈希与大小在物化快照后回填
        row_count: scan.row_count,
        row_count_status: 'exact',
        encoding: 'utf-8',
        delimiter: null,
        has_header: true,
        original_name: basename(staged),
        data_file: '',
        columns: inferColumnProfiles(scan.columns, scan.rows),
        field_count_mismatch_rows: scan.field_count_mismatch_rows,
        snapshot: '可表格化 JSONL 物化为受控 CSV 快照(§502)',
        jsonl_expansion: scan.expansion,
        imported_at: nowIso(),
      },
      snapshotCsv: toCsv(scan.columns, scan.rows),
    };
  }

  // ------------------------------ DataRef 解析 -------------------------------

  async resolveData(refId: string, scope: AccessScope): Promise<ResolvedData> {
    const ref = await this.#repository.dataRefs.get(refId);
    if (!ref) throw error('NOT_FOUND', `DataRef 不存在: ${refId}`);
    if (scope.workspace_id !== ref.workspace_id) {
      throw error('FORBIDDEN', 'DataRef 不属于当前 Workspace');
    }
    const version = await this.#repository.datasetVersions.get(ref.dataset_version_id as string);
    if (!version) throw error('NOT_FOUND', `数据版本不存在: ${String(ref.dataset_version_id)}`);
    const dataset = await this.#repository.datasets.get(version.dataset_id);
    if (!dataset) throw error('NOT_FOUND', `Dataset 不存在: ${version.dataset_id}`);

    const manifest = version.manifest as unknown as ManifestFile;
    const versionDir = join(
      this.#paths.workspacesDir,
      ref.workspace_id,
      'datasets',
      dataset.id,
      'versions',
      version.id,
    );
    const absolutePath = resolve(versionDir, manifest.data_file);
    this.#assertWithinWorkspace(ref.workspace_id, absolutePath);

    // 读取时复核哈希:T14 人为更改已登记文件必须暴露
    const actualSha256 = await sha256File(absolutePath).catch(() => {
      throw error('NOT_FOUND', `数据文件缺失: ${manifest.data_file}`);
    });
    if (actualSha256 !== ref.sha256) {
      await this.#repository.datasetVersions.put({ ...version, state: 'corrupted' });
      throw error('UNPROCESSABLE', '数据文件哈希校验失败,该版本已标记为 corrupted', {
        expected_sha256: ref.sha256,
        actual_sha256: actualSha256,
      });
    }

    const withinLimits =
      ref.size_bytes <= scope.max_bytes &&
      (ref.row_count === null || ref.row_count <= scope.max_rows);
    return {
      ref,
      absolute_path: absolutePath,
      bytes_available: ref.size_bytes,
      within_limits: withinLimits,
    };
  }

  #assertWithinWorkspace(workspaceId: string, absolutePath: string): void {
    const root = resolve(join(this.#paths.workspacesDir, workspaceId));
    const rel = relative(root, absolutePath);
    if (isAbsolute(rel) || rel.startsWith('..')) {
      throw error('FORBIDDEN', '解析路径越出 Workspace 根目录');
    }
  }

  // --------------------------------- 产物 -----------------------------------

  async registerArtifact(input: ArtifactCommit): Promise<ArtifactRef> {
    const absolutePath = resolve(
      join(this.#paths.workspacesDir, input.workspace_id, input.relative_path),
    );
    this.#assertWithinWorkspace(input.workspace_id, absolutePath);
    const info = await stat(absolutePath).catch(() => {
      throw error('NOT_FOUND', `产物文件不存在: ${input.relative_path}`);
    });
    if (!info.isFile()) throw error('UNPROCESSABLE', '产物路径不是普通文件');
    const actualSha256 = await sha256File(absolutePath);
    if (actualSha256 !== input.sha256) {
      throw error('UNPROCESSABLE', '产物哈希与提交值不一致', {
        expected_sha256: input.sha256,
        actual_sha256: actualSha256,
      });
    }
    const artifact = {
      id: newId(),
      run_id: input.run_id,
      kind: input.kind,
      relative_path: input.relative_path,
      sha256: input.sha256,
      inputs: [] as string[],
      producer: 'workspace-service',
      state: 'ready' as const,
      created_at: nowIso(),
    };
    await this.#repository.artifacts.put(artifact);
    return {
      artifact_id: artifact.id,
      workspace_id: input.workspace_id,
      kind: artifact.kind,
      relative_path: artifact.relative_path,
      sha256: artifact.sha256,
      state: artifact.state,
    };
  }

  // -------------------------------- 查询辅助 ---------------------------------

  async listDatasets(workspaceId: string): Promise<Dataset[]> {
    const all = await this.#repository.datasets.list();
    return all.filter((dataset) => dataset.workspace_id === workspaceId);
  }

  async listVersions(datasetId: string): Promise<DatasetVersion[]> {
    const all = await this.#repository.datasetVersions.list();
    return all
      .filter((version) => version.dataset_id === datasetId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async latestDataRef(workspaceId: string, datasetName: string): Promise<DataRef> {
    const datasets = await this.listDatasets(workspaceId);
    const dataset = datasets.find((item) => item.name === datasetName);
    if (!dataset) throw error('NOT_FOUND', `Dataset 不存在: ${datasetName}`);
    const versions = await this.listVersions(dataset.id);
    const latest = versions.at(-1);
    if (!latest) throw error('NOT_FOUND', `Dataset 无数据版本: ${datasetName}`);
    const ref = await this.#repository.dataRefs.get(latest.data_ref_id);
    if (!ref) throw error('NOT_FOUND', '最新版本缺少 DataRef 登记');
    return ref;
  }

  /** 将内存仓储写入产品状态快照(CLI 每次命令结束时调用)。 */
  async persist(): Promise<void> {
    await this.#repository.snapshotTo(this.#paths.productStateFile);
  }
}
