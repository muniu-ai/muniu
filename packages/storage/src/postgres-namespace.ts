// SPDX-License-Identifier: Apache-2.0
import type { PostgresPoolLike } from './postgres.js';
export type PostgresNamespace = 'mn_v2' | 'mn_enterprise_v1';
const boundPools = new WeakMap<PostgresPoolLike, PostgresNamespace>();
function assertNamespace(namespace: PostgresNamespace): void {
  if (namespace !== 'mn_v2' && namespace !== 'mn_enterprise_v1') throw new TypeError('Unsupported PostgreSQL namespace');
}
/** Render repository-owned SQL templates; data stays in query parameters. No search_path or legacy schema reads. */
export function renderPostgresNamespace(sql: string, namespace: PostgresNamespace): string {
  assertNamespace(namespace);
  if (namespace === 'mn_v2') return sql;
  let result = '', i = 0;
  while (i < sql.length) {
    const start = i, char = sql[i]!;
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; }
    else if (sql.startsWith('/*', i)) {
      i += 2; let depth = 1;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new TypeError('Unterminated SQL comment');
    } else if (char === "'" || char === '"') {
      i++; let closed = false;
      while (i < sql.length) {
        if (sql[i] === char) { if (sql[i + 1] === char) { i += 2; continue; } i++; closed = true; break; }
        // Escape strings are not used in storage templates; reject ambiguous backslash quoting.
        if (sql[i] === '\\') throw new TypeError('SQL template escape strings are not supported');
        i++;
      }
      if (!closed) throw new TypeError('Unterminated SQL literal');
      if (char === '"' && sql.slice(start, i) === '"mn_v2"') { result += `"${namespace}"`; continue; }
    } else if (char === '$' && /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/u.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/u)![0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new TypeError('Unterminated SQL dollar string');
      i = end + tag.length;
    } else if (/[a-zA-Z_]/u.test(char)) {
      i++; while (i < sql.length && /[a-zA-Z0-9_$]/u.test(sql[i]!)) i++;
      if (sql.slice(start, i).toLowerCase() === 'mn_v2') { result += namespace; continue; }
    } else i++;
    result += sql.slice(start, i);
  }
  return result;
}
export function scopePostgresPool(pool: PostgresPoolLike, namespace: PostgresNamespace): PostgresPoolLike {
  assertNamespace(namespace);
  const current = boundPools.get(pool);
  if (current) { if (current !== namespace) throw new TypeError('PostgreSQL pool namespace cannot be changed'); return pool; }
  if (namespace === 'mn_v2') return pool;
  const scoped: PostgresPoolLike = {
    query: (sql, parameters) => pool.query(renderPostgresNamespace(sql, namespace), parameters),
    async connect() {
      const client = await pool.connect();
      return { query: (sql, parameters) => client.query(renderPostgresNamespace(sql, namespace), parameters), release: () => client.release() };
    },
    ...(pool.end ? { end: () => pool.end!() } : {}),
  };
  boundPools.set(scoped, namespace); return scoped;
}
