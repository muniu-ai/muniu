// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenarios = ['smoke', 'permissions', 'cancellation', 'initialization', 'knowledge', 'finance', 'management', 'sales', 'delivery', 'metrics', 'finance-actions', 'changes'];
const script = fileURLToPath(new URL('./verify-enterprise-web-ui.mjs', import.meta.url));
let active, interrupted;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = signal; active?.kill(signal); });
for (const scenario of scenarios) {
  if (interrupted) break;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--scenario', scenario], { stdio: 'inherit' }); active = child;
    child.once('error', reject); child.once('close', (code, signal) => { active = undefined; resolve({ code, signal }); });
  });
  if (result.code !== 0 || result.signal) {
    process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
    break;
  }
}
if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
