import { describe, expect, it } from 'vitest';
import { csvField, inferColumnProfiles, inferColumnType, toCsv } from './csv-write.js';
import { scanCsvFile } from './csv-scan.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('csv-write(确定性 CSV 序列化)', () => {
  it('基本行列序列化并可与 csv-scan 互逆', async () => {
    const csv = toCsv(['channel', 'visitors', 'orders'], [
      ['organic', 1200, 96],
      ['paid', 800, 40],
    ]);
    expect(csv).toBe('channel,visitors,orders\norganic,1200,96\npaid,800,40\n');

    const dir = await mkdtemp(join(tmpdir(), 'csv-write-'));
    const file = join(dir, 'roundtrip.csv');
    await writeFile(file, csv, 'utf8');
    const scan = await scanCsvFile(file, { delimiter: ',', maxBytes: 1024 * 1024, maxRows: 100 });
    expect(scan.row_count).toBe(2);
    expect(scan.columns.map((column) => column.name)).toEqual(['channel', 'visitors', 'orders']);
    expect(scan.columns.map((column) => column.inferred_type)).toEqual(['string', 'integer', 'integer']);
  });

  it('含逗号、引号与换行的字段正确转义', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(toCsv(['a', 'b'], [['x,y', null]])).toBe('a,b\n"x,y",\n');
  });

  it('数值、布尔、二进制与 null 的确定表示', () => {
    expect(toCsv(['n', 'b', 'blob', 'z'], [[12.5, true, new Uint8Array([0x01, 0xff]), null]])).toBe(
      'n,b,blob,z\n12.5,true,01ff,\n',
    );
  });

  it('列类型推断:number / boolean / datetime / string', () => {
    expect(inferColumnType([1, 2.5, null])).toBe('number');
    expect(inferColumnType(['3', '4'])).toBe('number');
    expect(inferColumnType([true, 'false', null])).toBe('boolean');
    expect(inferColumnType(['2026-10-08', '2026-10-09T00:00:00Z'])).toBe('datetime');
    expect(inferColumnType(['abc', '123'])).toBe('string');
    expect(inferColumnType([null, null])).toBe('string');
  });

  it('inferColumnProfiles 统计 null 计数', () => {
    expect(inferColumnProfiles(['a', 'b'], [[1, null], [2, 'x'], [null, 'y']])).toEqual([
      { name: 'a', type: 'number', null_count: 1 },
      { name: 'b', type: 'string', null_count: 1 },
    ]);
  });

  it('字段数不一致时拒绝写出', () => {
    expect(() => toCsv(['a', 'b'], [[1]])).toThrow(/字段数/);
  });

  it('读取文件回归:scanCsvFile 解析 csv-write 输出', async () => {
    const csv = toCsv(['text'], [['包含"引号"与,逗号']]);
    const dir = await mkdtemp(join(tmpdir(), 'csv-write-'));
    const file = join(dir, 'quoted.csv');
    await writeFile(file, csv, 'utf8');
    const scan = await scanCsvFile(file, { delimiter: ',', maxBytes: 1024 * 1024, maxRows: 10 });
    const parsed = await readFile(file, 'utf8');
    expect(parsed).toContain('"包含""引号""与,逗号"');
    expect(scan.row_count).toBe(1);
  });
});
