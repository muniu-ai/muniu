// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceRouter, parseWorkspaceRoute } from '../src/navigation-state.js';

class MemoryHistory {
  private entries: string[]; private index = 0; readonly listeners = new Set<() => void>();
  constructor(hash: string) { this.entries = [hash]; }
  read = () => this.entries[this.index]!;
  write = (hash: string) => { this.entries = [...this.entries.slice(0, this.index + 1), hash]; this.index++; this.emit(); };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  go(offset: number) { const next = this.index + offset; if (next >= 0 && next < this.entries.length) { this.index = next; this.emit(); } }
  private emit() { for (const listener of this.listeners) listener(); }
}
test('经营目标入口到达同一分类，前进后退恢复完整导航状态', () => {
  const history = new MemoryHistory('#overview'), router = new WorkspaceRouter(history), states: string[] = [];
  const unsubscribe = router.subscribe(() => { const value = router.snapshot(); states.push(value.page + ':' + (value.objectType ?? '')); });
  router.navigate('finance', 'operating_objective');
  assert.deepEqual(router.snapshot(), { page: 'finance', objectType: 'operating_objective' });
  history.go(-1); assert.deepEqual(router.snapshot(), { page: 'overview' });
  history.go(1); assert.deepEqual(router.snapshot(), { page: 'finance', objectType: 'operating_objective' });
  assert.deepEqual(states, ['finance:operating_objective', 'overview:', 'finance:operating_objective']);
  unsubscribe(); assert.equal(history.listeners.size, 0);
});
test('台账分类切换写入历史，返回时不退回默认付款期', () => {
  const history = new MemoryHistory('#finance?tab=operating_objective'), router = new WorkspaceRouter(history), unsubscribe = router.subscribe(() => {});
  router.navigate('finance', 'receipt'); router.navigate('sales', 'quote_version');
  history.go(-1); assert.deepEqual(router.snapshot(), { page: 'finance', objectType: 'receipt' });
  history.go(-1); assert.deepEqual(router.snapshot(), { page: 'finance', objectType: 'operating_objective' });
  history.go(1); assert.deepEqual(router.snapshot(), { page: 'finance', objectType: 'receipt' });
  unsubscribe();
});
test('错误分类、重复参数和未开放页面不变成任意业务查询', () => {
  assert.deepEqual(parseWorkspaceRoute('#finance?tab=customer'), { page: 'finance', objectType: 'payment_schedule' });
  assert.deepEqual(parseWorkspaceRoute('#sales?tab=../../secret'), { page: 'sales', objectType: 'customer' });
  assert.deepEqual(parseWorkspaceRoute('#finance?tab=receipt&tab=expense'), { page: 'finance', objectType: 'payment_schedule' });
  assert.deepEqual(parseWorkspaceRoute('#coding?tab=receipt'), { page: 'overview' });
  assert.deepEqual(parseWorkspaceRoute('#knowledge?tab=customer'), { page: 'knowledge' });
});
