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
  const apiBundle = await build({ entryPoints: [fileURLToPath(new URL('../../packages/contracts/src/enterprise-api-schema.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false });
  const { ENTERPRISE_HTTP_OPERATIONS: operations } = await import(`data:text/javascript;base64,${Buffer.from(apiBundle.outputFiles[0].contents).toString('base64')}`);
  const inputs = operations.map(op => {
    const names = [...op.path.matchAll(/\{([^}]+)\}/gu)].map(match => match[1]);
    return `  readonly ${op.id}: { ${names.length ? `readonly path: { ${names.map(name => `readonly ${name}: string;`).join(' ')} };` : 'readonly path?: Record<string, never>;'}${op.body ? ` readonly body: Types.${op.body};` : ''}${op.mutation ? ' readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; };' : ''} };`;
  });
  const apiContent = '// Generated from enterprise-api-schema.ts. Do not edit.\n// SPDX-License-Identifier: Apache-2.0\nimport type * as Types from "./enterprise-types.js";\n'
    + `export interface EnterpriseApiInputs {\n${inputs.join('\n')}\n}\nexport interface EnterpriseApiOutputs {\n`
    + operations.map(op => `  readonly ${op.id}: Types.${op.response};`).join('\n') + '\n}\n';
  const apiPath = new URL('../../packages/contracts/src/enterprise-api-types.ts', import.meta.url);
  if (check) {
    if (await readFile(apiPath, 'utf8').catch(() => '') !== apiContent) throw new Error('企业 API 类型过期，请运行 npm run generate:contracts');
  } else await writeFile(apiPath, apiContent);
}
