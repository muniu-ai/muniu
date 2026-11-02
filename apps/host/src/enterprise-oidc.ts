// SPDX-License-Identifier: Apache-2.0
import * as oidc from 'openid-client';
import { EnterpriseError, type LoginAttempt } from '@mn/enterprise-services';
export interface EnterpriseOidcProvider {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: () => Promise<string>;
}
export interface EnterpriseOidcPort {
  authorizationUrl(tenantId: string, attempt: LoginAttempt): Promise<string>;
  exchange(tenantId: string, callback: URL, attempt: LoginAttempt): Promise<{ issuer: string; subject: string }>;
}
const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
function endpoint(value: string, development: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(development && url.protocol === 'http:' && loopback(url))))
    throw new EnterpriseError('OIDC_ENDPOINT_INVALID', 503);
  return url;
}
export function createEnterpriseOidc(options: { providers: Readonly<Record<string, EnterpriseOidcProvider>>; redirectUri: string; development: boolean }): EnterpriseOidcPort {
  endpoint(options.redirectUri, options.development);
  const configurations = new Map<string, Promise<oidc.Configuration>>();
  function config(tenantId: string): Promise<oidc.Configuration> {
    if (!Object.hasOwn(options.providers, tenantId)) throw new EnterpriseError('ORGANIZATION_NOT_FOUND', 404);
    const provider = options.providers[tenantId]!;
    let pending = configurations.get(tenantId);
    if (!pending) {
      pending = (async () => {
        const issuer = endpoint(provider.issuer, options.development);
        const secret = await provider.clientSecret?.();
        const configuration = await oidc.discovery(issuer, provider.clientId,
          { ...(secret ? { client_secret: secret } : {}), id_token_signed_response_alg: 'RS256' },
          secret ? oidc.ClientSecretPost(secret) : oidc.None(),
          { timeout: 10, execute: [...(options.development && issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : []), oidc.enableNonRepudiationChecks] });
        const metadata = configuration.serverMetadata();
        for (const value of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
          if (!value) throw new EnterpriseError('OIDC_ENDPOINT_INVALID', 503);
          endpoint(value, options.development);
        }
        return configuration;
      })();
      configurations.set(tenantId, pending);
      void pending.catch(() => { if (configurations.get(tenantId) === pending) configurations.delete(tenantId); });
    }
    return pending;
  }
  return {
    async authorizationUrl(tenantId, attempt) {
      const configuration = await config(tenantId);
      return oidc.buildAuthorizationUrl(configuration, { redirect_uri: options.redirectUri, scope: 'openid', response_type: 'code',
        code_challenge: await oidc.calculatePKCECodeChallenge(attempt.codeVerifier), code_challenge_method: 'S256',
        state: attempt.state, nonce: attempt.nonce }).href;
    },
    async exchange(tenantId, callback, attempt) {
      if (`${callback.origin}${callback.pathname}` !== options.redirectUri) throw new EnterpriseError('LOGIN_CALLBACK_INVALID', 401);
      const configuration = await config(tenantId);
      const tokens = await oidc.authorizationCodeGrant(configuration, callback, { expectedState: attempt.state, expectedNonce: attempt.nonce,
        pkceCodeVerifier: attempt.codeVerifier, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 200) throw new EnterpriseError('IDENTITY_NOT_BOUND', 401);
      return { issuer: configuration.serverMetadata().issuer, subject: claims.sub };
    },
  };
}
