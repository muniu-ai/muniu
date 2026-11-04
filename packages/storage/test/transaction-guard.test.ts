// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';import test from 'node:test';import {randomBytes} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SqliteStorage,FileCas,InMemoryKeyProvider,DEFAULT_PROJECTION_JOURNAL_NAMESPACES} from '../src/index.js';
test('异步加密完成后重验提交条件，过期授权不留下事件、投影或幂等记录',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mn-guard-')),cas=new FileCas({rootDir:join(root,'cas')});let active=true;
 const store=new SqliteStorage({databaseFile:join(root,'state.sqlite'),hmacKey:randomBytes(32),projectionJournal:{cas,keyProvider:new InMemoryKeyProvider(randomBytes(32)),namespaces:DEFAULT_PROJECTION_JOURNAL_NAMESPACES}});t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});
 const put=cas.put.bind(cas);cas.put=async bytes=>{const result=await put(bytes);active=false;return result;};
 await assert.rejects(store.transact('tenant',tx=>{(tx as any).beforeCommit(()=>{if(!active)throw new Error('CURRENT_AUTHORIZATION_EXPIRED');});tx.putProjection('protected-test','record',{streamVersion:1,secret:'synthetic'});tx.appendEvent({tenantId:'tenant',aggregateType:'guard',aggregateId:'record',expectedStreamVersion:0,type:'guard.changed',actorId:'actor',generation:0,correlationId:'guard',publicPayload:{}});tx.putIdempotency({tenantId:'tenant',scope:'guard',key:'request',requestDigest:'a'.repeat(64),response:{id:'record'},createdAt:new Date().toISOString()});}),/CURRENT_AUTHORIZATION_EXPIRED/);
 assert.equal((await store.readEvents('tenant',0,100)).events.length,0);
 await store.transact('tenant',tx=>{assert.equal((tx as any).getStreamVersion('guard','record'),0);assert.equal(tx.getProjection('protected-test','record'),undefined);assert.equal(tx.getIdempotency('guard','request'),undefined);});
});
