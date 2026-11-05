// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
export async function createTestOidcIssuer(options: { browser?: { accounts: readonly { subject: string; label: string }[]; redirectUris: readonly string[] } } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-rsa', use: 'sig', alg: 'RS256' };
  const codes = new Map<string, { subject: string; challenge: string; nonce: string; redirectUri: string; mode: string; expiresAt: number }>();
  const selections = new Map<string, { authorizationUrl: string; browserSecret: string; expiresAt: number }>();
  let origin = '', exchanges = 0;
  const callback = (authorizationUrl: string, subject = 'admin-subject', mode = 'normal') => {
    const url = new URL(authorizationUrl);
    if (url.origin + '/' !== origin || url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('response_type') !== 'code') throw new Error('Invalid authorization request');
    const code = randomBytes(32).toString('base64url');
    codes.set(code, { subject, challenge: url.searchParams.get('code_challenge')!, nonce: url.searchParams.get('nonce')!, redirectUri: url.searchParams.get('redirect_uri')!, mode, expiresAt: Date.now() + 300000 });
    const target = new URL(url.searchParams.get('redirect_uri')!); target.searchParams.set('code', code); target.searchParams.set('state', url.searchParams.get('state')!);
    return target.href;
  };
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const readForm = async (request: AsyncIterable<unknown>) => {
    let raw = ''; for await (const chunk of request) { raw += String(chunk); if (Buffer.byteLength(raw) > 16384) throw new Error('FORM_LIMIT'); }
    return new URLSearchParams(raw);
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin); response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store'); response.setHeader('referrer-policy', 'no-referrer');
    try {
    for (const [id, value] of selections) if (value.expiresAt <= Date.now()) selections.delete(id);
    for (const [id, value] of codes) if (value.expiresAt <= Date.now()) codes.delete(id);
    if (url.pathname === '/authorize' && options.browser) {
      if (request.method === 'GET') {
        const required = ['client_id', 'redirect_uri', 'response_type', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];
        if (url.origin !== new URL(origin).origin || required.some(name => url.searchParams.getAll(name).length !== 1 || !url.searchParams.get(name) || url.searchParams.get(name)!.length > 1000)
          || url.searchParams.get('client_id') !== 'muniu-fixture' || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256'
          || !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get('code_challenge')!) || !options.browser.redirectUris.includes(url.searchParams.get('redirect_uri')!) || selections.size >= 100) throw new Error('AUTHORIZATION_INVALID');
        const id = randomBytes(32).toString('base64url'), browserSecret = randomBytes(32).toString('base64url');
        selections.set(id, { authorizationUrl: url.href, browserSecret, expiresAt: Date.now() + 600000 });
        response.setHeader('set-cookie', `mn-test-oidc-login=${browserSecret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
        response.setHeader('content-type', 'text/html; charset=utf-8'); response.setHeader('x-content-type-options', 'nosniff');
        response.setHeader('referrer-policy', 'strict-origin');
        response.setHeader('content-security-policy', "default-src 'none'; form-action 'self' " + url.searchParams.get('redirect_uri')! + "; base-uri 'none'; frame-ancestors 'none'");
        return response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>合成身份发行方</title><body><h1>合成身份发行方</h1><p>仅限本地验收。选择合成账号后，通过授权码返回企业入口。</p><form method="post" action="/authorize"><input type="hidden" name="request" value="' + id + '">' + options.browser.accounts.map(account => '<button type="submit" name="subject" value="' + escape(account.subject) + '">' + escape(account.label) + '</button>').join(' ') + '</form></body></html>');
      }
      if (request.method === 'POST') {
        const form = await readForm(request), selected = selections.get(form.get('request') ?? '');
        const browserSecret = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('mn-test-oidc-login='))?.slice('mn-test-oidc-login='.length);
        if (request.headers.origin !== new URL(origin).origin || !selected || selected.expiresAt <= Date.now() || browserSecret !== selected.browserSecret
          || [...form.keys()].some(name => !['request', 'subject'].includes(name)) || form.getAll('request').length !== 1 || form.getAll('subject').length !== 1
          || !options.browser.accounts.some(account => account.subject === form.get('subject'))) throw new Error('SELECTION_INVALID');
        selections.delete(form.get('request')!);
        response.statusCode = 303; response.setHeader('location', callback(selected.authorizationUrl, form.get('subject')!)); return response.end();
      }
      response.statusCode = 404; return response.end('{}');
    }
    if (url.pathname === '/.well-known/openid-configuration') return response.end(JSON.stringify({ issuer: origin,
      authorization_endpoint: `${origin}authorize`, token_endpoint: `${origin}token`, jwks_uri: `${origin}jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] }));
    if (url.pathname === '/jwks') return response.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname !== '/token' || request.method !== 'POST') { response.statusCode = 404; return response.end('{}'); }
    exchanges++;
    const form = await readForm(request), code = codes.get(form.get('code') ?? '');
    if (!code || code.expiresAt <= Date.now() || form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== 'muniu-fixture'
      || form.get('redirect_uri') !== code.redirectUri || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== code.challenge) {
      response.statusCode = 400; return response.end(JSON.stringify({ error: 'invalid_grant' }));
    }
    codes.delete(form.get('code')!);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-rsa' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: origin, sub: code.subject, aud: code.mode === 'wrong-audience' ? 'other-client' : 'muniu-fixture',
      exp: code.mode === 'expired' ? now - 60 : now + 300, iat: now, nonce: code.mode === 'wrong-nonce' ? 'wrong-nonce' : code.nonce,
      tenant_id: 'attacker-tenant', organization_roles: ['organization_admin'], email: 'untrusted@example.invalid' })).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    const jwt = `${header}.${payload}.${code.mode === 'bad-signature' ? Buffer.alloc(256).toString('base64url') : signature}`;
    response.end(JSON.stringify({ access_token: randomBytes(32).toString('base64url'), token_type: 'Bearer', expires_in: 300, id_token: jwt }));
    } catch { response.statusCode = 400; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: 'invalid_request' })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test issuer address');
  origin = `http://127.0.0.1:${address.port}/`;
  let closing: Promise<void> | undefined;
  return { issuer: origin, exchanges: () => exchanges, callback,
    close() { return closing ??= (async () => { selections.clear(); codes.clear(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); })(); },
  };
}
