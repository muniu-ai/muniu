// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { linuxPdfMemorySample, pdfProcessHasExited } from '../src/document-extraction-pdf-isolation.js';

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
