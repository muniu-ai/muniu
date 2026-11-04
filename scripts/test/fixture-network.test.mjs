// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForFixturePort } from '../lib/fixture-network.mjs';
test('fixture waits for the loopback port mapping instead of assuming container start means publication',async()=>{
 const responses=['','','127.0.0.1:35432'];let waits=0;
 assert.equal(await waitForFixturePort(async()=>responses.shift(),async()=>{waits++;}), '127.0.0.1:35432');assert.equal(waits,2);
 await assert.rejects(waitForFixturePort(async()=>'0.0.0.0:5432'),/loopback/);
 await assert.rejects(waitForFixturePort(async()=>'',async()=>{},2),/not ready/);
});
