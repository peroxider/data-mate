import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  WorkspaceSchema,
  SessionBindingSchema,
  AnalysisRunSchema,
  DatasetSchema,
  DatasetVersionSchema,
  DataRefSchema,
  NotebookRefSchema,
  KernelLeaseSchema,
  ExecutionRecordSchema,
  MetricEvidenceSchema,
  ArtifactSchema,
  ModelProfileSchema,
  DataSourceBindingSchema,
  RunEventSchema,
  AnalystError,
} from '@data-analyst/contracts';
import type {
  Workspace,
  SessionBinding,
  AnalysisRun,
  Dataset,
  DatasetVersion,
  DataRef,
  NotebookRef,
  KernelLease,
  ExecutionRecord,
  MetricEvidence,
  Artifact,
  ModelProfile,
  DataSourceBinding,
  RunEvent,
} from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §9 Repository 端口 + M0 内存实现(JSON 快照持久化)。
// SQLite 实现按决策 D1 推迟到 M1,端口契约不变。
// ---------------------------------------------------------------------------

export interface EntityStore<T extends object> {
  get(id: string): Promise<T | null>;
  put(entity: T): Promise<void>;
  list(): Promise<T[]>;
  delete(id: string): Promise<boolean>;
}

export interface RepositoryPort {
  readonly workspaces: EntityStore<Workspace>;
  readonly sessions: EntityStore<SessionBinding>;
  readonly runs: EntityStore<AnalysisRun>;
  readonly datasets: EntityStore<Dataset>;
  readonly datasetVersions: EntityStore<DatasetVersion>;
  readonly dataRefs: EntityStore<DataRef>;
  readonly notebooks: EntityStore<NotebookRef>;
  readonly kernelLeases: EntityStore<KernelLease>;
  readonly executions: EntityStore<ExecutionRecord>;
  readonly metricEvidence: EntityStore<MetricEvidence>;
  readonly artifacts: EntityStore<Artifact>;
  readonly modelProfiles: EntityStore<ModelProfile>;
  readonly dataSources: EntityStore<DataSourceBinding>;
  readonly runEvents: EntityStore<RunEvent>;
  /** 将全部集合写入 JSON 快照文件 */
  snapshotTo(path: string): Promise<void>;
  /** 从 JSON 快照恢复;任何实体未通过 Schema 校验 → CONFIG_INVALID */
  restoreFrom(path: string): Promise<void>;
}

/**
 * 内存存储。默认以 `id` 为主键;§8 的 KernelLease 以 session 为主键
 * (一 Session 一租约),传入键字段名 `session_id`。
 */
class MemoryStore<T extends object> implements EntityStore<T> {
  readonly #items = new Map<string, T>();
  readonly #keyField: keyof T & string;

  constructor(keyField: keyof T & string = 'id' as keyof T & string) {
    this.#keyField = keyField;
  }

  async get(id: string): Promise<T | null> {
    return this.#items.get(id) ?? null;
  }

  async put(entity: T): Promise<void> {
    this.#items.set(entity[this.#keyField] as string, entity);
  }

  async list(): Promise<T[]> {
    return [...this.#items.values()];
  }

  async delete(id: string): Promise<boolean> {
    return this.#items.delete(id);
  }
}

const SNAPSHOT_SCHEMA_VERSION = 1 as const;

interface SnapshotFile {
  schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  saved_at: string;
  collections: Record<string, unknown[]>;
}

function collectionSchemas(): Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }> {
  return {
    workspaces: WorkspaceSchema,
    sessions: SessionBindingSchema,
    runs: AnalysisRunSchema,
    datasets: DatasetSchema,
    datasetVersions: DatasetVersionSchema,
    dataRefs: DataRefSchema,
    notebooks: NotebookRefSchema,
    kernelLeases: KernelLeaseSchema,
    executions: ExecutionRecordSchema,
    metricEvidence: MetricEvidenceSchema,
    artifacts: ArtifactSchema,
    modelProfiles: ModelProfileSchema,
    dataSources: DataSourceBindingSchema,
    runEvents: RunEventSchema,
  };
}

export class InMemoryRepository implements RepositoryPort {
  readonly workspaces = new MemoryStore<Workspace>();
  readonly sessions = new MemoryStore<SessionBinding>();
  readonly runs = new MemoryStore<AnalysisRun>();
  readonly datasets = new MemoryStore<Dataset>();
  readonly datasetVersions = new MemoryStore<DatasetVersion>();
  readonly dataRefs = new MemoryStore<DataRef>('ref_id');
  readonly notebooks = new MemoryStore<NotebookRef>();
  readonly kernelLeases = new MemoryStore<KernelLease>('session_id');
  readonly executions = new MemoryStore<ExecutionRecord>();
  readonly metricEvidence = new MemoryStore<MetricEvidence>();
  readonly artifacts = new MemoryStore<Artifact>();
  readonly modelProfiles = new MemoryStore<ModelProfile>();
  readonly dataSources = new MemoryStore<DataSourceBinding>();
  readonly runEvents = new MemoryStore<RunEvent>();

  async snapshotTo(path: string): Promise<void> {
    const snapshot: SnapshotFile = {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      saved_at: new Date().toISOString(),
      collections: {
        workspaces: await this.workspaces.list(),
        sessions: await this.sessions.list(),
        runs: await this.runs.list(),
        datasets: await this.datasets.list(),
        datasetVersions: await this.datasetVersions.list(),
        dataRefs: await this.dataRefs.list(),
        notebooks: await this.notebooks.list(),
        kernelLeases: await this.kernelLeases.list(),
        executions: await this.executions.list(),
        metricEvidence: await this.metricEvidence.list(),
        artifacts: await this.artifacts.list(),
        modelProfiles: await this.modelProfiles.list(),
        dataSources: await this.dataSources.list(),
        runEvents: await this.runEvents.list(),
      },
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  async restoreFrom(path: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      throw new AnalystError({
        code: 'NOT_FOUND',
        message: `快照文件不存在: ${path}`,
        request_id: null,
        run_id: null,
        retryable: false,
        details: null,
      });
    }
    let parsed: SnapshotFile;
    try {
      parsed = JSON.parse(raw) as SnapshotFile;
    } catch {
      throw new AnalystError({
        code: 'CONFIG_INVALID',
        message: '快照文件不是合法 JSON',
        request_id: null,
        run_id: null,
        retryable: false,
        details: null,
      });
    }
    if (parsed.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
      throw new AnalystError({
        code: 'CONFIG_INVALID',
        message: `快照 schema_version 不支持: ${String(parsed.schema_version)}`,
        request_id: null,
        run_id: null,
        retryable: false,
        details: null,
      });
    }
    const schemas = collectionSchemas();
    for (const [name, schema] of Object.entries(schemas)) {
      const items = parsed.collections[name];
      if (!Array.isArray(items)) continue;
      const store = this.#storeFor(name);
      for (const item of items) {
        const result = schema.safeParse(item);
        if (!result.success) {
          throw new AnalystError({
            code: 'CONFIG_INVALID',
            message: `快照集合 ${name} 中存在非法实体`,
            request_id: null,
            run_id: null,
            retryable: false,
            details: { collection: name },
          });
        }
        await store.put(result.data as { id: string });
      }
    }
  }

  #storeFor(name: string): EntityStore<Record<string, unknown>> {
    switch (name) {
      case 'workspaces':
        return this.workspaces;
      case 'sessions':
        return this.sessions;
      case 'runs':
        return this.runs;
      case 'datasets':
        return this.datasets;
      case 'datasetVersions':
        return this.datasetVersions;
      case 'dataRefs':
        return this.dataRefs;
      case 'notebooks':
        return this.notebooks;
      case 'kernelLeases':
        return this.kernelLeases;
      case 'executions':
        return this.executions;
      case 'metricEvidence':
        return this.metricEvidence;
      case 'artifacts':
        return this.artifacts;
      case 'modelProfiles':
        return this.modelProfiles;
      case 'dataSources':
        return this.dataSources;
      case 'runEvents':
        return this.runEvents;
      default:
        throw new Error(`未知集合: ${name}`);
    }
  }
}
