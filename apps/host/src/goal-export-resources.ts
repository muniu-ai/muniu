// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { GoalExportError } from './goal-export-renderer-types.js';
interface Probe {
  readonly readStatus?: () => Promise<string>;
  readonly readStatm?: () => Promise<string>;
  readonly hasExited?: () => boolean;
}
const unavailable = () => new GoalExportError('EXPORT_ISOLATION_UNAVAILABLE', '不能核对导出进程资源');
function sample(status: string): number | null | undefined {
  if (/^State:\s*[ZXx]\b/m.test(status)) return null;
  const match = /^VmRSS:\s*(\d+)\s+kB$/m.exec(status);
  if (!match) return undefined;
  const rss = Number(match[1]);
  if (!Number.isSafeInteger(rss) || rss < 0) throw unavailable();
  return rss;
}
export async function probeLinuxExportRss(pid: number, probe: Probe = {}): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw unavailable();
  const status = probe.readStatus ?? (() => readFile('/proc/' + pid + '/status', 'utf8'));
  const statm = probe.readStatm ?? (() => readFile('/proc/' + pid + '/statm', 'utf8'));
  const exited = probe.hasExited ?? (() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
  });
  try {
    const first = sample(await status()); if (first !== undefined) return first;
    // Linux can release the address space before exit notification. Require kernel evidence,
    // not merely a missing RSS field. statm fields: kernel.org/doc/html/latest/filesystems/proc.html
    if (/^\s*0(?:\s+0){6}\s*$/.test(await statm())) return 0;
    const second = sample(await status()); if (second !== undefined) return second;
    throw unavailable();
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      try { if (exited()) return null; } catch { /* An unverified process remains fail-closed. */ }
    }
    throw unavailable();
  }
}
