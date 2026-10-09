// ---------------------------------------------------------------------------
// §10 数据发送边界:Agent 可将字段信息、质量摘要和受限样本发送到配置的模型
// Endpoint。默认每次数据摘要最多 maxRows 行、每个字段最多 maxCellChars 字符
// (§18 model_sample_rows=20 / model_sample_cell_chars=200)。敏感列由
// Workspace 规则屏蔽;只有在此边界内构造的内容才允许进入模型上下文。
// ---------------------------------------------------------------------------

export interface ModelSampleLimits {
  /** §18 data.model_sample_rows */
  maxRows: number;
  /** §18 data.model_sample_cell_chars */
  maxCellChars: number;
}

export interface ModelSample {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  /** 输入行数超过上限被截断 */
  truncated: boolean;
  /** 输入总行数(截断前) */
  totalRows: number;
  /** 被屏蔽的敏感列名 */
  maskedColumns: string[];
}

const MASKED = '[屏蔽]';

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 将表格行构造为受限模型样本:行数与单元格字符数双重上限,
 * 敏感列值替换为固定标记(保留列名,便于模型理解 schema)。
 */
export function buildModelSample(
  columns: string[],
  rows: Array<Record<string, unknown>>,
  limits: ModelSampleLimits,
  sensitiveColumns: ReadonlySet<string> = new Set(),
): ModelSample {
  const maskedColumns = columns.filter((column) => sensitiveColumns.has(column));
  const limitedRows = rows.slice(0, limits.maxRows);
  return {
    columns,
    rows: limitedRows.map((row) =>
      columns.map((column) => {
        if (sensitiveColumns.has(column)) return MASKED;
        const text = cellToString(row[column]);
        return text.length > limits.maxCellChars ? text.slice(0, limits.maxCellChars) : text;
      }),
    ),
    truncated: rows.length > limits.maxRows,
    totalRows: rows.length,
    maskedColumns,
  };
}
