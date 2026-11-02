// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { schemaType } from './schema-types.mjs';
export async function generateEnterpriseTypes({ check = false } = {}) {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL('../../packages/contracts/src/enterprise-schema.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false });
  const { ENTERPRISE_SCHEMAS: schemas } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
  const content = '// Generated from enterprise-schema.ts. Do not edit.\n// SPDX-License-Identifier: Apache-2.0\n'
    + Object.entries(schemas).map(([name, schema]) => `export type ${name} = ${schemaType(schema)};`).join('\n')
    + '\nexport interface EnterpriseContractTypes {\n' + Object.keys(schemas).map(name => `  readonly ${name}: ${name};`).join('\n') + '\n}\n';
  const path = new URL('../../packages/contracts/src/enterprise-types.ts', import.meta.url);
  if (check) {
    if (await readFile(path, 'utf8').catch(() => '') !== content) throw new Error('企业契约类型过期，请运行 npm run generate:contracts');
  } else await writeFile(path, content);
}
