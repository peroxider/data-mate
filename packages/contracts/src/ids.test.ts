import { describe, expect, it } from 'vitest';
import { IsoDatetimeSchema, UuidSchema, newId, nowIso } from './ids.js';

// ---------------------------------------------------------------------------
// §8 主键与时间戳形态:UUIDv4 + UTC RFC3339。
// ---------------------------------------------------------------------------

describe('newId', () => {
  it('产生合法 UUID', () => {
    expect(UuidSchema.safeParse(newId()).success).toBe(true);
  });

  it('两次调用不重复', () => {
    expect(newId()).not.toBe(newId());
  });
});

describe('nowIso', () => {
  it('产生 UTC RFC3339 时间戳', () => {
    const value = nowIso();
    expect(IsoDatetimeSchema.safeParse(value).success).toBe(true);
    expect(value.endsWith('Z')).toBe(true);
  });
});
