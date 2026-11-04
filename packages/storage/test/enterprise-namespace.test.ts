// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresStorage, S3Cas, scopePostgresPool, renderPostgresNamespace, type PostgresPoolLike, type S3ClientLike } from '../src/index.js';
test('企业数据库只创建新命名空间，查询参数和数据中的旧名称保持原值', async () => {
  const queries: { sql: string; parameters?: readonly unknown[] }[] = []; let released = 0;
  const query = async (sql: string, parameters?: readonly unknown[]) => { queries.push({ sql, parameters }); return { rows: [], rowCount: 0 }; };
  const pool: PostgresPoolLike = { query, async connect() { return { query, release() { released++; } }; } };
  const storage = new PostgresStorage({ pool, hmacKey: Buffer.alloc(32, 1), namespace: 'mn_enterprise_v1' });
  await storage.initialize();
  assert.match(queries[0]!.sql, /create schema if not exists mn_enterprise_v1;/u);
  assert.doesNotMatch(queries[0]!.sql, /\bmn_v2\b/u);
  const scoped = scopePostgresPool(pool, 'mn_enterprise_v1');
  const client = await scoped.connect();
  const parameters = ['mn_v2.events']; await client.query('select * from mn_v2.events where event_type = $1', parameters); client.release();
  assert.match(queries[1]!.sql, /from mn_enterprise_v1.events/u); assert.equal(queries[1]!.parameters, parameters); assert.equal(released, 1);
  assert.equal(scopePostgresPool(scoped, 'mn_enterprise_v1'), scoped);
  assert.throws(() => scopePostgresPool(scoped, 'mn_v2'), /namespace/u);
  assert.throws(() => scopePostgresPool(pool, 'public;drop schema public' as never), /namespace/u);
});
test('SQL 名称替换不改字面量、注释、相似标识和 dollar 字符串', () => {
  const sql = `select 'mn_v2.events', "mn_v2".events, mnemonic_mn_v2, $$mn_v2.events$$, $tag$mn_v2$tag$ from mn_v2.events -- mn_v2\n/* outer /* mn_v2 */ mn_v2 */`;
  assert.equal(renderPostgresNamespace(sql, 'mn_enterprise_v1'), `select 'mn_v2.events', "mn_enterprise_v1".events, mnemonic_mn_v2, $$mn_v2.events$$, $tag$mn_v2$tag$ from mn_enterprise_v1.events -- mn_v2\n/* outer /* mn_v2 */ mn_v2 */`);
});
test('企业对象存储只写 enterprise-v1 前缀，旧 v2 对象不被读取或删除', async () => {
  const objects = new Map<string, Uint8Array>([['v2/sha256/old', Buffer.from('old')]]), readKeys: string[] = [];
  const client: S3ClientLike = {
    async headObject(input) { return objects.has(input.key) ? { contentLength: objects.get(input.key)!.byteLength } : undefined; },
    async putObject(input) { objects.set(input.key, input.body); return true; },
    async getObject(input) { readKeys.push(input.key); const value = objects.get(input.key); if (!value) throw new Error('Object not found'); return value; },
    async deleteObjects(input) { input.keys.forEach(key => objects.delete(key)); },
    async listObjects(input) { return [...objects].filter(([key]) => key.startsWith(input.prefix)).map(([key, body]) => ({ key, size: body.byteLength, lastModified: new Date('2026-11-02T00:00:00.000Z') })); },
  };
  const cas = new S3Cas({ client, bucket: 'fixture', namespace: 'enterprise-v1' });
  const ref = await cas.put(Buffer.from('new'));
  assert.equal(Buffer.from((await cas.get(ref.digest))!).toString(), 'new');
  assert.ok(readKeys.every(key => key.startsWith('enterprise-v1/')));
  await cas.gcOrphans(new Set(), new Date('2026-11-03T00:00:00.000Z'));
  assert.ok(objects.has('v2/sha256/old'));
  assert.equal(objects.size, 1);
  assert.throws(() => new S3Cas({ client, bucket: 'fixture', namespace: 'enterprise-v1', prefix: 'v2/' }), /prefix/u);
  assert.throws(() => new S3Cas({ client, bucket: 'fixture', namespace: 'enterprise-v1', prefix: 'enterprise-v1/../v2/' }), /prefix/u);
});
