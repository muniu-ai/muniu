// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { probeLinuxExportRss } from '../src/goal-export-resources.js';
test('导出资源探测返回有效 RSS，不把运行中进程的缺失或无效数据当成成功', async () => {
  assert.equal(await probeLinuxExportRss(123, { readStatus: async () => 'State: S (sleeping)\nVmRSS: 10240 kB\n', hasExited: () => false }), 10240);
  for (const value of ['State: R (running)\n', 'VmRSS: 9007199254740992 kB\n']) await assert.rejects(probeLinuxExportRss(123, { readStatus: async () => value, readStatm: async () => '10 5 0 0 0 0 0', hasExited: () => false }), { code: 'EXPORT_ISOLATION_UNAVAILABLE' });
});
test('已确认结束的进程没有 RSS 时等待原退出结果，不能误报资源不可用', async () => {
  assert.equal(await probeLinuxExportRss(123, { readStatus: async () => 'State: Z (zombie)\n', hasExited: () => false }), null);
  assert.equal(await probeLinuxExportRss(123, { readStatus: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, hasExited: () => true }), null);
  let index = 0;
  assert.equal(await probeLinuxExportRss(123, { readStatus: async () => index++ ? 'State: Z (zombie)\n' : 'State: R (running)\n', readStatm: async () => '10 5 0 0 0 0 0', hasExited: () => false }), null);
});
test('仍在运行或权限不明时保持拒绝，不把进程探测失败当成已经结束', async () => {
  for (const code of ['ENOENT', 'EACCES']) await assert.rejects(probeLinuxExportRss(123, { readStatus: async () => { throw Object.assign(new Error(), { code }); }, hasExited: () => false }), { code: 'EXPORT_ISOLATION_UNAVAILABLE' });
  await assert.rejects(probeLinuxExportRss(123, { readStatus: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, hasExited: () => { throw Object.assign(new Error(), { code: 'EPERM' }); } }), { code: 'EXPORT_ISOLATION_UNAVAILABLE' });
});
test('退出交界处内核明确报告零地址空间时保留原退出判定，非零或畸形记录仍拒绝', async () => {
  assert.equal(await probeLinuxExportRss(123, { readStatus: async () => 'State: R (running)\n', readStatm: async () => '0 0 0 0 0 0 0\n', hasExited: () => false }), 0);
  for (const value of ['0 0', '1 0 0 0 0 0 0', '0 0 0 0 0 0 bad']) await assert.rejects(probeLinuxExportRss(123, { readStatus: async () => 'State: R (running)\n', readStatm: async () => value, hasExited: () => false }), { code: 'EXPORT_ISOLATION_UNAVAILABLE' });
});
