import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// 计划 W10:纯 TS 比率计算 vs 固定预期值。总转化率 = 总成交 / 总访客,
// 绝不平均各渠道比率(设计文档数值示例:17.5% / 8.333333% / 13.5714%)。
// 零分母 → null(不可计算,不得伪造 0);缺失(NULL)单元格 → 该行不计入;
// 负访客数 → 抛错(数据质量违规)。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(resolve(join(here, '..', 'fixtures', name)), 'utf8');

interface SalesRow {
  channel: string;
  visitors: number | null;
  conversions: number | null;
}

function parseSales(csv: string): SalesRow[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0];
  if (header !== 'channel,visitors,conversions') {
    throw new Error(`意外的 CSV 头: ${header}`);
  }
  return lines.slice(1).map((line) => {
    const [channel, visitors, conversions] = line.split(',');
    return {
      channel,
      visitors: visitors === '' ? null : Number(visitors),
      conversions: conversions === '' ? null : Number(conversions),
    };
  });
}

function conversionRate(rows: SalesRow[], channel: string): number | null {
  let visitors = 0;
  let conversions = 0;
  for (const row of rows) {
    if (row.channel !== channel) continue;
    if (row.visitors === null || row.conversions === null) continue; // NULL 行不计入
    if (row.visitors < 0) throw new Error(`负访客数: ${channel}`);
    visitors += row.visitors;
    conversions += row.conversions;
  }
  return visitors === 0 ? null : conversions / visitors; // 零分母不可计算
}

function overallRate(rows: SalesRow[]): number | null {
  let visitors = 0;
  let conversions = 0;
  for (const row of rows) {
    if (row.visitors === null || row.conversions === null) continue;
    if (row.visitors < 0) throw new Error('负访客数');
    visitors += row.visitors;
    conversions += row.conversions;
  }
  return visitors === 0 ? null : conversions / visitors;
}

describe('比率计算(§设计数值示例)', () => {
  const rows = parseSales(fixture('fixture_sales.csv'));

  it('渠道 A = 70/400 = 17.5%', () => {
    expect(conversionRate(rows, 'A')).toBeCloseTo(0.175, 12);
  });

  it('渠道 B = 25/300 = 8.333333%', () => {
    expect(conversionRate(rows, 'B')).toBeCloseTo(25 / 300, 12);
  });

  it('总体 = 95/700 = 13.5714%,且不等于渠道比率均值', () => {
    const overall = overallRate(rows);
    expect(overall).toBeCloseTo(95 / 700, 12);
    const meanOfRates = (0.175 + 25 / 300) / 2;
    expect(overall).not.toBeCloseTo(meanOfRates, 3);
  });
});

describe('边界(零分母 / NULL / 负值)', () => {
  const rows = parseSales(fixture('fixture_edge.csv'));

  it('NULL 单元格行不计入,B 仍为 25/200 = 12.5%', () => {
    expect(conversionRate(rows, 'B')).toBeCloseTo(0.125, 12);
  });

  it('零分母渠道 → null,绝不伪造 0', () => {
    expect(conversionRate(rows, 'A')).toBeNull();
  });

  it('未出现的渠道 → null', () => {
    expect(conversionRate(rows, 'MISSING')).toBeNull();
  });

  it('负访客数 → 抛错', () => {
    expect(() => overallRate(rows)).toThrowError(/负访客数/);
  });
});
