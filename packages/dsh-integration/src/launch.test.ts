import { describe, expect, it } from 'vitest';
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalystError } from '@data-analyst/contracts';
import type { ProductConfig } from '@data-analyst/contracts';
import { buildDshLaunchArgs, resolveDshBin } from './launch.js';

const config = {
  runtime: { profile: 'data-analysis' },
} as ProductConfig;

describe('buildDshLaunchArgs', () => {
  it('生成 profile argv', () => {
    expect(buildDshLaunchArgs(config)).toEqual(['--profile', 'data-analysis']);
  });
});

describe('resolveDshBin', () => {
  it('显式路径存在且可执行时直接返回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bin-'));
    const bin = join(dir, 'dsh');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    try {
      expect(resolveDshBin({ explicit: bin })).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PATH 扫描命中', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-path-'));
    const bin = join(dir, 'dsh');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    try {
      expect(resolveDshBin({ path: dir })).toBe(bin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('找不到时抛 ENVIRONMENT_INCOMPLETE(绝不回退 npx)', () => {
    try {
      resolveDshBin({ explicit: undefined, env: { PATH: '' } });
      expect.unreachable('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalystError);
      expect((error as AnalystError).payload.code).toBe('ENVIRONMENT_INCOMPLETE');
    }
  });
});
