// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { renderResponseTypes } from './schema-types.mjs';

export async function generateResponseTypes({ check = false } = {}) {
  const entry = new URL('../../packages/contracts/src/api-response-schema.ts', import.meta.url);
  const compiled = await build({ entryPoints: [fileURLToPath(entry)], bundle: true, platform: 'node', format: 'esm', write: false });
  const schema = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
  const content = renderResponseTypes({ outputs: schema.API_OUTPUT_SCHEMAS_V2,
    components: schema.API_OUTPUT_COMPONENTS_V2, publicTypes: schema.API_OUTPUT_PUBLIC_TYPES_V2 });
  const path = new URL('../../packages/contracts/src/api-outputs.ts', import.meta.url);
  if (check) {
    if (await readFile(path, 'utf8').catch(() => '') !== content) throw new Error('响应类型过期，请运行 npm run generate:contracts');
  } else await writeFile(path, content);
}
