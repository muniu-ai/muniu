// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectLocalCodingSandbox, type LocalSandboxInspectionPorts } from '../src/local-sandbox-readiness.js';

function fixture() {
  const calls: { file: string; args: readonly string[]; options: Parameters<LocalSandboxInspectionPorts['execute']>[2] }[] = [];
  const ports: LocalSandboxInspectionPorts = {
    platform: 'darwin',
    inspect: async path => ({ realPath: path, isFile: true, uid: 0, mode: 0o100755 }),
    execute: async (file, args, options) => { calls.push({ file, args, options }); return { exitCode: calls.length % 2 === 1 ? 0 : 71 }; },
  };
  return { ports, calls };
}

test('本地沙箱只有正向执行和反向拒绝均验证后可用', async () => {
  const { ports, calls } = fixture();
  assert.equal(await inspectLocalCodingSandbox(ports), 'available');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.file, '/usr/bin/sandbox-exec');
    assert.equal(call.args.at(-1), '/usr/bin/true');
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.env, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
    assert.equal(call.options.cwd, '/');
    assert.equal(call.options.timeout, 1500);
    assert.equal(call.options.maxBuffer, 4096);
    assert.equal(call.options.killSignal, 'SIGKILL');
    assert.match(call.args[1]!, /\(deny default\)/u);
    assert.doesNotMatch(call.args[1]!, /allow network|allow file-write/u);
  }
  assert.match(calls[1]!.args[1]!, /deny process-exec/u);
});

test('沙箱不执行拒绝策略、启动失败或超时均不报告可用', async () => {
  for (const execute of [
    async () => ({ exitCode: 0 }), async () => ({ exitCode: 1 }),
    async () => { throw new Error('timeout'); }, async () => ({ exitCode: null }),
  ]) assert.notEqual(await inspectLocalCodingSandbox({ ...fixture().ports, execute }), 'available');
});

test('非macOS、路径替换、非root文件或可被普通用户改写时不启动探测进程', async () => {
  for (const override of [
    { platform: 'linux' },
    { inspect: async () => ({ realPath: '/tmp/replaced', isFile: true, uid: 0, mode: 0o100755 }) },
    { inspect: async path => ({ realPath: path, isFile: true, uid: 501, mode: 0o100755 }) },
    { inspect: async path => ({ realPath: path, isFile: true, uid: 0, mode: 0o100777 }) },
    { inspect: async path => ({ realPath: path, isFile: false, uid: 0, mode: 0o100755 }) },
  ] satisfies Partial<LocalSandboxInspectionPorts>[]) {
    const { ports, calls } = fixture();
    assert.equal(await inspectLocalCodingSandbox({ ...ports, ...override }), 'unavailable');
    assert.equal(calls.length, 0);
  }
});
