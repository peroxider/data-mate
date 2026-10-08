import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256File } from './hashing.js';

// ---------------------------------------------------------------------------
// §21 组件冻结的完整性证据:流式 SHA-256 与 node:crypto 结果一致。
// ---------------------------------------------------------------------------

let file: string;
let expected: string;
const content = 'fixture-content-§21-0123456789\n'.repeat(500);

beforeAll(async () => {
  file = join(mkdtempSync(join(tmpdir(), 'da-hash-')), 'blob.bin');
  await writeFile(file, content, 'utf8');
  expected = createHash('sha256').update(content, 'utf8').digest('hex');
});

describe('sha256File', () => {
  it('与 createHash 全量结果一致', async () => {
    await expect(sha256File(file)).resolves.toBe(expected);
  });

  it('对不存在文件 reject', async () => {
    await expect(sha256File(join(tmpdir(), 'da-hash-missing.bin'))).rejects.toThrowError();
  });
});
