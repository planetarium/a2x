import { describe, it, expect, vi } from 'vitest';
import { ApiKeyAuthorization } from '../security/api-key.js';
import { HttpBearerAuthorization } from '../security/http-bearer.js';
import { OAuth2AuthorizationCodeAuthorization } from '../security/oauth2-authorization-code.js';
import { OAuth2ClientCredentialsAuthorization } from '../security/oauth2-client-credentials.js';
import { OAuth2DeviceCodeAuthorization } from '../security/oauth2-device-code.js';
import { OpenIdConnectAuthorization } from '../security/openid-connect.js';
import { MutualTlsAuthorization } from '../security/mutual-tls.js';

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
