import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** UUIDv4 — 所有持久实体的主键形态(§8)。 */
export const UuidSchema = z.uuid();

/** UTC RFC3339 时间字符串,如 2026-10-08T08:00:00.000Z。 */
export const IsoDatetimeSchema = z.iso.datetime();

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
