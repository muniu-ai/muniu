// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
function denied() { const error = new Error('MCP 凭据存储不可用或作用域不匹配'); error.code = 'MCP_CREDENTIAL_UNAVAILABLE'; return error; }
function account(scope) {
  const values = [scope?.tenantId, scope?.workspaceId, scope?.connectionId, scope?.credentialId];
  if (!values.every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) throw denied();
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
function validToken(value) { return typeof value === 'string' && value.length <= 8192 && /^[\x21-\x7e]+$/u.test(value); }
export function lazyVaultMcpSecretStore(options) {
  let store;
  const current = () => { try { return store ??= new VaultMcpSecretStore(options()); } catch { throw denied(); } };
  return { async save(scope, token) { return current().save(scope, token); }, async read(scope, reference) { return current().read(scope, reference); } };
}
export class VaultMcpSecretStore {
  #address; #token; #mount; #namespace; #fetch;
  constructor({ address, token, mount = 'secret', namespace, fetchImplementation = fetch }) {
    this.#address = new URL(address);
    const normalizedNamespace = namespace === '' ? undefined : namespace;
    if (!['http:', 'https:'].includes(this.#address.protocol) || this.#address.username || this.#address.password || this.#address.search || this.#address.hash
      || !validToken(token) || !/^[A-Za-z0-9._-]+$/u.test(mount) || (normalizedNamespace !== undefined && !/^[A-Za-z0-9._/-]+$/u.test(normalizedNamespace))) throw denied();
    this.#token = token; this.#mount = mount; this.#namespace = normalizedNamespace; this.#fetch = fetchImplementation;
  }
  reference(scope) { return `vault://muniu/v2/mcp/${account(scope)}`; }
  #url(scope) { return new URL(`/v1/${encodeURIComponent(this.#mount)}/data/muniu/v2/mcp/${account(scope)}`, this.#address); }
  #headers() { return { 'content-type': 'application/json', 'x-vault-token': this.#token, ...(this.#namespace ? { 'x-vault-namespace': this.#namespace } : {}) }; }
  async save(scope, bearerToken) {
    if (!validToken(bearerToken)) throw denied();
    try {
      const response = await this.#fetch(this.#url(scope), { method: 'POST', headers: this.#headers(), redirect: 'error', signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ options: { cas: 0 }, data: { bearerToken, scopeDigest: account(scope) } }) });
      await response.body?.cancel(); if (!response.ok) throw denied(); return this.reference(scope);
    } catch { throw denied(); }
  }
  async read(scope, reference) {
    if (reference !== this.reference(scope)) throw denied();
    try {
      const response = await this.#fetch(this.#url(scope), { headers: this.#headers(), redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw denied(); }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 16384) throw denied(); chunks.push(Buffer.from(chunk.value)); } }
      finally { await reader.cancel(); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.data?.data;
      if (!validToken(value?.bearerToken) || value.scopeDigest !== account(scope)) throw denied(); return value.bearerToken;
    } catch { throw denied(); }
  }
}
