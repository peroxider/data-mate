import { z } from 'zod';

// ---------------------------------------------------------------------------
// §17 统一错误结构。details 不得包含密钥、密码、完整模型请求或未过滤的数据样本。
// ---------------------------------------------------------------------------

export const ErrorCodeSchema = z.enum([
  'CONFIG_INVALID',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'CELL_REVISION_CONFLICT',
  'SESSION_BUSY',
  'UNPROCESSABLE',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'ENVIRONMENT_INCOMPLETE',
  'MODEL_UNAVAILABLE',
  'DATABASE_UNAVAILABLE',
  'TIMEOUT',
  'CANCELLED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const AnalystErrorPayloadSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  request_id: z.string().min(1).nullable(),
  run_id: z.string().min(1).nullable(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type AnalystErrorPayload = z.infer<typeof AnalystErrorPayloadSchema>;

export class AnalystError extends Error {
  readonly payload: AnalystErrorPayload;

  constructor(payload: AnalystErrorPayload) {
    super(payload.message);
    this.name = 'AnalystError';
    this.payload = payload;
  }
}

export function analystError(
  code: ErrorCode,
  message: string,
  options: {
    requestId?: string | null;
    runId?: string | null;
    retryable?: boolean;
    details?: Record<string, unknown> | null;
  } = {},
): AnalystError {
  return new AnalystError({
    code,
    message,
    request_id: options.requestId ?? null,
    run_id: options.runId ?? null,
    retryable: options.retryable ?? false,
    details: options.details ?? null,
  });
}

/** §17 HTTP 状态映射。 */
export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'CONFIG_INVALID':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'CELL_REVISION_CONFLICT':
    case 'SESSION_BUSY':
      return 409;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'UNPROCESSABLE':
    case 'ENVIRONMENT_INCOMPLETE':
      return 422;
    case 'RATE_LIMITED':
      return 429;
    case 'MODEL_UNAVAILABLE':
    case 'DATABASE_UNAVAILABLE':
      return 502;
    case 'TIMEOUT':
      return 504;
    case 'CANCELLED':
      return 499;
    case 'INTERNAL':
      return 500;
  }
}
