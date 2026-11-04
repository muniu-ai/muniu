// SPDX-License-Identifier: Apache-2.0
import {readFile} from 'node:fs/promises';
import {actionFixture} from './lib/enterprise-action-fixture.mjs';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const f=await actionFixture(config,{workerId:'crash-worker',afterCommit:async action=>{process.send?.({status:'committed',actionId:action.id});await new Promise(()=>{});}});
try{await f.worker(config.workspaceId).pollOnce();}finally{await f.close();}
