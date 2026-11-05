// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionsFixtureCleanup } from '../enterprise-actions-e2e.mjs';

async function setup(t, owner = 'fixture-run') {
  const root = await mkdtemp(join(tmpdir(), 'mn-actions-cleanup-')), signals = new EventEmitter(), commands = [];
  const exitCodes = []; let exited;
  const exit = new Promise(resolve => { exited = resolve; });
  const lifecycle = createActionsFixtureCleanup({ root, name: 'fixture-container', runId: 'fixture-run', signals,
    docker: async (...args) => {
      commands.push(args);
      if (args[0] === 'inspect') return JSON.stringify({ 'com.muniu.fixture.run-id': owner });
      if (args[0] === 'rm') return 'fixture-id';
      throw new Error('Unexpected Docker command');
    },
    exit: code => { exitCodes.push(code); exited(code); },
  });
  t.after(async () => { lifecycle.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, signals, commands, lifecycle, exit, exitCodes };
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed;
}

test('SIGTERM 等待本次容器创建完成，清理登记子进程并保留未登记进程', async t => {
  const f = await setup(t), foreign = spawn(process.execPath, ['--max-old-space-size=32', '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => stop(foreign));
  const child = f.lifecycle.trackChild(spawn(process.execPath, ['--max-old-space-size=32', '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  t.after(() => stop(child));
  await Promise.all([once(child, 'spawn'), once(foreign, 'spawn')]);
  let finishCreation;
  f.lifecycle.setContainerCreation(new Promise(resolve => { finishCreation = resolve; }));
  let closedSessions = 0;
  f.lifecycle.trackSession({ async close() { closedSessions++; } });
  f.signals.emit('SIGTERM'); f.signals.emit('SIGINT');
  assert.equal(f.commands.length, 0); assert.equal(f.lifecycle.interrupted, 'SIGTERM');
  finishCreation('fixture-id');
  assert.equal(await f.exit, 143);
  assert.equal(child.signalCode, 'SIGKILL'); assert.equal(foreign.exitCode, null); assert.equal(foreign.signalCode, null);
  assert.deepEqual(f.exitCodes, [143]); assert.equal(closedSessions, 1);
  assert.deepEqual(f.commands.filter(args => args[0] === 'rm'), [['rm', '--force', 'fixture-id']]);
  await assert.rejects(access(f.root), { code: 'ENOENT' });
});

test('会话关闭失败仍清理本次容器，并且不把清理失败计为通过', async t => {
  const f = await setup(t); f.lifecycle.setContainerCreation(Promise.resolve('fixture-id'));
  f.lifecycle.trackSession({ async close() { throw new Error('synthetic close failure'); } });
  await assert.rejects(f.lifecycle.stop(), /cleanup/u);
  assert.deepEqual(f.commands.filter(args => args[0] === 'rm'), [['rm', '--force', 'fixture-id']]);
  await assert.rejects(access(f.root), { code: 'ENOENT' });
});

test('缺少本次唯一标签时拒绝删除，SIGINT 及重复清理保持幂等', async t => {
  const f = await setup(t, 'another-run'); f.lifecycle.setContainerCreation(Promise.resolve('fixture-id'));
  await assert.rejects(f.lifecycle.stop(), /cleanup/u);
  assert.equal(f.commands.some(args => args[0] === 'rm'), false);
  const second = await setup(t); second.lifecycle.setContainerCreation(Promise.resolve('fixture-id'));
  second.signals.emit('SIGINT'); assert.equal(await second.exit, 130);
  await second.lifecycle.stop(); assert.equal(second.commands.filter(args => args[0] === 'rm').length, 1);
  assert.throws(() => second.lifecycle.assertRunning(), { code: 'FIXTURE_STOPPING' });
});
