import { AnalystError } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// 数据源 Endpoint 解析:PostgreSQL/MySQL 使用 URL 形态
// (如 postgres://user@host:5432/db、mysql://host:3306/db)。
// 密码不进入 endpoint(由 credential_ref 解析,详见 DatabaseAdapter)。
// ---------------------------------------------------------------------------

export interface ParsedEndpoint {
  host: string;
  port: number;
  database: string;
  user: string | null;
}

export function resolveEndpoint(endpoint: string, defaultPort: number): ParsedEndpoint {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `db://${endpoint}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new AnalystError({
      code: 'UNPROCESSABLE',
      message: `数据源 endpoint 不是合法 URL: ${endpoint}`,
      request_id: null,
      run_id: null,
      retryable: false,
      details: null,
    });
  }
  const host = parsed.hostname;
  if (!host) {
    throw new AnalystError({
      code: 'UNPROCESSABLE',
      message: '数据源 endpoint 缺少主机名',
      request_id: null,
      run_id: null,
      retryable: false,
      details: null,
    });
  }
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  const database = parsed.pathname.replace(/^\//, '');
  const user = parsed.username ? decodeURIComponent(parsed.username) : null;
  return { host, port, database, user };
}
