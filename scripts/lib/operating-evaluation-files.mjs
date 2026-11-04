// SPDX-License-Identifier: Apache-2.0
import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
export async function readOperatingEvidence(input) {
  const file = await realpath(resolve(input));
  if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('评测记录超过 16MiB；原始日志应单独引用');
  let evidence; try { evidence = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('评测记录不是有效 JSON'); }
  return { file, evidence };
}
export async function verifyOperatingLogs(file, evidence) {
  const base = dirname(await realpath(file)), verified = new Set();
  for (const row of [...evidence.runs, ...evidence.humanBaselines, ...evidence.safety]) for (const log of row.logs) {
    if (isAbsolute(log.path)) throw new Error('原始记录必须位于评测目录内');
    const path = await realpath(resolve(base, log.path)), location = relative(base, path);
    if (location.startsWith('..') || isAbsolute(location)) throw new Error('原始记录不能跨出评测目录');
    const key = path + ':' + log.digest; if (verified.has(key)) continue;
    if (!(await stat(path)).isFile()) throw new Error('原始记录必须是文件');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) hash.update(chunk);
    if (hash.digest('hex') !== log.digest) throw new Error('原始记录摘要不匹配');
    verified.add(key);
  }
  return verified.size;
}
