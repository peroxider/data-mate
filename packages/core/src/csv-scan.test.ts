import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanCsvFile } from './csv-scan.js';

const limits = { delimiter: ',', maxBytes: 1024 * 1024, maxRows: 10_000 };
const dirs: string[] = [];

async function tempCsv(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csv-scan-'));
  dirs.push(dir);
  const path = join(dir, 'data.csv');
  await writeFile(path, content, 'utf8');
  return path;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scanCsvFile', () => {
  it('精确计数并推断列类型', async () => {
    const path = await tempCsv(
      ['channel,visitors,conversions', 'A,100,10', 'A,300,60', 'B,200,20', 'B,100,5'].join('\n'),
    );
    const result = await scanCsvFile(path, limits);
    expect(result.header).toEqual(['channel', 'visitors', 'conversions']);
    expect(result.row_count).toBe(4);
    expect(result.columns.map((c) => c.inferred_type)).toEqual(['string', 'integer', 'integer']);
    expect(result.columns.map((c) => c.null_count)).toEqual([0, 0, 0]);
  });

  it('处理引号字段、转义引号与 CRLF', async () => {
    const path = await tempCsv('name,note\r\n"a,","say ""hi"""\r\nb,plain\r\n');
    const result = await scanCsvFile(path, limits);
    expect(result.row_count).toBe(2);
    expect(result.field_count_mismatch_rows).toBe(0);
  });

  it('缺失单元格计入 null_count,类型正确拓宽', async () => {
    const path = await tempCsv(
      ['v,label,flag', '1,x,true', '2.5,,false', ',y,true', '3.25,z,TRUE'].join('\n'),
    );
    const result = await scanCsvFile(path, limits);
    const byName = new Map(result.columns.map((c) => [c.name, c]));
    expect(byName.get('v')?.inferred_type).toBe('number');
    expect(byName.get('v')?.null_count).toBe(1);
    expect(byName.get('label')?.inferred_type).toBe('string');
    expect(byName.get('label')?.null_count).toBe(1);
    expect(byName.get('flag')?.inferred_type).toBe('boolean');
  });

  it('字段数不一致的行被统计而非中断', async () => {
    const path = await tempCsv('a,b\n1,2\n3\n4,5,6\n');
    const result = await scanCsvFile(path, limits);
    expect(result.row_count).toBe(3);
    expect(result.field_count_mismatch_rows).toBe(2);
  });

  it('拒绝二进制内容(DATA_FORMAT)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csv-scan-'));
    dirs.push(dir);
    const path = join(dir, 'data.csv');
    await writeFile(path, Buffer.from([0x50, 0x00, 0x52, 0x31]));
    await expect(scanCsvFile(path, limits)).rejects.toMatchObject({
      payload: { code: 'UNPROCESSABLE', details: { reason: 'DATA_FORMAT' } },
    });
  });

  it('拒绝未闭合引号', async () => {
    const path = await tempCsv('a,b\n"open,2\n');
    await expect(scanCsvFile(path, limits)).rejects.toMatchObject({
      payload: { code: 'UNPROCESSABLE' },
    });
  });

  it('超出行数上限返回 PAYLOAD_TOO_LARGE', async () => {
    const path = await tempCsv('a\n1\n2\n3\n');
    await expect(scanCsvFile(path, { ...limits, maxRows: 2 })).rejects.toMatchObject({
      payload: { code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  it('TSV 分隔符生效', async () => {
    const path = await tempCsv('a\tb\n1\t2\n');
    const result = await scanCsvFile(path, { ...limits, delimiter: '\t' });
    expect(result.header).toEqual(['a', 'b']);
    expect(result.row_count).toBe(1);
  });
});
