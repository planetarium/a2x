import { describe, it, expect, vi } from 'vitest';
import { ApiKeyAuthorization } from '../security/api-key.js';
import { HttpBearerAuthorization } from '../security/http-bearer.js';
import { OAuth2AuthorizationCodeAuthorization } from '../security/oauth2-authorization-code.js';
import { OAuth2ClientCredentialsAuthorization } from '../security/oauth2-client-credentials.js';
import { OAuth2DeviceCodeAuthorization } from '../security/oauth2-device-code.js';
import { OpenIdConnectAuthorization } from '../security/openid-connect.js';
import { MutualTlsAuthorization } from '../security/mutual-tls.js';
import type { RequestContext } from '../types/auth.js';

describe('Layer 1: SecurityScheme Classes', () => {
  describe('ApiKeyAuthorization', () => {
    it('should create with required fields', () => {
      const scheme = new ApiKeyAuthorization({
        in: 'header',
        name: 'X-API-Key',
      });
      expect(scheme.in).toBe('header');
      expect(scheme.name).toBe('X-API-Key');
    });

    it('should throw on missing required fields', () => {
      expect(
        () =>
          new ApiKeyAuthorization({ in: '' as 'header', name: 'X-API-Key' }),
      ).toThrow();
    });

    it('toV03Schema should return apiKey type', () => {
      const scheme = new ApiKeyAuthorization({
        in: 'header',
        name: 'X-API-Key',
        description: 'API key auth',
      });
      const v03 = scheme.toV03Schema()!;
      expect(v03).toEqual({
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key auth',
      });
    });

    it('toV10Schema should use "location" instead of "in"', () => {
      const scheme = new ApiKeyAuthorization({
        in: 'query',
        name: 'api_key',
      });
      const v10 = scheme.toV10Schema();
      expect(v10).toEqual({
        apiKeySecurityScheme: {
          location: 'query',
          name: 'api_key',
        },
      });
    });
  });

  describe('HttpBearerAuthorization', () => {
    it('should create with required fields', () => {
      const scheme = new HttpBearerAuthorization({ scheme: 'bearer' });
      expect(scheme.scheme).toBe('bearer');
    });

    it('toV03Schema should return http type', () => {
      const scheme = new HttpBearerAuthorization({
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Bearer token',
      });
      const v03 = scheme.toV03Schema()!;
      expect(v03).toEqual({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Bearer token',
      });
    });

    it('toV10Schema should return httpAuthSecurityScheme', () => {
      const scheme = new HttpBearerAuthorization({
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
      const v10 = scheme.toV10Schema();
      expect(v10).toEqual({
        httpAuthSecurityScheme: {
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      });
    });
  });

  describe('OAuth2AuthorizationCodeAuthorization', () => {
    const opts = {
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: { read: 'Read access', write: 'Write access' },
      refreshUrl: 'https://auth.example.com/refresh',
      pkceRequired: true,
    };

    it('should create with required fields', () => {
      const scheme = new OAuth2AuthorizationCodeAuthorization(opts);
      expect(scheme.authorizationUrl).toBe(opts.authorizationUrl);
      expect(scheme.tokenUrl).toBe(opts.tokenUrl);
    });

    it('toV03Schema should return oauth2 type with authorizationCode flow', () => {
      const scheme = new OAuth2AuthorizationCodeAuthorization(opts);
      const v03 = scheme.toV03Schema()!;
      expect(v03).toMatchObject({
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: opts.authorizationUrl,
            tokenUrl: opts.tokenUrl,
            scopes: opts.scopes,
            refreshUrl: opts.refreshUrl,
          },
        },
      });
      // v0.3 should NOT have pkceRequired
      expect(
        (v03 as { type: 'oauth2'; flows: { authorizationCode?: { pkceRequired?: boolean } } }).flows
          .authorizationCode?.pkceRequired,
      ).toBeUndefined();
    });

    it('toV10Schema should include pkceRequired', () => {
      const scheme = new OAuth2AuthorizationCodeAuthorization(opts);
      const v10 = scheme.toV10Schema();
      expect(v10.oauth2SecurityScheme?.flows.authorizationCode?.pkceRequired).toBe(
        true,
      );
    });
  });

  describe('OAuth2ClientCredentialsAuthorization', () => {
    it('toV03Schema and toV10Schema should map correctly', () => {
      const scheme = new OAuth2ClientCredentialsAuthorization({
        tokenUrl: 'https://auth.example.com/token',
        scopes: { read: 'Read' },
      });

      const v03 = scheme.toV03Schema()!;
      expect(v03).toMatchObject({
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://auth.example.com/token',
            scopes: { read: 'Read' },
          },
        },
      });

      const v10 = scheme.toV10Schema();
      expect(v10.oauth2SecurityScheme?.flows.clientCredentials?.tokenUrl).toBe(
        'https://auth.example.com/token',
      );
    });
  });

  describe('OAuth2DeviceCodeAuthorization', () => {
    const opts = {
      deviceAuthorizationUrl: 'https://auth.example.com/device',
      tokenUrl: 'https://auth.example.com/token',
      scopes: { read: 'Read' },
    };

    it('toV03Schema should return null and emit warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const scheme = new OAuth2DeviceCodeAuthorization(opts);
      const v03 = scheme.toV03Schema();
      expect(v03).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('not supported in A2A v0.3'),
      );
      warnSpy.mockRestore();
    });

    it('toV10Schema should return oauth2 with deviceCode flow', () => {
      const scheme = new OAuth2DeviceCodeAuthorization(opts);
      const v10 = scheme.toV10Schema();
      expect(v10.oauth2SecurityScheme?.flows.deviceCode).toEqual({
        deviceAuthorizationUrl: opts.deviceAuthorizationUrl,
        tokenUrl: opts.tokenUrl,
        scopes: opts.scopes,
      });
    });
  });

  describe('OpenIdConnectAuthorization', () => {
    it('should map to v0.3 and v1.0 correctly', () => {
      const scheme = new OpenIdConnectAuthorization({
        openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
      });

      const v03 = scheme.toV03Schema()!;
      expect(v03).toEqual({
        type: 'openIdConnect',
        openIdConnectUrl:
          'https://example.com/.well-known/openid-configuration',
      });

      const v10 = scheme.toV10Schema();
      expect(v10.openIdConnectSecurityScheme?.openIdConnectUrl).toBe(
        'https://example.com/.well-known/openid-configuration',
      );
    });
  });

  describe('MutualTlsAuthorization', () => {
    it('should map to v0.3 and v1.0 correctly', () => {
      const scheme = new MutualTlsAuthorization({ description: 'mTLS' });

      const v03 = scheme.toV03Schema()!;
      expect(v03).toEqual({ type: 'mutualTLS', description: 'mTLS' });

      const v10 = scheme.toV10Schema();
      expect(v10.mtlsSecurityScheme?.description).toBe('mTLS');
    });

    it('should work without options', () => {
      const scheme = new MutualTlsAuthorization();
      const v03 = scheme.toV03Schema()!;
      expect(v03).toEqual({ type: 'mutualTLS' });
    });
  });
});

// ─── Authentication Tests ───

describe('SecurityScheme authenticate()', () => {
  const ctx = (headers: Record<string, string> = {}): RequestContext => ({
    headers,
  });

  describe('ApiKeyAuthorization', () => {
    it('should pass-through when no validation config', async () => {
      const scheme = new ApiKeyAuthorization({ in: 'header', name: 'X-API-Key' });
      const result = await scheme.authenticate(ctx());
      expect(result.authenticated).toBe(true);
    });

    it('should authenticate with valid key in header', async () => {
      const scheme = new ApiKeyAuthorization({
        in: 'header',
        name: 'x-api-key',
        keys: ['secret-key'],
      });
      const result = await scheme.authenticate(ctx({ 'x-api-key': 'secret-key' }));
      expect(result.authenticated).toBe(true);
    });

    it('should reject invalid key', async () => {
      const scheme = new ApiKeyAuthorization({
        in: 'header',
        name: 'x-api-key',
        keys: ['secret-key'],
      });
      const result = await scheme.authenticate(ctx({ 'x-api-key': 'wrong-key' }));
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Invalid API key');
    });

    it('should reject missing key', async () => {
      const scheme = new ApiKeyAuthorization({
        in: 'header',
        name: 'x-api-key',
        keys: ['secret-key'],
      });
      const result = await scheme.authenticate(ctx());
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Missing API key');
    });

    it('should authenticate with key in query', async () => {
      const scheme = new ApiKeyAuthorization({
        in: 'query',
        name: 'api_key',
        keys: ['qk-123'],
      });
      const result = await scheme.authenticate({
        headers: {},
        query: { api_key: 'qk-123' },
      });
      expect(result.authenticated).toBe(true);
    });

    it('should authenticate with key in cookie', async () => {
      const scheme = new ApiKeyAuthorization({
        in: 'cookie',
        name: 'session',
        keys: ['sess-abc'],
      });
      const result = await scheme.authenticate({
        headers: {},
        cookies: { session: 'sess-abc' },
      });
      expect(result.authenticated).toBe(true);
    });

    it('should use custom validator over keys list', async () => {
      const validator = vi.fn().mockResolvedValue({
        authenticated: true,
        principal: { userId: '42' },
      });
      const scheme = new ApiKeyAuthorization({
        in: 'header',
        name: 'x-api-key',
        keys: ['not-used'],
        validator,
      });
      const result = await scheme.authenticate(ctx({ 'x-api-key': 'custom' }));
      expect(result.authenticated).toBe(true);
      expect(result.principal).toEqual({ userId: '42' });
      expect(validator).toHaveBeenCalledWith('custom');
    });
  });

  describe('HttpBearerAuthorization', () => {
    it('should pass-through when no validator', async () => {
      const scheme = new HttpBearerAuthorization({ scheme: 'bearer' });
      const result = await scheme.authenticate(ctx());
      expect(result.authenticated).toBe(true);
    });

    it('should extract and validate bearer token', async () => {
      const validator = vi.fn().mockResolvedValue({
        authenticated: true,
        principal: { sub: 'user-1' },
      });
      const scheme = new HttpBearerAuthorization({ scheme: 'bearer', validator });
      const result = await scheme.authenticate(
        ctx({ authorization: 'Bearer my-token-123' }),
      );
      expect(result.authenticated).toBe(true);
      expect(validator).toHaveBeenCalledWith('my-token-123');
    });

    it('should reject missing Authorization header', async () => {
      const validator = vi.fn();
      const scheme = new HttpBearerAuthorization({ scheme: 'bearer', validator });
      const result = await scheme.authenticate(ctx());
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Missing Authorization header');
      expect(validator).not.toHaveBeenCalled();
    });

    it('should reject wrong scheme', async () => {
      const validator = vi.fn();
      const scheme = new HttpBearerAuthorization({ scheme: 'bearer', validator });
      const result = await scheme.authenticate(
        ctx({ authorization: 'Basic dXNlcjpwYXNz' }),
      );
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Expected scheme: bearer');
      expect(validator).not.toHaveBeenCalled();
    });
  });

  describe('OAuth2AuthorizationCodeAuthorization', () => {
    const baseOpts = {
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: { read: 'Read', write: 'Write' },
    };

    it('should pass-through when no tokenValidator', async () => {
      const scheme = new OAuth2AuthorizationCodeAuthorization(baseOpts);
      const result = await scheme.authenticate(ctx());
      expect(result.authenticated).toBe(true);
    });

    it('should validate token with scopes', async () => {
      const tokenValidator = vi.fn().mockResolvedValue({
        authenticated: true,
        scopes: ['read', 'write'],
      });
      const scheme = new OAuth2AuthorizationCodeAuthorization({
        ...baseOpts,
        tokenValidator,
      });
      const result = await scheme.authenticate(
        ctx({ authorization: 'Bearer access-tok' }),
        ['read'],
      );
      expect(result.authenticated).toBe(true);
      expect(tokenValidator).toHaveBeenCalledWith('access-tok', ['read']);
    });

    it('should reject missing bearer token', async () => {
      const scheme = new OAuth2AuthorizationCodeAuthorization({
        ...baseOpts,
        tokenValidator: vi.fn(),
      });
      const result = await scheme.authenticate(ctx());
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Missing Bearer token');
    });
  });

  describe('OAuth2ClientCredentialsAuthorization', () => {
    it('should validate token via tokenValidator', async () => {
      const tokenValidator = vi.fn().mockResolvedValue({
        authenticated: true,
        scopes: ['api'],
      });
      const scheme = new OAuth2ClientCredentialsAuthorization({
        tokenUrl: 'https://auth.example.com/token',
        scopes: { api: 'API access' },
        tokenValidator,
      });
      const result = await scheme.authenticate(
        ctx({ authorization: 'Bearer cc-token' }),
        ['api'],
      );
      expect(result.authenticated).toBe(true);
      expect(tokenValidator).toHaveBeenCalledWith('cc-token', ['api']);
    });
  });

  describe('OAuth2DeviceCodeAuthorization', () => {
    it('should validate token via tokenValidator', async () => {
      const tokenValidator = vi.fn().mockResolvedValue({
        authenticated: true,
      });
      const scheme = new OAuth2DeviceCodeAuthorization({
        deviceAuthorizationUrl: 'https://auth.example.com/device',
        tokenUrl: 'https://auth.example.com/token',
        scopes: { read: 'Read' },
        tokenValidator,
      });
      const result = await scheme.authenticate(
        ctx({ authorization: 'Bearer dc-token' }),
      );
      expect(result.authenticated).toBe(true);
      expect(tokenValidator).toHaveBeenCalledWith('dc-token', []);
    });
  });

  describe('OpenIdConnectAuthorization', () => {
    it('should pass-through when no validator', async () => {
      const scheme = new OpenIdConnectAuthorization({
        openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
      });
      const result = await scheme.authenticate(ctx());
      expect(result.authenticated).toBe(true);
    });

    it('should validate token via custom validator', async () => {
      const validator = vi.fn().mockResolvedValue({
        authenticated: true,
        principal: { sub: 'oidc-user' },
      });
      const scheme = new OpenIdConnectAuthorization({
        openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
        validator,
      });
      const result = await scheme.authenticate(
        ctx({ authorization: 'Bearer oidc-token' }),
      );
      expect(result.authenticated).toBe(true);
      expect(validator).toHaveBeenCalledWith('oidc-token');
    });

    it('should reject missing token when validator is set', async () => {
      const scheme = new OpenIdConnectAuthorization({
        openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
        validator: vi.fn(),
      });
      const result = await scheme.authenticate(ctx());
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Missing Bearer token');
    });
  });

  describe('MutualTlsAuthorization', () => {
    it('should pass-through when no validation config', async () => {
      const scheme = new MutualTlsAuthorization();
      const result = await scheme.authenticate(ctx());
      expect(result.authenticated).toBe(true);
    });

    it('should authenticate with trusted fingerprint', async () => {
      const scheme = new MutualTlsAuthorization({
        trustedFingerprints: ['AA:BB:CC'],
      });
      const result = await scheme.authenticate({
        headers: {},
        clientCertificate: { fingerprint: 'AA:BB:CC' },
      });
      expect(result.authenticated).toBe(true);
    });

    it('should reject untrusted fingerprint', async () => {
      const scheme = new MutualTlsAuthorization({
        trustedFingerprints: ['AA:BB:CC'],
      });
      const result = await scheme.authenticate({
        headers: {},
        clientCertificate: { fingerprint: 'XX:YY:ZZ' },
      });
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('not trusted');
    });

    it('should reject missing certificate', async () => {
      const scheme = new MutualTlsAuthorization({
        trustedFingerprints: ['AA:BB:CC'],
      });
      const result = await scheme.authenticate(ctx());
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Missing client certificate');
    });

    it('should use custom validator', async () => {
      const validator = vi.fn().mockResolvedValue({
        authenticated: true,
        principal: { cn: 'client-1' },
      });
      const scheme = new MutualTlsAuthorization({ validator });
      const result = await scheme.authenticate({
        headers: {},
        clientCertificate: { subject: 'CN=client-1' },
      });
      expect(result.authenticated).toBe(true);
      expect(validator).toHaveBeenCalledWith({ subject: 'CN=client-1' });
    });
  });
});
