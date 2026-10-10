// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import type { CodingAgentRuntimeReadiness } from './agent-readiness.js';

const SANDBOX = '/usr/bin/sandbox-exec';
const COMMAND = '/usr/bin/true';
const PROFILE = '(version 1)(deny default)(allow process*)(allow file-read*)(allow sysctl-read)';

export interface LocalSandboxInspectionPorts {
  readonly platform: NodeJS.Platform;
  readonly inspect: (path: string) => Promise<{ realPath: string; isFile: boolean; uid: number; mode: number }>;
  readonly execute: (file: string, args: readonly string[], options: {
    readonly shell: false; readonly cwd: string; readonly env: Readonly<Record<string, string>>;
    readonly timeout: number; readonly maxBuffer: number; readonly killSignal: 'SIGKILL'; readonly signal: AbortSignal;
  }) => Promise<{ exitCode: number | null }>;
}

const systemPorts: LocalSandboxInspectionPorts = {
  platform: process.platform,
  async inspect(path) {
    const resolved = await realpath(path), info = await lstat(path);
    return { realPath: resolved, isFile: info.isFile(), uid: info.uid, mode: info.mode };
  },
  execute: (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, [...args], options, error => {
      if (!error) resolve({ exitCode: 0 });
      else if (typeof error.code === 'number' && !error.killed && !error.signal) resolve({ exitCode: error.code });
      else reject(error);
    });
  }),
};

export async function inspectLocalCodingSandbox(ports = systemPorts): Promise<CodingAgentRuntimeReadiness['sandbox']> {
  if (ports.platform !== 'darwin') return 'unavailable';
  try {
    for (const path of [SANDBOX, COMMAND]) {
      const info = await ports.inspect(path);
      if (info.realPath !== path || !info.isFile || info.uid !== 0 || !(info.mode & 0o111) || (info.mode & 0o022)) return 'unavailable';
    }
    const options = { shell: false as const, cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      timeout: 1500, maxBuffer: 4096, killSignal: 'SIGKILL' as const, signal: AbortSignal.timeout(2000) };
    const allowed = await ports.execute(SANDBOX, ['-p', PROFILE, COMMAND], options);
    if (allowed.exitCode !== 0) return 'unavailable';
    const denied = await ports.execute(SANDBOX, ['-p', `${PROFILE}(deny process-exec (literal "${COMMAND}"))`, COMMAND], options);
    return denied.exitCode !== null && denied.exitCode > 0 ? 'available' : 'unavailable';
  } catch { return 'unknown'; }
}
