import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// ---------------------------------------------------------------------------
// §21 组件冻结的完整性证据:流式 SHA-256,不整读文件入内存。
// ---------------------------------------------------------------------------

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
