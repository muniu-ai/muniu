// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startEnterpriseWebFixture } from './lib/enterprise-web-fixture.mjs';

async function main() {
  const args = process.argv.slice(2), values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--web-root', '--mode'].includes(key) || !value || Object.hasOwn(values, key)) throw new Error('FIXTURE_OPTIONS_INVALID');
    values[key] = value;
  }
  let stopping = false, active;
  const starting = startEnterpriseWebFixture({ webRoot: values['--web-root'], mode: values['--mode'] ?? 'seeded' });
  const stop = () => {
    stopping = true;
    void starting.then(fixture => fixture.close()).catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    active = await starting;
    if (stopping) { await active.close(); return; }
    process.stdout.write(JSON.stringify({ status: 'ready', synthetic: true, mode: active.mode, origin: active.origin }) + '\n');
  } catch (error) {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await active?.close(); throw error;
  }
}
let directlyInvoked = false;
try { directlyInvoked = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (directlyInvoked) main().catch(() => { process.stderr.write('合成 Web 验收夹具启动失败。\n'); process.exitCode = 1; });
