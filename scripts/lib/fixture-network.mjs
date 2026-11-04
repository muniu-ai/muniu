// SPDX-License-Identifier: Apache-2.0
import { setTimeout as delay } from 'node:timers/promises';
export async function waitForFixturePort(read, wait=delay, attempts=40) {
 for(let attempt=0;attempt<attempts;attempt++) {
  const value=await read();
  if(value) {
   if(!/^127\.0\.0\.1:[1-9][0-9]*$/u.test(value)||Number(value.split(':')[1])>65535)throw new Error('Fixture port must bind loopback');
   return value;
  }
  await wait(250);
 }
 throw new Error('Fixture port mapping not ready');
}
