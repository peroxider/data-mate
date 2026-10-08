import { isAbsolute, join, resolve } from 'node:path';
import { UuidSchema, AnalystError } from '@data-analyst/contracts';
import type { ProductConfig } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §9 存储分工。所有目录由配置解析;业务代码不接受调用方拼接的任意绝对路径。
// 相对路径以配置文件所在目录为基准(§18)。
// ---------------------------------------------------------------------------

export interface ResolvedPaths {
  dataDir: string;
  stateDir: string;
  cacheDir: string;
  workspacesDir: string;
  productStateFile: string;
  dshStateDir: string;
  credentialsDir: string;
}

function baseDir(value: string, configDir: string): string {
  return isAbsolute(value) ? value : resolve(configDir, value);
}

export function resolvePaths(config: ProductConfig, configDir: string): ResolvedPaths {
  const dataDir = baseDir(config.paths.data_dir, configDir);
  const stateDir = baseDir(config.paths.state_dir, configDir);
  const cacheDir = baseDir(config.paths.cache_dir, configDir);
  return {
    dataDir,
    stateDir,
    cacheDir,
    workspacesDir: join(dataDir, 'workspaces'),
    productStateFile: join(stateDir, 'product.sqlite'),
    dshStateDir: join(stateDir, 'dsh'),
    credentialsDir: join(stateDir, 'credentials'),
  };
}

function assertUuid(id: string, what: string): string {
  const parsed = UuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new AnalystError({
      code: 'UNPROCESSABLE',
      message: `${what} 不是合法 UUID`,
      request_id: null,
      run_id: null,
      retryable: false,
      details: null,
    });
  }
  return id;
}

export function workspaceRoot(paths: ResolvedPaths, workspaceId: string): string {
  return join(paths.workspacesDir, assertUuid(workspaceId, 'workspace_id'));
}

export function datasetDir(workspaceRootDir: string, datasetId: string): string {
  return join(workspaceRootDir, 'datasets', assertUuid(datasetId, 'dataset_id'));
}

export function datasetOriginalDir(workspaceRootDir: string, datasetId: string): string {
  return join(datasetDir(workspaceRootDir, datasetId), 'original');
}

export function datasetVersionDir(
  workspaceRootDir: string,
  datasetId: string,
  versionId: string,
): string {
  return join(
    datasetDir(workspaceRootDir, datasetId),
    'versions',
    assertUuid(versionId, 'version_id'),
  );
}

export function notebookDir(workspaceRootDir: string, sessionId: string): string {
  return join(workspaceRootDir, 'notebooks', assertUuid(sessionId, 'session_id'));
}

export function runDir(workspaceRootDir: string, runId: string): string {
  return join(workspaceRootDir, 'runs', assertUuid(runId, 'run_id'));
}

export function artifactsDir(workspaceRootDir: string, artifactId: string): string {
  return join(workspaceRootDir, 'artifacts', assertUuid(artifactId, 'artifact_id'));
}

export function runCacheDir(paths: ResolvedPaths, workspaceId: string, runId: string): string {
  return join(
    paths.cacheDir,
    assertUuid(workspaceId, 'workspace_id'),
    assertUuid(runId, 'run_id'),
  );
}
