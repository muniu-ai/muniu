// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
export async function createTestOidcIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-rsa', use: 'sig', alg: 'RS256' };
  const codes = new Map<string, { subject: string; challenge: string; nonce: string; redirectUri: string; mode: string }>();
  let origin = '', exchanges = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin); response.setHeader('content-type', 'application/json');
    if (url.pathname === '/.well-known/openid-configuration') return response.end(JSON.stringify({ issuer: origin,
      authorization_endpoint: `${origin}authorize`, token_endpoint: `${origin}token`, jwks_uri: `${origin}jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] }));
    if (url.pathname === '/jwks') return response.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname !== '/token' || request.method !== 'POST') { response.statusCode = 404; return response.end('{}'); }
    exchanges++;
    let raw = ''; for await (const chunk of request) raw += chunk;
    const form = new URLSearchParams(raw), code = codes.get(form.get('code') ?? '');
    if (!code || form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== 'muniu-fixture'
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
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test issuer address');
  origin = `http://127.0.0.1:${address.port}/`;
  return { issuer: origin, exchanges: () => exchanges,
    callback(authorizationUrl: string, subject = 'admin-subject', mode = 'normal') {
      const url = new URL(authorizationUrl);
      if (url.origin + '/' !== origin || url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('response_type') !== 'code') throw new Error('Invalid authorization request');
      const code = randomBytes(32).toString('base64url');
      codes.set(code, { subject, challenge: url.searchParams.get('code_challenge')!, nonce: url.searchParams.get('nonce')!, redirectUri: url.searchParams.get('redirect_uri')!, mode });
      const callback = new URL(url.searchParams.get('redirect_uri')!); callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state')!);
      return callback.href;
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
