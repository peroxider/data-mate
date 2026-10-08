import { AnalystError } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §8/FR04 只读 SQL 守卫:语句白名单、多语句拒绝与危险子句拦截。
// 这是产品服务端的强制控制(§7:提示词不承担只读等强制控制)。
// 守卫是第一层;驱动层仍需以只读连接/会话参数兜底(纵深防御)。
// ---------------------------------------------------------------------------

const READ_LEADING_KEYWORDS = new Set([
  'select',
  'with',
  'explain',
  'show',
  'describe',
  'desc',
  'values',
]);

const DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\binto\s+(outfile|dumpfile)\b/i, reason: '禁止 INTO OUTFILE/DUMPFILE' },
  { pattern: /\bfor\s+(update|share)\b/i, reason: '禁止 FOR UPDATE/FOR SHARE 锁定读' },
  { pattern: /\block\s+(tables?|in\s+share\s+mode)\b/i, reason: '禁止显式锁表' },
];

function err(
  code: AnalystError['payload']['code'],
  message: string,
  details?: Record<string, unknown>,
): AnalystError {
  return new AnalystError({
    code,
    message,
    request_id: null,
    run_id: null,
    retryable: false,
    details: details ?? null,
  });
}

/** 去除 -- 行注释与 /* 块注释,保留字符串字面量内容。 */
export function stripSqlComments(sql: string): string {
  let result = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      result += char;
      index += 1;
      while (index < sql.length) {
        const inner = sql[index]!;
        result += inner;
        index += 1;
        if (inner === quote) {
          if (sql[index] === quote) {
            result += sql[index]!;
            index += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      result += ' ';
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

/** 按引号感知切分顶层分号语句;返回非空语句列表。 */
export function splitStatements(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  const statements: string[] = [];
  let current = '';
  let index = 0;
  while (index < cleaned.length) {
    const char = cleaned[index]!;
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      current += char;
      index += 1;
      while (index < cleaned.length) {
        const inner = cleaned[index]!;
        current += inner;
        index += 1;
        if (inner === quote) {
          if (cleaned[index] === quote) {
            current += cleaned[index]!;
            index += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (char === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim().length > 0) statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

/**
 * 校验 SQL 为只读单语句,返回规范化后的语句文本。
 * - 多语句 → UNPROCESSABLE;
 * - 非 SELECT/WITH/EXPLAIN/SHOW/DESCRIBE/DESC/VALUES 开头 → FORBIDDEN;
 * - 命中危险子句(OUTFILE、FOR UPDATE 等)→ FORBIDDEN。
 */
export function assertReadOnlySingleStatement(sql: string): string {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    throw err('UNPROCESSABLE', 'SQL 为空或仅包含注释');
  }
  if (statements.length > 1) {
    throw err('UNPROCESSABLE', `只读查询一次仅允许一条语句,检测到 ${statements.length} 条`, {
      statement_count: statements.length,
    });
  }
  const statement = statements[0]!;
  const leading = statement.replace(/^\s*\(?\s*/, '').match(/^[a-zA-Z]+/);
  const keyword = leading?.[0]?.toLowerCase() ?? '';
  if (!READ_LEADING_KEYWORDS.has(keyword)) {
    throw err('FORBIDDEN', `只读数据源不允许 ${keyword || '该语句类型'} 语句`, {
      leading_keyword: keyword || null,
    });
  }
  for (const { pattern, reason } of DENY_PATTERNS) {
    if (pattern.test(statement)) {
      throw err('FORBIDDEN', `只读查询被拒绝:${reason}`);
    }
  }
  return statement;
}
