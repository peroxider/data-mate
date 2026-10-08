import { describe, expect, it } from 'vitest';
import { AnalystError } from '@data-analyst/contracts';
import {
  assertReadOnlySingleStatement,
  splitStatements,
  stripSqlComments,
} from './sql-guard.js';

function codeOf(error: unknown): string {
  return error instanceof AnalystError ? error.payload.code : '';
}

describe('stripSqlComments', () => {
  it('去除行注释与块注释', () => {
    expect(stripSqlComments('SELECT 1 -- 注释\n')).toBe('SELECT 1 \n');
    expect(stripSqlComments('SELECT /* x */ 1')).toBe('SELECT   1');
  });

  it('保留字符串字面量中的注释符号', () => {
    expect(stripSqlComments("SELECT '-- not comment'")).toBe("SELECT '-- not comment'");
    expect(stripSqlComments("SELECT 'a''b'")).toBe("SELECT 'a''b'");
  });
});

describe('splitStatements', () => {
  it('按顶层分号切分', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
    expect(splitStatements('   ')).toEqual([]);
  });

  it('字符串字面量中的分号与注释不参与切分', () => {
    expect(splitStatements("SELECT ';' -- ; trailing")).toEqual(["SELECT ';'"]);
  });
});

describe('assertReadOnlySingleStatement', () => {
  it('放行 SELECT/WITH 并返回规范化语句', () => {
    expect(assertReadOnlySingleStatement('  SELECT * FROM t  ')).toBe('SELECT * FROM t');
    expect(assertReadOnlySingleStatement('WITH x AS (SELECT 1) SELECT * FROM x')).toContain('WITH');
    expect(assertReadOnlySingleStatement('EXPLAIN SELECT 1')).toBe('EXPLAIN SELECT 1');
  });

  it('仅注释或空串 → UNPROCESSABLE', () => {
    expect(() => assertReadOnlySingleStatement('-- nothing')).toThrowError(AnalystError);
    try {
      assertReadOnlySingleStatement('   ');
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('UNPROCESSABLE');
    }
  });

  it('多语句 → UNPROCESSABLE 且携带 statement_count(T10)', () => {
    try {
      assertReadOnlySingleStatement('SELECT 1; DROP TABLE t');
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('UNPROCESSABLE');
      expect((error as AnalystError).payload.details).toMatchObject({ statement_count: 2 });
    }
  });

  it('写语句 → FORBIDDEN(T10)', () => {
    for (const sql of [
      'DROP TABLE users',
      'DELETE FROM users',
      'INSERT INTO users VALUES (1)',
      "UPDATE users SET name = 'x'",
      'CREATE TABLE t (id INT)',
      'TRUNCATE users',
      'ALTER TABLE users ADD COLUMN c INT',
      'GRANT ALL ON *.* TO u',
    ]) {
      try {
        assertReadOnlySingleStatement(sql);
        expect.unreachable();
      } catch (error) {
        expect(codeOf(error)).toBe('FORBIDDEN');
      }
    }
  });

  it('危险子句 → FORBIDDEN', () => {
    for (const sql of [
      "SELECT * FROM t INTO OUTFILE '/tmp/x'",
      'SELECT * FROM t FOR UPDATE',
      'SELECT * FROM t LOCK IN SHARE MODE',
    ]) {
      try {
        assertReadOnlySingleStatement(sql);
        expect.unreachable();
      } catch (error) {
        expect(codeOf(error)).toBe('FORBIDDEN');
      }
    }
  });
});
