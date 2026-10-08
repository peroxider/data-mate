import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { AnalystError } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §11 导入过程:CSV/TSV 流式扫描。RFC4180 状态机(引号、转义引号、CRLF/LF),
// 单遍完成精确行数与列类型/缺失统计,不整读文件入内存。
// ---------------------------------------------------------------------------

export type InferredType = 'integer' | 'number' | 'boolean' | 'string';

export interface CsvColumnStat {
  name: string;
  inferred_type: InferredType;
  null_count: number;
}

export interface CsvScanResult {
  header: string[];
  /** 不含表头的数据行数(精确,RFC4180 语义) */
  row_count: number;
  columns: CsvColumnStat[];
  delimiter: string;
  /** 字段数与表头不一致的数据行数(>0 时写入 manifest) */
  field_count_mismatch_rows: number;
}

const TYPE_RANK: Record<InferredType, number> = { boolean: 0, integer: 1, number: 2, string: 3 };

const BOOLEAN_VALUES = new Set(['true', 'false']);
const INTEGER_RE = /^[+-]?\d{1,15}$/; // ≤15 位:保持在 IEEE754 安全整数范围内
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function inferCell(cell: string): InferredType | null {
  if (cell === '') return null;
  if (BOOLEAN_VALUES.has(cell.toLowerCase())) return 'boolean';
  if (INTEGER_RE.test(cell)) return 'integer';
  if (NUMBER_RE.test(cell)) return 'number';
  return 'string';
}

function widen(current: InferredType, next: InferredType): InferredType {
  return TYPE_RANK[next] > TYPE_RANK[current] ? next : current;
}

function dataFormatError(message: string): AnalystError {
  return new AnalystError({
    code: 'UNPROCESSABLE',
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details: { reason: 'DATA_FORMAT' },
  });
}

function payloadTooLarge(message: string, details: Record<string, unknown>): AnalystError {
  return new AnalystError({
    code: 'PAYLOAD_TOO_LARGE',
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details,
  });
}

interface RecordParser {
  feed(text: string): string[][];
  finish(): string[][];
}

/** 增量字符状态机;feed 返回在此批次中完成的记录(字段数组)。 */
function createRecordParser(delimiter: string): RecordParser {
  type State = 'normal' | 'quoted' | 'after_quote';
  let state: State = 'normal';
  let lastWasCR = false;
  let field = '';
  let record: string[] = [];

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (out: string[][]): void => {
    endField();
    out.push(record);
    record = [];
  };

  return {
    feed(text: string): string[][] {
      const out: string[][] = [];
      for (const ch of text) {
        if (state === 'quoted') {
          if (ch === '"') {
            state = 'after_quote';
          } else {
            field += ch; // 引号内的 CR/LF/分隔符均为字面量
          }
          continue;
        }
        if (lastWasCR) {
          lastWasCR = false;
          endRecord(out);
          if (ch === '\n') continue;
        }
        if (state === 'after_quote') {
          if (ch === '"') {
            field += '"'; // "" → 字面引号
            state = 'quoted';
            continue;
          }
          state = 'normal'; // 闭合引号后的字符按普通语义处理
        }
        if (ch === '"') {
          state = 'quoted'; // 开引号
        } else if (ch === delimiter) {
          endField();
        } else if (ch === '\r') {
          lastWasCR = true;
        } else if (ch === '\n') {
          endRecord(out);
        } else {
          field += ch;
        }
      }
      return out;
    },
    finish(): string[][] {
      const out: string[][] = [];
      if (state === 'quoted') throw dataFormatError('CSV 存在未闭合的引号字段');
      if (lastWasCR) {
        lastWasCR = false;
        endRecord(out);
      }
      if (field !== '' || record.length > 0) endRecord(out);
      return out;
    },
  };
}

export interface CsvScanLimits {
  delimiter: string;
  maxBytes: number;
  maxRows: number;
}

export async function scanCsvFile(path: string, limits: CsvScanLimits): Promise<CsvScanResult> {
  const info = await stat(path);
  if (info.size > limits.maxBytes) {
    throw payloadTooLarge(`文件超出导入大小上限: ${info.size} > ${limits.maxBytes} 字节`, {
      size_bytes: info.size,
      max_bytes: limits.maxBytes,
    });
  }

  const parser = createRecordParser(limits.delimiter);
  const decoder = new StringDecoder('utf8');
  let header: string[] | null = null;
  let rowCount = 0;
  let mismatchRows = 0;
  let firstChunk = true;
  const stats: CsvColumnStat[] = [];

  const handleRecord = (record: string[]): void => {
    if (header === null) {
      header = record.map((name, index) =>
        name.trim() === '' ? `column_${index + 1}` : name.trim(),
      );
      for (const name of header) stats.push({ name, inferred_type: 'boolean', null_count: 0 });
      return;
    }
    rowCount++;
    if (rowCount > limits.maxRows) {
      throw payloadTooLarge(`数据行数超出导入上限: ${limits.maxRows}`, {
        max_rows: limits.maxRows,
      });
    }
    if (record.length !== header.length) mismatchRows++;
    for (let c = 0; c < header.length; c++) {
      const cell = record[c];
      const column = stats[c];
      if (cell === undefined || cell === '') {
        if (column) column.null_count++;
        continue;
      }
      const type = inferCell(cell);
      if (type && column) column.inferred_type = widen(column.inferred_type, type);
    }
  };

  await new Promise<void>((fulfil, reject) => {
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      let text = decoder.write(chunk as Buffer);
      if (firstChunk) {
        firstChunk = false;
        if (text.includes('\u0000')) {
          stream.destroy();
          reject(dataFormatError('文件包含二进制字节,不是有效的 CSV/TSV 文本'));
          return;
        }
      }
      if (header === null && text.startsWith('\uFEFF')) text = text.slice(1); // 剥离 UTF-8 BOM
      try {
        for (const record of parser.feed(text)) handleRecord(record);
      } catch (error) {
        stream.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    stream.on('end', () => {
      try {
        for (const record of parser.feed(decoder.end())) handleRecord(record);
        for (const record of parser.finish()) handleRecord(record);
        fulfil();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  if (header === null) throw dataFormatError('文件为空或缺少表头行');

  return {
    header,
    row_count: rowCount,
    columns: stats,
    delimiter: limits.delimiter,
    field_count_mismatch_rows: mismatchRows,
  };
}

/** 小表(限额内)行级读取:返回全部数据记录,不含表头。供聚合等行级计算使用。 */
export async function readCsvRecords(
  path: string,
  limits: CsvScanLimits,
): Promise<{ header: string[]; records: string[][] }> {
  const scan = await scanCsvFile(path, limits); // 顺带完成限额与格式校验
  const parser = createRecordParser(limits.delimiter);
  const decoder = new StringDecoder('utf8');
  const records: string[][] = [];
  let headerSeen = false;
  let firstChunk = true;

  await new Promise<void>((fulfil, reject) => {
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      let text = decoder.write(chunk as Buffer);
      if (firstChunk) {
        firstChunk = false;
        if (text.includes('\u0000')) {
          stream.destroy();
          reject(dataFormatError('文件包含二进制字节,不是有效的 CSV/TSV 文本'));
          return;
        }
      }
      if (!headerSeen && text.startsWith('\uFEFF')) text = text.slice(1);
      try {
        for (const record of parser.feed(text)) {
          if (!headerSeen) {
            headerSeen = true;
            continue;
          }
          records.push(record);
        }
      } catch (error) {
        stream.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    stream.on('end', () => {
      try {
        for (const record of parser.feed(decoder.end())) {
          if (!headerSeen) {
            headerSeen = true;
            continue;
          }
          records.push(record);
        }
        for (const record of parser.finish()) {
          if (!headerSeen) {
            headerSeen = true;
            continue;
          }
          records.push(record);
        }
        fulfil();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  return { header: scan.header, records };
}
