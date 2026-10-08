import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AnalystError, type KernelLease, type Workspace } from '@data-analyst/contracts';
import { newId, nowIso } from '@data-analyst/contracts';
import { InMemoryRepository } from './repository.js';

// ---------------------------------------------------------------------------
// §9 Repository 端口的内存实现。KernelLease 以 session_id 为主键(§8 一
// Session 一租约);快照往返保证恢复后实体通过 Schema 校验。
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'da-repo-'));
});

function workspace(): Workspace {
  return { id: newId(), name: 'ws', root: `workspaces/${newId()}`, created_at: nowIso(), state: 'active' };
}

function lease(sessionId = newId()): KernelLease {
  return {
    session_id: sessionId,
    kernel_id: `k-${sessionId.slice(0, 8)}`,
    epoch: 0,
    status: 'idle',
    state_dirty: false,
    last_used_at: nowIso(),
  };
}

describe('InMemoryRepository.workspaces', () => {
  it('put/get/list/delete 往返', async () => {
    const repo = new InMemoryRepository();
    const ws = workspace();
    await repo.workspaces.put(ws);
    expect(await repo.workspaces.get(ws.id)).toEqual(ws);
    expect(await repo.workspaces.list()).toEqual([ws]);
    expect(await repo.workspaces.delete(ws.id)).toBe(true);
    expect(await repo.workspaces.get(ws.id)).toBeNull();
    expect(await repo.workspaces.delete(ws.id)).toBe(false);
  });
});

describe('InMemoryRepository.kernelLeases', () => {
  it('以 session_id 为主键(§8 一 Session 一租约)', async () => {
    const repo = new InMemoryRepository();
    const a = lease();
    const b = lease();
    await repo.kernelLeases.put(a);
    await repo.kernelLeases.put(b);
    expect(await repo.kernelLeases.get(a.session_id)).toEqual(a);
    expect(await repo.kernelLeases.get(b.session_id)).toEqual(b);
    expect((await repo.kernelLeases.list()).length).toBe(2);
  });
});

describe('快照往返', () => {
  it('snapshotTo → restoreFrom 保留全部实体', async () => {
    const repo = new InMemoryRepository();
    const ws = workspace();
    const ks = lease();
    await repo.workspaces.put(ws);
    await repo.kernelLeases.put(ks);
    const snap = join(dir, 'snapshot.json');
    await repo.snapshotTo(snap);

    const restored = new InMemoryRepository();
    await restored.restoreFrom(snap);
    expect(await restored.workspaces.get(ws.id)).toEqual(ws);
    expect(await restored.kernelLeases.get(ks.session_id)).toEqual(ks);
  });

  it('快照中含非法实体 → CONFIG_INVALID', async () => {
    const snap = join(dir, 'bad.json');
    writeFileSync(
      snap,
      JSON.stringify({
        schema_version: 1,
        saved_at: nowIso(),
        collections: { workspaces: [{ id: 'not-a-uuid', name: 'x', root: 'r', created_at: 'nope', state: 'active' }] },
      }),
      'utf8',
    );
    const repo = new InMemoryRepository();
    try {
      await repo.restoreFrom(snap);
      expect.unreachable('应当抛出 CONFIG_INVALID');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalystError);
      expect((error as AnalystError).payload.code).toBe('CONFIG_INVALID');
    }
  });

  it('快照文件不存在 → NOT_FOUND;坏 JSON / 错 schema_version → CONFIG_INVALID', async () => {
    const repo = new InMemoryRepository();
    await expect(repo.restoreFrom(join(dir, 'missing.json'))).rejects.toMatchObject({
      payload: { code: 'NOT_FOUND' },
    });

    const badJson = join(dir, 'bad-json.json');
    writeFileSync(badJson, '{not json', 'utf8');
    await expect(repo.restoreFrom(badJson)).rejects.toMatchObject({
      payload: { code: 'CONFIG_INVALID' },
    });

    const badVersion = join(dir, 'bad-version.json');
    writeFileSync(badVersion, JSON.stringify({ schema_version: 99, saved_at: nowIso(), collections: {} }), 'utf8');
    await expect(repo.restoreFrom(badVersion)).rejects.toMatchObject({
      payload: { code: 'CONFIG_INVALID' },
    });
  });
});
