import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AnalystError,
  NotebookRefSchema,
  SessionBindingSchema,
  newId,
  nowIso,
} from '@data-analyst/contracts';
import type {
  CellExecution,
  CellSnapshot,
  CellUpdate,
  ExecutionEvent,
  InterruptResult,
  KernelLease,
  NotebookRef,
  SessionBinding,
} from '@data-analyst/contracts';
import type { RepositoryPort, ResolvedPaths } from '@data-analyst/core';

// ---------------------------------------------------------------------------
// §12 绑定关系:M1 本地最小 Notebook 适配。
// 一个 Session 绑定一个主 Notebook(.ipynb,nbformat 4.5);
// Cell 更新带 expected_revision,不匹配 → CELL_REVISION_CONFLICT;
// 执行经 runtime.python 的 analyst_runtime run-cell(jupyter_client),
// 内核栈缺失时如实 ENVIRONMENT_INCOMPLETE(环境准备项,产品绝不安装依赖)。
// Kernel 生命周期/队列/中断的完整语义由 DSH Notebook 插件生命周期承接(后续里程碑)。
// ---------------------------------------------------------------------------

export interface NotebookServiceOptions {
  repository: RepositoryPort;
  paths: ResolvedPaths;
  pythonBin: string;
  /** analyst_runtime 包所在目录(PYTHONPATH) */
  runtimeDir: string | null;
}

interface NotebookFile {
  cells: NotebookCellFile[];
  metadata: Record<string, unknown>;
  nbformat: 4;
  nbformat_minor: number;
}

interface NotebookCellFile {
  id: string;
  cell_type: 'code' | 'markdown';
  execution_count: number | null;
  metadata: { analyst_revision?: number };
  outputs: Array<Record<string, unknown>>;
  source: string[];
}

function err(
  code: AnalystError['payload']['code'],
  message: string,
  details?: Record<string, unknown>,
): AnalystError {
  return new AnalystError({
    code,
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details: details ?? null,
  });
}

function emptyNotebook(): NotebookFile {
  return {
    cells: [],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function sourceToLines(source: string): string[] {
  if (source === '') return [];
  const lines = source.split('\n');
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
}

interface SidecarOutput {
  type: 'stream' | 'execute_result' | 'display_data' | 'error';
  name?: string;
  text?: string;
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number | null;
}

interface SidecarReport {
  ok: boolean;
  reason?: string;
  outputs?: SidecarOutput[];
  execution_count?: number | null;
  duration_ms?: number;
}

export class NotebookService {
  readonly #repository: RepositoryPort;
  readonly #paths: ResolvedPaths;
  readonly #pythonBin: string;
  readonly #runtimeDir: string | null;

  constructor(options: NotebookServiceOptions) {
    this.#repository = options.repository;
    this.#paths = options.paths;
    this.#pythonBin = options.pythonBin;
    this.#runtimeDir = options.runtimeDir;
  }

  // ------------------------------ Session 绑定 -------------------------------

  async createSession(workspaceId: string): Promise<SessionBinding> {
    const workspace = await this.#repository.workspaces.get(workspaceId);
    if (!workspace || workspace.state !== 'active') {
      throw err('NOT_FOUND', `Workspace 不存在或未激活: ${workspaceId}`);
    }
    const binding: SessionBinding = SessionBindingSchema.parse({
      id: newId(),
      dsh_session_id: `local-${newId()}`,
      workspace_id: workspaceId,
      notebook_id: null,
      model_profile_id: null,
      created_at: nowIso(),
    });
    await this.#repository.sessions.put(binding);
    return binding;
  }

  /** 为 Session 建立主 Notebook;幂等(已绑定则返回既有引用)。 */
  async ensureNotebook(bindingId: string): Promise<NotebookRef> {
    const binding = await this.#repository.sessions.get(bindingId);
    if (!binding) throw err('NOT_FOUND', `Session 不存在: ${bindingId}`);
    if (binding.notebook_id) {
      const existing = await this.#repository.notebooks.get(binding.notebook_id);
      if (existing) return existing;
    }
    const ref: NotebookRef = NotebookRefSchema.parse({
      id: newId(),
      session_id: binding.id,
      relative_path: `notebooks/${binding.id}/main.ipynb`,
      revision: 0,
    });
    const absolutePath = this.#notebookPath(binding.workspace_id, ref.relative_path);
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, JSON.stringify(emptyNotebook(), null, 2), 'utf8');
    await this.#repository.notebooks.put(ref);
    await this.#repository.sessions.put({ ...binding, notebook_id: ref.id });
    return ref;
  }

  async getSession(sessionId: string): Promise<SessionBinding> {
    const binding = await this.#repository.sessions.get(sessionId);
    if (!binding) throw err('NOT_FOUND', `Session 不存在: ${sessionId}`);
    return binding;
  }

  async listSessions(workspaceId: string): Promise<SessionBinding[]> {
    const all = await this.#repository.sessions.list();
    return all.filter((session) => session.workspace_id === workspaceId);
  }

  // ------------------------------ NotebookPort -------------------------------

  #notebookPath(workspaceId: string, relativePath: string): string {
    const root = join(this.#paths.workspacesDir, workspaceId);
    const absolutePath = join(root, relativePath);
    if (!absolutePath.startsWith(`${root}/`)) {
      throw err('FORBIDDEN', 'Notebook 路径越出 Workspace 根目录');
    }
    return absolutePath;
  }

  async #loadNotebook(workspaceId: string, ref: NotebookRef): Promise<NotebookFile> {
    const absolutePath = this.#notebookPath(workspaceId, ref.relative_path);
    let raw: string;
    try {
      raw = await readFile(absolutePath, 'utf8');
    } catch {
      throw err('NOT_FOUND', `Notebook 文件缺失: ${ref.relative_path}`);
    }
    const parsed = JSON.parse(raw) as NotebookFile;
    if (parsed.nbformat !== 4 || !Array.isArray(parsed.cells)) {
      throw err('UNPROCESSABLE', 'Notebook 文件不是 nbformat 4 结构');
    }
    if (!parsed.metadata) parsed.metadata = {};
    return parsed;
  }

  async #storeNotebook(workspaceId: string, ref: NotebookRef, file: NotebookFile): Promise<NotebookRef> {
    const absolutePath = this.#notebookPath(workspaceId, ref.relative_path);
    await writeFile(absolutePath, JSON.stringify(file, null, 2), 'utf8');
    const updated: NotebookRef = { ...ref, revision: ref.revision + 1 };
    await this.#repository.notebooks.put(updated);
    return updated;
  }

  async #requireRef(notebookId: string): Promise<{ ref: NotebookRef; workspaceId: string }> {
    const ref = await this.#repository.notebooks.get(notebookId);
    if (!ref) throw err('NOT_FOUND', `Notebook 不存在: ${notebookId}`);
    const session = await this.#repository.sessions.get(ref.session_id);
    if (!session) throw err('NOT_FOUND', `Notebook 的 Session 不存在: ${ref.session_id}`);
    return { ref, workspaceId: session.workspace_id };
  }

  async getCells(notebookId: string): Promise<CellSnapshot[]> {
    const { ref, workspaceId } = await this.#requireRef(notebookId);
    const file = await this.#loadNotebook(workspaceId, ref);
    return file.cells.map((cell) => ({
      cell_id: cell.id,
      revision: cell.metadata.analyst_revision ?? 0,
      source: cell.source.join(''),
      language: cell.cell_type === 'markdown' ? 'markdown' : 'python',
    }));
  }

  async updateCell(input: CellUpdate): Promise<CellSnapshot> {
    const { ref, workspaceId } = await this.#requireRef(input.notebook_id);
    const file = await this.#loadNotebook(workspaceId, ref);
    let cell = file.cells.find((item) => item.id === input.cell_id);
    if (cell) {
      const currentRevision = cell.metadata.analyst_revision ?? 0;
      if (currentRevision !== input.expected_revision) {
        throw err('CELL_REVISION_CONFLICT', `Cell ${input.cell_id} 版本冲突`, {
          expected_revision: input.expected_revision,
          current_revision: currentRevision,
        });
      }
      cell.source = sourceToLines(input.source);
      cell.metadata.analyst_revision = currentRevision + 1;
    } else {
      if (input.expected_revision !== 0) {
        throw err('CELL_REVISION_CONFLICT', `Cell ${input.cell_id} 不存在,expected_revision 必须为 0`, {
          expected_revision: input.expected_revision,
        });
      }
      cell = {
        id: input.cell_id,
        cell_type: 'code',
        execution_count: null,
        metadata: { analyst_revision: 1 },
        outputs: [],
        source: sourceToLines(input.source),
      };
      file.cells.push(cell);
    }
    await this.#storeNotebook(workspaceId, ref, file);
    return {
      cell_id: cell.id,
      revision: cell.metadata.analyst_revision ?? 0,
      source: cell.source.join(''),
      language: cell.cell_type === 'markdown' ? 'markdown' : 'python',
    };
  }

  /**
   * 执行 Cell:经 analyst_runtime run-cell(jupyter_client)运行代码,
   * 输出回写 .ipynb 并登记 ExecutionRecord。本地适配的内核为单次执行
   * (无跨 Cell 变量状态),持久 Kernel 租约由 DSH 生命周期承接。
   */
  async *execute(input: CellExecution): AsyncGenerator<ExecutionEvent, void, unknown> {
    const { ref, workspaceId } = await this.#requireRef(input.notebook_id);
    const file = await this.#loadNotebook(workspaceId, ref);
    const cell = file.cells.find((item) => item.id === input.cell_id);
    if (!cell) throw err('NOT_FOUND', `Cell 不存在: ${input.cell_id}`);

    const executionId = newId();
    const source = cell.source.join('');
    const sourceHash = createHash('sha256').update(source, 'utf8').digest('hex');
    const startedAt = nowIso();
    const epoch = 0; // 本地适配:每次执行即新内核,epoch 恒 0
    const executionRecord = {
      id: executionId,
      run_id: input.run_id,
      cell_id: cell.id,
      source_revision: cell.metadata.analyst_revision ?? 0,
      source_hash: sourceHash,
      kernel_epoch: epoch,
      lease_token: `local-${executionId}`,
      started_at: startedAt,
      ended_at: null as string | null,
    };

    await this.#repository.executions.put({ ...executionRecord, status: 'running' as const });

    const base = {
      execution_id: executionId,
      session_id: ref.session_id,
      kernel_epoch: epoch,
    };
    const events: ExecutionEvent[] = [];
    events.push({
      ...base,
      seq: events.length,
      type: 'status',
      payload: { state: 'busy' },
      at: nowIso(),
    });

    const report = await this.#runCell(source, input.timeout_seconds);
    if (!report.ok) {
      await this.#repository.executions.put({
        ...executionRecord,
        status: 'failed' as const,
        ended_at: nowIso(),
      });
      throw err('ENVIRONMENT_INCOMPLETE', report.reason ?? 'Notebook 内核栈不可用(环境准备项)');
    }

    for (const output of report.outputs ?? []) {
      if (output.type === 'stream') {
        events.push({
          ...base,
          seq: events.length,
          type: output.name === 'stderr' ? 'stderr' : 'stdout',
          payload: { text: output.text ?? '' },
          at: nowIso(),
        });
      } else if (output.type === 'error') {
        events.push({
          ...base,
          seq: events.length,
          type: 'error',
          payload: {
            ename: output.ename ?? 'Error',
            evalue: output.evalue ?? '',
            traceback: output.traceback ?? [],
          },
          at: nowIso(),
        });
      } else {
        events.push({
          ...base,
          seq: events.length,
          type: output.type === 'execute_result' ? 'execute_result' : 'display_data',
          payload: { data: output.data ?? {} },
          at: nowIso(),
        });
      }
    }
    events.push({ ...base, seq: events.length, type: 'done', payload: {}, at: nowIso() });

    cell.outputs = (report.outputs ?? []).map((output) => ({ ...output }));
    cell.execution_count = report.execution_count ?? null;
    await this.#storeNotebook(workspaceId, ref, file);

    await this.#repository.executions.put({
      ...executionRecord,
      status: 'completed' as const,
      ended_at: nowIso(),
    });

    for (const event of events) {
      yield event;
    }
  }

  async #runCell(source: string, timeoutSeconds: number): Promise<SidecarReport> {
    const scratchDir = join(this.#paths.cacheDir, 'cell-src');
    await mkdir(scratchDir, { recursive: true });
    const codeFile = join(scratchDir, `${newId()}.py`);
    await writeFile(codeFile, source, 'utf8');
    try {
      let procStderr = '';
      const stdout = await new Promise<string>((fulfil, reject) => {
        const child = spawn(
          this.#pythonBin,
          [
            '-m',
            'analyst_runtime',
            'run-cell',
            '--code-file',
            codeFile,
            '--timeout',
            String(timeoutSeconds),
          ],
          {
            env: this.#runtimeDir ? { ...process.env, PYTHONPATH: this.#runtimeDir } : process.env,
            shell: false,
          },
        );
        let out = '';
        child.stdout.on('data', (data: Buffer) => {
          out += data.toString('utf8');
        });
        child.stderr.on('data', (data: Buffer) => {
          procStderr += data.toString('utf8');
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), (timeoutSeconds + 30) * 1000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          fulfil(out);
        });
      }).catch(() => {
        throw err('ENVIRONMENT_INCOMPLETE', `无法启动 Python 运行时 (${this.#pythonBin})`);
      });

      let parsed: SidecarReport;
      try {
        parsed = JSON.parse(stdout) as SidecarReport;
      } catch {
        throw err('ENVIRONMENT_INCOMPLETE', 'analyst_runtime run-cell 输出不是合法 JSON', {
          stderr: procStderr.slice(0, 500),
        });
      }
      return parsed;
    } finally {
      await rm(codeFile, { force: true }).catch(() => undefined);
    }
  }

  async interrupt(executionId: string): Promise<InterruptResult> {
    // 本地适配的执行为一次性子进程;进程级取消后续里程碑经 DSH 队列实现
    return { execution_id: executionId, interrupted: false, state_dirty: true };
  }

  async restart(_sessionId: string): Promise<KernelLease> {
    throw err('UNPROCESSABLE', '本地适配不持有持久 Kernel;重启语义由 DSH Notebook 生命周期承接');
  }

  async save(notebookId: string): Promise<NotebookRef> {
    const { ref, workspaceId } = await this.#requireRef(notebookId);
    const file = await this.#loadNotebook(workspaceId, ref);
    return this.#storeNotebook(workspaceId, ref, file);
  }
}
