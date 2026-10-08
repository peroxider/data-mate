// ---------------------------------------------------------------------------
// 确定性 CSV 序列化:SQL 查询结果与派生数据物化为版本文件的唯一写出实现。
// RFC4180 引号转义;行尾 \n;null → 空字段;数值经 String() 保持确定表示。
// ---------------------------------------------------------------------------

export function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Uint8Array) {
    return Array.from(value)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export function csvField(value: unknown): string {
  const text = formatCsvValue(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function toCsv(columns: string[], rows: Array<Array<unknown>>): string {
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) {
    if (row.length !== columns.length) {
      throw new Error(`CSV 行字段数与列数不一致: ${row.length} != ${columns.length}`);
    }
    lines.push(row.map(csvField).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export type InferredColumnType = 'number' | 'boolean' | 'datetime' | 'string';

const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** 列类型推断:全数值 → number;全布尔 → boolean;全 ISO 日期 → datetime;否则 string。 */
export function inferColumnType(values: Array<unknown>): InferredColumnType {
  let sawAny = false;
  let isNumber = true;
  let isBoolean = true;
  let isDatetime = true;
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    sawAny = true;
    if (
      isNumber &&
      !(typeof value === 'number' && Number.isFinite(value)) &&
      !(typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    ) {
      isNumber = false;
    }
    if (isBoolean && typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
      isBoolean = false;
    }
    if (isDatetime && !(typeof value === 'string' && DATETIME_PATTERN.test(value))) {
      isDatetime = false;
    }
    if (!isNumber && !isBoolean && !isDatetime) break;
  }
  if (!sawAny) return 'string';
  if (isNumber) return 'number';
  if (isBoolean) return 'boolean';
  if (isDatetime) return 'datetime';
  return 'string';
}

export interface ColumnProfile {
  name: string;
  type: InferredColumnType;
  null_count: number;
}

export function inferColumnProfiles(
  columns: string[],
  rows: Array<Array<unknown>>,
): ColumnProfile[] {
  return columns.map((name, index) => {
    const values = rows.map((row) => row[index]);
    return {
      name,
      type: inferColumnType(values),
      null_count: values.filter(
        (value) => value === null || value === undefined || value === '',
      ).length,
    };
  });
}
