import {
  AnalystError,
  AnalysisRunSchema,
  KernelLeaseSchema,
  RunEventSchema,
  newId,
  nowIso,
} from '@data-analyst/contracts';
import type {
  AnalysisRun,
  KernelLease,
  ModelProfile,
  RunEvent,
  RunTrigger,
} from '@data-analyst/contracts';
import type { RepositoryPort } from './repository.js';

// ---------------------------------------------------------------------------
// §13 运行治理:同 Session 单 Run(SESSION_BUSY)、Kernel 数量上限与排队、
// 模型配置 revision 快照(Run 使用启动时版本)、run_events 日志关联(FR17)
// 与启动对账(进程重启后旧租约失效,遗留 Run 进入终态)。
// 关键状态转移使用 compare-and-set:终态不可回退(§9)。
// ---------------------------------------------------------------------------

export interface RunGovernorOptions {
  repository: RepositoryPort;
  /** §18 runtime.max_active_kernels:同时持有活跃 Kernel 的 Session 数上限 */
  maxActiveKernels: number;
}

const ACTIVE_LEASE_STATES = new Set(['starting', 'idle', 'busy']);
const OPEN_RUN_STATUSES = new Set(['queued', 'running', 'cancelling']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export type RunTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

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

export interface BeginRunInput {
  session_id: string;
  trigger: RunTrigger;
  model_profile_id: string | null;
  idempotency_key?: string | null;
  /** §629 幂等:同 key 不同 payload 由 API 层以 409 拒绝;此处仅登记负载指纹 */
  payload_hash?: string | null;
}

export interface BeginRunOutcome {
  run: AnalysisRun;
  queued: boolean;
  /** SESSION_BUSY 冲突时为正在运行的 run_id */
  busy_with_run_id: string | null;
}

export class RunGovernor {
  readonly #repository: RepositoryPort;
  readonly #maxActiveKernels: number;
  /** 进程内串行化:begin/finish/cancel 的状态更新逐个应用(§9 CAS 语义) */
  readonly #chain: { promise: Promise<void> };
  readonly #cancelHandlers = new Map<string, () => Promise<boolean>>();
  /** 排队 Run 唤醒回调(唯一触发点:#dequeueNext);执行层据此启动排队 Run */
  #onRunStarted: ((run: AnalysisRun) => void) | null = null;

  constructor(options: RunGovernorOptions) {
    this.#repository = options.repository;
    this.#maxActiveKernels = options.maxActiveKernels;
    this.#chain = { promise: Promise.resolve() };
  }

  /** 进程内互斥执行,保证读-改-写不交错。 */
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#chain.promise.then(operation, operation);
    this.#chain.promise = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ------------------------------ 启动对账 -----------------------------------

  /** 进程重启后调用:旧租约失效;上一进程遗留的未终态 Run 进入终态。 */
  async recoverOnStartup(): Promise<{
    interruptedRuns: number;
    cancelledQueued: number;
    stoppedLeases: number;
  }> {
    return this.#serialize(async () => {
      let interruptedRuns = 0;
      let cancelledQueued = 0;
      for (const run of await this.#repository.runs.list()) {
        if (!OPEN_RUN_STATUSES.has(run.status)) continue;
        const nextStatus = run.status === 'queued' ? 'cancelled' : 'interrupted';
        await this.#repository.runs.put({
          ...run,
          status: nextStatus,
          ended_at: nowIso(),
        });
        if (nextStatus === 'cancelled') cancelledQueued += 1;
        else interruptedRuns += 1;
        await this.#appendEvent({
          run_id: run.id,
          session_id: run.session_id,
          cell_id: null,
          execution_id: null,
          level: 'warn',
          event: 'run.recovered',
          message: `启动对账:上一进程遗留 Run 以 ${nextStatus} 终结(旧执行不进入新 Run)`,
        });
      }
      let stoppedLeases = 0;
      for (const lease of await this.#repository.kernelLeases.list()) {
        if (lease.status === 'stopped') continue;
        await this.#repository.kernelLeases.put({
          ...lease,
          status: 'stopped',
          state_dirty: true,
          last_used_at: nowIso(),
        });
        stoppedLeases += 1;
      }
      // 上一进程遗留的 running 执行记录:标记 interrupted,不归属任何新 Run
      for (const execution of await this.#repository.executions.list()) {
        if (execution.status !== 'running') continue;
        await this.#repository.executions.put({
          ...execution,
          status: 'interrupted',
          ended_at: execution.ended_at ?? nowIso(),
        });
      }
      return { interruptedRuns, cancelledQueued, stoppedLeases };
    });
  }

  // ------------------------------ Run 生命周期 -------------------------------

  /**
   * 开始一次分析 Run:
   * - 同 Session 已有 queued/running/cancelling Run → SESSION_BUSY(附当前 run_id);
   * - 活跃 Kernel 会话数达到 max_active_kernels → Run 进入 queued 排队;
   * - model_profile_id 提供时生成不可变配置快照,Run 记录启动时的 config_revision。
   */
  async beginRun(input: BeginRunInput): Promise<BeginRunOutcome> {
    return this.#serialize(async () => {
      const session = await this.#repository.sessions.get(input.session_id);
      if (!session) {
        throw err('NOT_FOUND', `Session 不存在: ${input.session_id}`);
      }

      for (const run of await this.#repository.runs.list()) {
        if (run.session_id !== input.session_id) continue;
        if (!OPEN_RUN_STATUSES.has(run.status)) continue;
        throw err('SESSION_BUSY', '同一 Session 同时只接受一个分析 Run', {
          current_run_id: run.id,
          current_status: run.status,
        });
      }

      let profileSnapshot: ModelProfile | null = null;
      let configRevision = 0;
      if (input.model_profile_id !== null) {
        const profile = await this.#repository.modelProfiles.get(input.model_profile_id);
        if (!profile) {
          throw err('NOT_FOUND', `ModelProfile 不存在: ${input.model_profile_id}`);
        }
        configRevision = profile.revision;
        profileSnapshot = {
          ...profile,
          id: newId(),
          created_at: nowIso(),
        };
        await this.#repository.modelProfiles.put(profileSnapshot);
      }

      const activeSessions = await this.#activeKernelSessions();
      const holdsSlot =
        activeSessions.has(input.session_id) || activeSessions.size < this.#maxActiveKernels;

      const run: AnalysisRun = AnalysisRunSchema.parse({
        id: newId(),
        session_id: input.session_id,
        trigger: input.trigger,
        status: holdsSlot ? 'running' : 'queued',
        phase: null,
        config_revision: configRevision,
        model_profile_snapshot_id: profileSnapshot ? profileSnapshot.id : null,
        idempotency_key: input.idempotency_key ?? null,
        payload_hash: input.payload_hash ?? null,
        started_at: nowIso(),
        ended_at: null,
      });
      await this.#repository.runs.put(run);

      await this.#appendEvent({
        run_id: run.id,
        session_id: run.session_id,
        cell_id: null,
        execution_id: null,
        level: 'info',
        event: 'run.created',
        message: `Run 创建:trigger=${run.trigger}; config_revision=${run.config_revision}`,
      });

      if (holdsSlot) {
        await this.#acquireLease(run.session_id);
        await this.#appendEvent({
          run_id: run.id,
          session_id: run.session_id,
          cell_id: null,
          execution_id: null,
          level: 'info',
          event: 'run.started',
          message: 'Run 获得执行 lease(kernel slot)',
        });
      } else {
        await this.#appendEvent({
          run_id: run.id,
          session_id: run.session_id,
          cell_id: null,
          execution_id: null,
          level: 'warn',
          event: 'run.queued',
          message: `活跃 Kernel 数已达上限(${this.#maxActiveKernels}),Run 排队等待`,
        });
      }

      return { run, queued: !holdsSlot, busy_with_run_id: null };
    });
  }

  /** Run 进入终态(CAS:仅允许 queued/running/cancelling 迁移);释放 kernel slot 并尝试唤醒排队 Run。 */
  async finishRun(runId: string, status: RunTerminalStatus): Promise<AnalysisRun> {
    return this.#serialize(async () => {
      const run = await this.#requireRun(runId);
      if (!OPEN_RUN_STATUSES.has(run.status)) {
        throw err('CONFLICT', `Run 已处于终态 ${run.status},不可再次迁移`, {
          run_id: run.id,
          status: run.status,
        });
      }
      const finished: AnalysisRun = {
        ...run,
        status,
        ended_at: nowIso(),
      };
      await this.#repository.runs.put(finished);
      await this.#appendEvent({
        run_id: finished.id,
        session_id: finished.session_id,
        cell_id: null,
        execution_id: null,
        level: status === 'completed' ? 'info' : 'warn',
        event: `run.${status}`,
        message: `Run 终态:${status}`,
      });
      await this.#releaseLease(finished.session_id, status);
      await this.#dequeueNext();
      return finished;
    });
  }

  /**
   * 取消 Run:queued → cancelled(未执行,直接终态);
   * running → cancelling,并调用注册的取消回调;无法确认停止结果时
   * 按状态机落 interrupted(§12 cancelling → interrupted)。
   */
  async cancelRun(runId: string): Promise<{ run: AnalysisRun; confirmed: boolean }> {
    return this.#serialize(async () => {
      const run = await this.#requireRun(runId);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw err('CONFLICT', `Run 已处于终态 ${run.status},无法取消`, {
          run_id: run.id,
          status: run.status,
        });
      }
      if (run.status === 'queued') {
        const cancelled: AnalysisRun = { ...run, status: 'cancelled', ended_at: nowIso() };
        await this.#repository.runs.put(cancelled);
        await this.#appendEvent({
          run_id: cancelled.id,
          session_id: cancelled.session_id,
          cell_id: null,
          execution_id: null,
          level: 'info',
          event: 'run.cancelled',
          message: '排队中的 Run 已取消(未执行)',
        });
        return { run: cancelled, confirmed: true };
      }

      const cancelling: AnalysisRun = { ...run, status: 'cancelling' };
      await this.#repository.runs.put(cancelling);
      await this.#appendEvent({
        run_id: cancelling.id,
        session_id: cancelling.session_id,
        cell_id: null,
        execution_id: null,
        level: 'warn',
        event: 'run.cancelling',
        message: '收到取消请求:停止模型流与未执行工具,中断 Kernel 执行',
      });

      const handler = this.#cancelHandlers.get(run.id);
      let confirmed = false;
      if (handler) {
        try {
          confirmed = await handler();
        } catch {
          confirmed = false;
        }
      }
      const finalStatus: RunTerminalStatus = confirmed ? 'cancelled' : 'interrupted';
      const finished: AnalysisRun = {
        ...cancelling,
        status: finalStatus,
        ended_at: nowIso(),
      };
      await this.#repository.runs.put(finished);
      await this.#appendEvent({
        run_id: finished.id,
        session_id: finished.session_id,
        cell_id: null,
        execution_id: null,
        level: finalStatus === 'cancelled' ? 'info' : 'warn',
        event: `run.${finalStatus}`,
        message:
          finalStatus === 'cancelled'
            ? '取消完成;已完成产物保留,未提交产物标为 incomplete'
            : '无法确认停止结果,Run 标记 interrupted;Kernel state_dirty=true',
      });
      await this.#releaseLease(finished.session_id, finalStatus);
      await this.#dequeueNext();
      return { run: finished, confirmed };
    });
  }

  /** 由执行层(serve/Notebook 适配)注册 Run 级取消回调;返回 true 表示已确认停止。 */
  registerCancelHandler(runId: string, handler: () => Promise<boolean>): void {
    this.#cancelHandlers.set(runId, handler);
  }

  /** Run 执行结束后注销取消回调,避免 Map 随 Run 数量增长。 */
  unregisterCancelHandler(runId: string): void {
    this.#cancelHandlers.delete(runId);
  }

  /** 执行层订阅排队 Run 唤醒事件;传 null 取消订阅。仅 #dequeueNext 触发。 */
  setRunStartedListener(listener: ((run: AnalysisRun) => void) | null): void {
    this.#onRunStarted = listener;
  }

  async listRuns(sessionId?: string): Promise<AnalysisRun[]> {
    const runs = await this.#repository.runs.list();
    const filtered = sessionId ? runs.filter((run) => run.session_id === sessionId) : runs;
    return filtered.sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  async getRun(runId: string): Promise<AnalysisRun> {
    return this.#requireRun(runId);
  }

  // ------------------------------ 日志关联 -----------------------------------

  async appendEvent(input: {
    run_id: string | null;
    session_id: string | null;
    cell_id?: string | null;
    execution_id?: string | null;
    level?: RunEvent['level'];
    event: string;
    message: string;
  }): Promise<RunEvent> {
    return this.#appendEvent({
      run_id: input.run_id,
      session_id: input.session_id,
      cell_id: input.cell_id ?? null,
      execution_id: input.execution_id ?? null,
      level: input.level ?? 'info',
      event: input.event,
      message: input.message,
    });
  }

  async eventsForRun(runId: string): Promise<RunEvent[]> {
    const events = await this.#repository.runEvents.list();
    return events
      .filter((event) => event.run_id === runId)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  // ------------------------------ 内部实现 -----------------------------------

  async #appendEvent(input: {
    run_id: string | null;
    session_id: string | null;
    cell_id: string | null;
    execution_id: string | null;
    level: RunEvent['level'];
    event: string;
    message: string;
  }): Promise<RunEvent> {
    const event: RunEvent = RunEventSchema.parse({
      id: newId(),
      run_id: input.run_id,
      session_id: input.session_id,
      cell_id: input.cell_id,
      execution_id: input.execution_id,
      level: input.level,
      event: input.event,
      message: input.message.slice(0, 2000),
      at: nowIso(),
    });
    await this.#repository.runEvents.put(event);
    return event;
  }

  async #requireRun(runId: string): Promise<AnalysisRun> {
    const run = await this.#repository.runs.get(runId);
    if (!run) throw err('NOT_FOUND', `Run 不存在: ${runId}`);
    return run;
  }

  /** 当前持有活跃 Kernel 租约的 Session 集合。 */
  async #activeKernelSessions(): Promise<Set<string>> {
    const leases = await this.#repository.kernelLeases.list();
    return new Set(
      leases.filter((lease) => ACTIVE_LEASE_STATES.has(lease.status)).map((l) => l.session_id),
    );
  }

  async #acquireLease(sessionId: string): Promise<KernelLease> {
    const existing = await this.#repository.kernelLeases.get(sessionId);
    const lease: KernelLease = KernelLeaseSchema.parse({
      session_id: sessionId,
      kernel_id: existing?.kernel_id ?? `kernel-${sessionId}`,
      epoch: existing ? existing.epoch + 1 : 1,
      status: 'busy',
      state_dirty: existing?.status === 'failed' ? true : (existing?.state_dirty ?? false),
      last_used_at: nowIso(),
    });
    await this.#repository.kernelLeases.put(lease);
    return lease;
  }

  async #releaseLease(sessionId: string, status: RunTerminalStatus): Promise<void> {
    const existing = await this.#repository.kernelLeases.get(sessionId);
    if (!existing) return;
    // 本地适配的 Kernel 为单次执行:Run 结束即释放(不再计入活跃 Kernel 数);
    // DSH 持久 Kernel 的 idle 回收由其生命周期承接,此处统一落 stopped。
    await this.#repository.kernelLeases.put({
      ...existing,
      status: 'stopped',
      state_dirty: status === 'failed' || status === 'interrupted' ? true : existing.state_dirty,
      last_used_at: nowIso(),
    });
  }

  /** 有空闲 slot 时按 FIFO 唤醒最早排队且未取消的 Run。 */
  async #dequeueNext(): Promise<void> {
    const active = await this.#activeKernelSessions();
    if (active.size >= this.#maxActiveKernels) return;
    const queued = (await this.#repository.runs.list())
      .filter((run) => run.status === 'queued')
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
    for (const run of queued) {
      if (active.has(run.session_id)) continue;
      const started: AnalysisRun = { ...run, status: 'running' };
      await this.#repository.runs.put(started);
      await this.#acquireLease(run.session_id);
      await this.#appendEvent({
        run_id: started.id,
        session_id: started.session_id,
        cell_id: null,
        execution_id: null,
        level: 'info',
        event: 'run.started',
        message: '排队 Run 获得执行 lease(kernel slot)',
      });
      active.add(run.session_id);
      this.#onRunStarted?.(started);
      if (active.size >= this.#maxActiveKernels) break;
    }
  }
}
