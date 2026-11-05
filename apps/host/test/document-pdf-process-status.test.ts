// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { linuxPdfMemorySample, pdfProcessHasExited, readLinuxPdfMemorySample } from '../src/document-extraction-pdf-isolation.js';

test('Linux 已结束子进程可先于 Node exit 事件成为 zombie，缺少 VmRSS 不代表仍在运行且失去限制', () => {
  for (const state of ['Z (zombie)', 'X (dead)']) {
    const status = `Name:\tnode\nState:\t${state}\nTgid:\t42\nPid:\t42\nThreads:\t1\n`;
    assert.deepEqual(linuxPdfMemorySample(status, 42), { state: 'exited' });
  }
});

test('运行或停止中的 PDF 子进程仍必须提供真实 RSS，不能以缺失值代替零', () => {
  for (const state of ['R (running)', 'S (sleeping)', 'T (stopped)', 't (tracing stop)']) {
    const base = `Name:\tnode\nState:\t${state}\nPid:\t42\n`;
    assert.deepEqual(linuxPdfMemorySample(base + 'VmRSS:\t12345 kB\n', 42), { state: 'running', rssKiB: 12345 });
    for (const suffix of ['', 'VmRSS:\tnot-a-number kB\n', 'VmRSS:\t-1 kB\n', 'VmRSS:\t999999999999999999999 kB\n']) {
      assert.throws(() => linuxPdfMemorySample(base + suffix, 42), { code: 'PDF_ISOLATION_UNAVAILABLE' });
    }
  }
});

test('进程状态必须属于启动时记录的子进程，错误 PID 或缺失状态不作为退出证明', () => {
  for (const status of ['State:\tZ (zombie)\nPid:\t41\n', 'State:\tZ (zombie)\n', 'Pid:\t42\nVmRSS:\t123 kB\n']) {
    assert.throws(() => linuxPdfMemorySample(status, 42), { code: 'PDF_ISOLATION_UNAVAILABLE' });
  }
});

test('采样文件已随进程退出消失时，只接受内核 ESRCH 证明，不把权限错误或活动进程当作退出', () => {
  let inspected = 0;
  assert.equal(pdfProcessHasExited(42, pid => { inspected = pid; throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }), true);
  assert.equal(inspected, 42);
  assert.equal(pdfProcessHasExited(42, () => true), false);
  for (const code of ['EPERM', 'EACCES', 'ENOENT']) assert.equal(pdfProcessHasExited(42, () => { throw Object.assign(new Error('unverified'), { code }); }), false);
  assert.equal(pdfProcessHasExited(undefined, () => { throw new Error('must not probe'); }), false);
  assert.equal(pdfProcessHasExited(0, () => { throw new Error('must not probe'); }), false);
});

test('退出窗口状态仍为 R 时，只有 statm 明确七项全零才提供零内存观测', () => {
  const status = 'Name:\tnode\nState:\tR (running)\nPid:\t42\n';
  assert.deepEqual(linuxPdfMemorySample(status, 42, '0 0 0 0 0 0 0\n'), { state: 'running', rssKiB: 0 });
  for (const statm of ['', '0 0 0', '100 0 0 0 0 0 0\n', '0 0 0 0 0 0 0 0\n', 'unknown']) {
    assert.throws(() => linuxPdfMemorySample(status, 42, statm), { code: 'PDF_ISOLATION_UNAVAILABLE' });
  }
  assert.throws(() => linuxPdfMemorySample(status + 'VmRSS:\tinvalid kB\n', 42, '0 0 0 0 0 0 0\n'), { code: 'PDF_ISOLATION_UNAVAILABLE' });
});

test('非零 statm 必须重新取得有效 RSS，不能把已经恢复的内存计为零', async () => {
  const calls: string[] = []; let statuses = 0;
  const sample = await readLinuxPdfMemorySample(42, async kind => {
    calls.push(kind);
    if (kind === 'statm') return '9000 8000 100 20 0 3000 0\n';
    return 'State:\tR (running)\nPid:\t42\n' + (++statuses === 1 ? '' : 'VmRSS:\t32000 kB\n');
  });
  assert.deepEqual(sample, { state: 'running', rssKiB: 32000 });
  assert.deepEqual(calls, ['status', 'statm', 'status']);
});

test('补证不能掩盖权限失败、畸形内存字段或连续缺失的观测', async () => {
  const status = 'State:\tR (running)\nPid:\t42\n';
  await assert.rejects(readLinuxPdfMemorySample(42, async kind => { if (kind === 'status') return status; throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), { code: 'EACCES' });
  let reads = 0;
  await assert.rejects(readLinuxPdfMemorySample(42, async () => { reads++; return status + 'VmRSS:\tinvalid kB\n'; }), { code: 'PDF_ISOLATION_UNAVAILABLE' });
  assert.equal(reads, 1);
  await assert.rejects(readLinuxPdfMemorySample(42, async kind => kind === 'statm' ? '1 1 0 0 0 0 0\n' : status), { code: 'PDF_ISOLATION_UNAVAILABLE' });
});
