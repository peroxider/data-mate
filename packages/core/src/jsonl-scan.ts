import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { AnalystError } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §496/§502 导入过程:JSONL 流式扫描。每行必须是 JSON 对象(可表格化约束);
// 嵌套对象按点路径扁平化(展开规则写入 manifest),数组等非标量 JSON
// 序列化为字符串;行集按列并集在扫描结束后统一对齐。
// ---------------------------------------------------------------------------

export type JsonlExpansion = 'flat' | 'dotted_path';

export interface JsonlScanResult {
  columns: string[];
  /** 按最终列并集对齐的数据行(缺失列填充 null) */
  rows: Array<Array<unknown>>;
  row_count: number;
  /** 嵌套字段展开规则,写入 manifest(§496) */
  expansion: JsonlExpansion;
  /** 存在缺失列的行数(列并集导致) */
  field_count_mismatch_rows: number;
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

/** 嵌套对象按点路径扁平化;数组与其他非标量 JSON 保持为序列化字符串。 */
function flattenObject(
  value: Record<string, unknown>,
  prefix: string,
  out: Map<string, unknown>,
): void {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      flattenObject(item as Record<string, unknown>, path, out);
    } else {
      out.set(path, Array.isArray(item) ? JSON.stringify(item) : item);
    }
  }
}

export interface JsonlScanLimits {
  maxBytes: number;
  maxRows: number;
}

export async function scanJsonlFile(path: string, limits: JsonlScanLimits): Promise<JsonlScanResult> {
  const info = await stat(path);
  if (info.size > limits.maxBytes) {
    throw payloadTooLarge(`文件超出导入大小上限: ${info.size} > ${limits.maxBytes} 字节`, {
      size_bytes: info.size,
      max_bytes: limits.maxBytes,
    });
  }

  const columns: string[] = [];
  const columnSet = new Set<string>();
  const records: Array<Map<string, unknown>> = [];
  let rowCount = 0;
  let mismatchRows = 0;
  let expansion: JsonlExpansion = 'flat';
  let firstChunk = true;
  const decoder = new StringDecoder('utf8');
  let pending = '';

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw dataFormatError(`JSONL 第 ${rowCount + 1} 行不是合法 JSON`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw dataFormatError(`JSONL 第 ${rowCount + 1} 行不是 JSON 对象,不满足可表格化约束`);
    }
    const flat = new Map<string, unknown>();
    flattenObject(parsed as Record<string, unknown>, '', flat);
    if ([...flat.keys()].some((key) => key.includes('.'))) expansion = 'dotted_path';

    for (const key of flat.keys()) {
      if (!columnSet.has(key)) {
        columnSet.add(key);
        columns.push(key);
      }
    }
    rowCount++;
    if (rowCount > limits.maxRows) {
      throw payloadTooLarge(`数据行数超出导入上限: ${limits.maxRows}`, { max_rows: limits.maxRows });
    }
    if (columns.length !== flat.size) mismatchRows++;
    records.push(flat);
  };

  await new Promise<void>((fulfil, reject) => {
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      let text = pending + decoder.write(chunk as Buffer);
      if (firstChunk) {
        firstChunk = false;
        if (text.includes('\u0000')) {
          stream.destroy();
          reject(dataFormatError('文件包含二进制字节,不是有效的 JSONL 文本'));
          return;
        }
      }
      if (text.startsWith('\uFEFF')) text = text.slice(1); // 剥离 UTF-8 BOM
      const lines = text.split('\n');
      pending = lines.pop() ?? '';
      try {
        for (const line of lines) handleLine(line);
      } catch (error) {
        stream.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    stream.on('end', () => {
      try {
        handleLine(pending + decoder.end());
        fulfil();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  if (rowCount === 0) throw dataFormatError('文件为空或不含任何 JSON 对象行');

  const rows = records.map((record) => columns.map((name) => record.get(name) ?? null));
  return { columns, rows, row_count: rowCount, expansion, field_count_mismatch_rows: mismatchRows };
}
