// SPDX-License-Identifier: Apache-2.0
export function schemaType(schema) {
  if (schema.$ref) {
    if (!/^#\/components\/schemas\/[A-Za-z_][A-Za-z_0-9]*$/u.test(schema.$ref)) throw new Error(`Unsupported reference: ${schema.$ref}`);
    return schema.$ref.split('/').at(-1);
  }
  if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  for (const [key, separator] of [['oneOf', ' | '], ['anyOf', ' | '], ['allOf', ' & ']]) {
    if (schema[key]) return schema[key].map(child => `(${schemaType(child)})`).join(separator);
  }
  if (schema.type === 'string' && schema.format === 'binary') return 'ArrayBuffer';
  if (schema.type === 'array') return `readonly (${schemaType(schema.items)})[]`;
  if (schema.type === 'object') {
    const properties = Object.entries(schema.properties ?? {}).map(([name, value]) =>
      `readonly ${JSON.stringify(name)}${schema.required?.includes(name) ? '' : '?'}: ${schemaType(value)};`);
    if (schema.additionalProperties !== false) properties.push(`readonly [key: string]: ${typeof schema.additionalProperties === 'object' ? schemaType(schema.additionalProperties) : 'unknown'};`);
    return `{ ${properties.join(' ')} }`;
  }
  const result = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', null: 'null' }[schema.type];
  if (!result) throw new Error(`Unsupported schema: ${JSON.stringify(schema)}`);
  return result;
}

export function renderResponseTypes({ outputs, components, publicTypes }) {
  const declarations = Object.entries(components).map(([name, value]) => `type ${name} = ${schemaType(value)};`);
  for (const [name, component] of Object.entries(publicTypes)) {
    if (!Object.hasOwn(components, component)) throw new Error(`Missing schema: ${component}`);
    declarations.push(`export type ${name} = ${component};`);
  }
  declarations.push(`export interface ApiOutputsV2 {\n${Object.entries(outputs).map(([operation, value]) => `  readonly ${operation}: ${schemaType(value)};`).join('\n')}\n}`);
  return `// Generated from api-response-schema.ts by scripts/generate-api-client.mjs. Do not edit.\n// SPDX-License-Identifier: Apache-2.0\n${declarations.join('\n')}\n`;
}
