import { describe, expect, it } from 'vitest';
import { ModelProfileSchema, SessionBindingSchema, WorkspaceSchema } from '@data-analyst/contracts';
import type { ModelProfile, SessionBinding, Workspace } from '@data-analyst/contracts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRepository } from './repository.js';
import { RunGovernor } from './run-governance.js';

async function seed(): Promise<{
  repository: InMemoryRepository;
  workspace: Workspace;
  sessions: SessionBinding[];
  profile: ModelProfile;
}> {
  const repository = new InMemoryRepository();
  const workspace: Workspace = WorkspaceSchema.parse({
    id: '00000000-0000-4000-8000-00000000a001',
    name: 'm3-test',
    root: '00000000-0000-4000-8000-00000000a001',
    created_at: '2026-10-08T00:00:00.000Z',
    state: 'active',
  });
  await repository.workspaces.put(workspace);
  const sessions: SessionBinding[] = [];
  for (const suffix of ['b001', 'b002', 'b003']) {
    const session: SessionBinding = SessionBindingSchema.parse({
      id: `00000000-0000-4000-8000-00000000${suffix}`,
      dsh_session_id: `local-${suffix}`,
      workspace_id: workspace.id,
      notebook_id: null,
      model_profile_id: null,
      created_at: '2026-10-08T00:00:00.000Z',
    });
    await repository.sessions.put(session);
    sessions.push(session);
  }
  const profile: ModelProfile = ModelProfileSchema.parse({
    id: '00000000-0000-4000-8000-00000000c001',
    revision: 2,
    protocol: 'openai-chat',
    base_url: 'http://127.0.0.1:8000/v1',
    model: 'analyst-model',
    credential_ref: 'env:MODEL_API_KEY',
    capabilities: { streaming: 'required', tool_calling: 'required', vision: 'disabled' },
    config_hash: 'a'.repeat(64),
    created_at: '2026-10-08T00:00:00.000Z',
  });
  await repository.modelProfiles.put(profile);
  return { repository, workspace, sessions, profile };
}

const PROFILE_ID = '00000000-0000-4000-8000-00000000c001';

describe('RunGovernor(§13 运行治理)', () => {
  it('同 Session 并发 Run → SESSION_BUSY 且携带当前 run_id', async () => {
    const { repository, sessions } = await seed();
    const governor = new RunGovernor({ repository, maxActiveKernels: 2 });
    const first = await governor.beginRun({
      session_id: sessions[0]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });
    expect(first.queued).toBe(false);

    await expect(
      governor.beginRun({
        session_id: sessions[0]!.id,
        trigger: 'user_message',
        model_profile_id: null,
      }),
    ).rejects.toMatchObject({
      payload: expect.objectContaining({
        code: 'SESSION_BUSY',
        details: expect.objectContaining({ current_run_id: first.run.id }),
      }),
    });
  });

  it('Kernel 数量上限:超出上限的 Session 排队,释放 slot 后 FIFO 唤醒', async () => {
    const { repository, sessions } = await seed();
    const governor = new RunGovernor({ repository, maxActiveKernels: 1 });

    const first = await governor.beginRun({
      session_id: sessions[0]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });
    expect(first.run.status).toBe('running');

    const second = await governor.beginRun({
      session_id: sessions[1]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });
    expect(second.queued).toBe(true);
    expect(second.run.status).toBe('queued');

    await governor.finishRun(first.run.id, 'completed');
    const awakened = await governor.getRun(second.run.id);
    expect(awakened.status).toBe('running');

    const events = await governor.eventsForRun(second.run.id);
    expect(events.map((event) => event.event)).toContain('run.queued');
    expect(events.map((event) => event.event)).toContain('run.started');
  });

  it('配置 revision 快照:进行中 Run 保持启动时版本,新 Run 采用新 revision(T12)', async () => {
    const { repository, sessions, profile } = await seed();
    const governor = new RunGovernor({ repository, maxActiveKernels: 2 });

    const first = await governor.beginRun({
      session_id: sessions[0]!.id,
      trigger: 'user_message',
      model_profile_id: PROFILE_ID,
    });
    expect(first.run.config_revision).toBe(2);

    // 模型配置更新:revision 2 → 3(同 id 递增)
    await repository.modelProfiles.put({ ...profile, revision: 3, model: 'analyst-model-v2' });

    const second = await governor.beginRun({
      session_id: sessions[1]!.id,
      trigger: 'user_message',
      model_profile_id: PROFILE_ID,
    });
    expect(second.run.config_revision).toBe(3);

    // 首个 Run 的快照仍指向 revision=2 的不可变快照行
    const snapshot = await repository.modelProfiles.get(first.run.model_profile_snapshot_id!);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.revision).toBe(2);
    expect(snapshot!.model).toBe('analyst-model');

    await governor.finishRun(first.run.id, 'completed');
    await governor.finishRun(second.run.id, 'completed');
  });

  it('取消:queued → cancelled;running 无确认回调 → interrupted;lease 标记 state_dirty', async () => {
    const { repository, sessions } = await seed();
    const governor = new RunGovernor({ repository, maxActiveKernels: 2 });

    const runningA = await governor.beginRun({
      session_id: sessions[0]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });
    const runningB = await governor.beginRun({
      session_id: sessions[1]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });
    const queuedC = await governor.beginRun({
      session_id: sessions[2]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });
    expect(queuedC.run.status).toBe('queued');

    const cancelQueued = await governor.cancelRun(queuedC.run.id);
    expect(cancelQueued.confirmed).toBe(true);
    expect(cancelQueued.run.status).toBe('cancelled');

    const cancelRunning = await governor.cancelRun(runningB.run.id);
    expect(cancelRunning.confirmed).toBe(false);
    expect(cancelRunning.run.status).toBe('interrupted');
    const lease = await repository.kernelLeases.get(sessions[1]!.id);
    expect(lease?.state_dirty).toBe(true);

    await governor.finishRun(runningA.run.id, 'completed');
  });

  it('取消确认回调:confirmed → cancelled(FR15/T18)', async () => {
    const { repository, sessions } = await seed();
    const governor = new RunGovernor({ repository, maxActiveKernels: 2 });
    const begun = await governor.beginRun({
      session_id: sessions[0]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });
    governor.registerCancelHandler(begun.run.id, async () => true);
    const outcome = await governor.cancelRun(begun.run.id);
    expect(outcome.confirmed).toBe(true);
    expect(outcome.run.status).toBe('cancelled');
  });

  it('启动对账:遗留 running/queued Run 与旧租约进入终态,不进入新 Run', async () => {
    const { repository, sessions } = await seed();
    const governor = new RunGovernor({ repository, maxActiveKernels: 2 });
    const a = await governor.beginRun({
      session_id: sessions[0]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });
    const b = await governor.beginRun({
      session_id: sessions[1]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });

    // 模拟上一进程崩溃后的持久化状态:两个 Run 均未到终态
    await repository.runs.put({ ...a.run, status: 'running', ended_at: null });
    await repository.runs.put({ ...b.run, status: 'queued', ended_at: null });

    const recovery = await new RunGovernor({ repository, maxActiveKernels: 2 }).recoverOnStartup();
    expect(recovery.interruptedRuns).toBe(1);
    expect(recovery.cancelledQueued).toBe(1);
    expect(recovery.stoppedLeases).toBeGreaterThanOrEqual(2);

    const runA = await governor.getRun(a.run.id);
    const runB = await governor.getRun(b.run.id);
    expect(runA.status).toBe('interrupted');
    expect(runB.status).toBe('cancelled');

    // 终态不可回退:再次 finish 被拒绝
    await expect(governor.finishRun(a.run.id, 'completed')).rejects.toMatchObject({
      payload: expect.objectContaining({ code: 'CONFLICT' }),
    });

    // 对账后可正常开启新 Run
    const fresh = await governor.beginRun({
      session_id: sessions[0]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });
    expect(fresh.run.status).toBe('running');
  });

  it('Session/Profile 不存在的错误语义', async () => {
    const { repository } = await seed();
    const governor = new RunGovernor({ repository, maxActiveKernels: 2 });
    await expect(
      governor.beginRun({
        session_id: '00000000-0000-4000-8000-00000000ffff',
        trigger: 'user_message',
        model_profile_id: null,
      }),
    ).rejects.toMatchObject({ payload: expect.objectContaining({ code: 'NOT_FOUND' }) });
    await expect(
      governor.beginRun({
        session_id: '00000000-0000-4000-8000-0000000000b003',
        trigger: 'user_message',
        model_profile_id: '00000000-0000-4000-8000-00000000ffff',
      }),
    ).rejects.toMatchObject({ payload: expect.objectContaining({ code: 'NOT_FOUND' }) });
  });

  it('run_events 与租约通过快照持久化往返', async () => {
    const { repository, sessions } = await seed();
    const governor = new RunGovernor({ repository, maxActiveKernels: 1 });
    const begun = await governor.beginRun({
      session_id: sessions[0]!.id,
      trigger: 'user_message',
      model_profile_id: null,
    });
    await governor.finishRun(begun.run.id, 'completed');
    const before = await governor.eventsForRun(begun.run.id);
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(before.every((event) => event.session_id === sessions[0]!.id)).toBe(true);

    const dir = await mkdtemp(join(tmpdir(), 'run-events-'));
    const snapshotFile = join(dir, 'state.json');
    await repository.snapshotTo(snapshotFile);
    const restored = new InMemoryRepository();
    await restored.restoreFrom(snapshotFile);
    const events = await restored.runEvents.list();
    expect(events.length).toBe(before.length);
    expect(new Set(events.map((event) => event.event))).toEqual(
      new Set(before.map((event) => event.event)),
    );
    const leases = await restored.kernelLeases.list();
    expect(leases).toHaveLength(1);
    expect(leases[0]!.status).toBe('stopped');
  });
});
