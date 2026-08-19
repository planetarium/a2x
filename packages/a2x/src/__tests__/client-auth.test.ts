import { describe, it, expect, vi } from 'vitest';
import { A2XClient } from '../client/a2x-client.js';
import {
  AuthScheme,
  ApiKeyAuthScheme,
  HttpBearerAuthScheme,
  HttpBasicAuthScheme,
  OAuth2DeviceCodeAuthScheme,
  OAuth2AuthorizationCodeAuthScheme,
  OAuth2ClientCredentialsAuthScheme,
  OpenIdConnectAuthScheme,
} from '../client/auth-scheme.js';
import { normalizeScheme, normalizeRequirements } from '../client/auth-normalizer.js';
import type { AuthProvider } from '../client/auth-provider.js';
import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';
import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import { InvalidAgentResponseError } from '../types/errors.js';
import { TaskState } from '../types/task.js';

// ─── Test Fixtures ───

const V10_CARD_WITH_AUTH: AgentCardV10 = {
  name: 'Secure Agent',
  description: 'An agent with auth',
  version: '1.0.0',
  supportedInterfaces: [
    { url: 'http://localhost:4000/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  capabilities: { streaming: true },
  securitySchemes: {
    apiKey: {
      apiKeySecurityScheme: {
        location: 'header',
        name: 'x-api-key',
      },
    },
    deviceCode: {
      oauth2SecurityScheme: {
        flows: {
          deviceCode: {
            deviceAuthorizationUrl: 'http://localhost:4000/device/authorize',
            tokenUrl: 'http://localhost:4000/oauth/token',
            scopes: { 'agent:invoke': 'Invoke the agent' },
          },
        },
      },
    },
  },
  securityRequirements: [
    { schemes: { apiKey: { list: [] } } },
    { schemes: { deviceCode: { list: ['agent:invoke'] } } },
  ],
  skills: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

function createJsonRpcSuccess(result: unknown) {
  return { jsonrpc: '2.0', id: 1, result };
}

function createMockFetch(responseBody: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    json: () => Promise.resolve(responseBody),
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

const TASK_RESULT = {
  id: 'task-1',
  contextId: 'ctx-1',
  status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
  artifacts: [],
  metadata: {},
};

// ═══ AuthScheme Tests ═══

describe('AuthScheme', () => {
  describe('ApiKeyAuthScheme', () => {
    it('applies credential to header', () => {
      const scheme = new ApiKeyAuthScheme('x-api-key', 'header');
      scheme.setCredential('my-secret');

      const ctx = { headers: {} as Record<string, string>, url: new URL('http://example.com') };
      scheme.applyToRequest(ctx);

      expect(ctx.headers['x-api-key']).toBe('my-secret');
    });

    it('applies credential to query param', () => {
      const scheme = new ApiKeyAuthScheme('api_key', 'query');
      scheme.setCredential('my-secret');

      const ctx = { headers: {} as Record<string, string>, url: new URL('http://example.com/path') };
      scheme.applyToRequest(ctx);

      expect(ctx.url.searchParams.get('api_key')).toBe('my-secret');
    });

    it('applies credential to cookie', () => {
      const scheme = new ApiKeyAuthScheme('session', 'cookie');
      scheme.setCredential('abc123');

      const ctx = { headers: {} as Record<string, string>, url: new URL('http://example.com') };
      scheme.applyToRequest(ctx);

      expect(ctx.headers['Cookie']).toBe('session=abc123');
    });

    it('replaces the same cookie name while preserving unrelated cookies', () => {
      const scheme = new ApiKeyAuthScheme('session', 'cookie');
      scheme.setCredential('fresh');
      const ctx = {
        headers: { cookie: 'session=stale; other=ok' } as Record<string, string>,
        url: new URL('http://example.com'),
      };

      scheme.applyToRequest(ctx);

      expect(ctx.headers.Cookie).toBe('other=ok; session=fresh');
      expect(ctx.headers.cookie).toBeUndefined();
    });

    it('coalesces every case-insensitive Cookie header variant', () => {
      const scheme = new ApiKeyAuthScheme('session', 'cookie');
      scheme.setCredential('fresh');
      const ctx = {
        headers: {
          Cookie: '; session=stale; first=one;',
          cookie: 'second=two',
          COOKIE: ';; session =older; third=three',
        } as Record<string, string>,
        url: new URL('http://example.com'),
      };

      scheme.applyToRequest(ctx);

      expect(ctx.headers).toEqual({
        Cookie: 'first=one; second=two; third=three; session=fresh',
      });
    });

    it('returns params', () => {
      const scheme = new ApiKeyAuthScheme('x-api-key', 'header');
      expect(scheme.params).toEqual({ name: 'x-api-key', location: 'header' });
    });

    it('setCredential returns this (fluent)', () => {
      const scheme = new ApiKeyAuthScheme('x-api-key', 'header');
      const result = scheme.setCredential('secret');
      expect(result).toBe(scheme);
    });
  });

  describe('HttpBearerAuthScheme', () => {
    it('applies Bearer token to Authorization header', () => {
      const scheme = new HttpBearerAuthScheme('JWT');
      scheme.setCredential('eyJhbG...');

      const ctx = { headers: {} as Record<string, string>, url: new URL('http://example.com') };
      scheme.applyToRequest(ctx);

      expect(ctx.headers['Authorization']).toBe('Bearer eyJhbG...');
    });

    it('returns params', () => {
      const scheme = new HttpBearerAuthScheme('JWT');
      expect(scheme.params).toEqual({ bearerFormat: 'JWT' });
    });
  });

  describe('HttpBasicAuthScheme', () => {
    it('applies Basic credentials to Authorization header', () => {
      const scheme = new HttpBasicAuthScheme();
      scheme.setCredential('dXNlcjpwYXNz');

      const ctx = { headers: {} as Record<string, string>, url: new URL('http://example.com') };
      scheme.applyToRequest(ctx);

      expect(ctx.headers['Authorization']).toBe('Basic dXNlcjpwYXNz');
    });
  });

  describe('OAuth2DeviceCodeAuthScheme', () => {
    it('applies Bearer token to Authorization header', () => {
      const scheme = new OAuth2DeviceCodeAuthScheme(
        'http://auth/device',
        'http://auth/token',
        { read: 'Read access' },
      );
      scheme.setCredential('access-token');

      const ctx = { headers: {} as Record<string, string>, url: new URL('http://example.com') };
      scheme.applyToRequest(ctx);

      expect(ctx.headers['Authorization']).toBe('Bearer access-token');
    });

    it('returns params with flow details', () => {
      const scheme = new OAuth2DeviceCodeAuthScheme(
        'http://auth/device',
        'http://auth/token',
        { read: 'Read access' },
        'http://auth/refresh',
      );
      expect(scheme.params).toEqual({
        deviceAuthorizationUrl: 'http://auth/device',
        tokenUrl: 'http://auth/token',
        scopes: { read: 'Read access' },
        refreshUrl: 'http://auth/refresh',
      });
    });
  });

  describe('OAuth2AuthorizationCodeAuthScheme', () => {
    it('returns params with pkceRequired', () => {
      const scheme = new OAuth2AuthorizationCodeAuthScheme(
        'http://auth/authorize',
        'http://auth/token',
        {},
        undefined,
        true,
      );
      expect(scheme.params.pkceRequired).toBe(true);
    });
  });

  describe('OpenIdConnectAuthScheme', () => {
    it('applies Bearer token and returns params', () => {
      const scheme = new OpenIdConnectAuthScheme('http://auth/.well-known/openid');
      scheme.setCredential('oidc-token');

      const ctx = { headers: {} as Record<string, string>, url: new URL('http://example.com') };
      scheme.applyToRequest(ctx);

      expect(ctx.headers['Authorization']).toBe('Bearer oidc-token');
      expect(scheme.params).toEqual({ openIdConnectUrl: 'http://auth/.well-known/openid' });
    });
  });
});

// ═══ Normalizer Tests ═══

describe('normalizeScheme', () => {
  describe('v0.3 schemes', () => {
    it('normalizes apiKey scheme', () => {
      const raw: SecuritySchemeV03 = { type: 'apiKey', in: 'header', name: 'x-api-key' };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(ApiKeyAuthScheme);
      expect((result[0] as ApiKeyAuthScheme).params).toEqual({ name: 'x-api-key', location: 'header' });
    });

    it('normalizes http bearer scheme', () => {
      const raw: SecuritySchemeV03 = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(HttpBearerAuthScheme);
    });

    it('normalizes http basic scheme', () => {
      const raw: SecuritySchemeV03 = { type: 'http', scheme: 'basic' };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(HttpBasicAuthScheme);
    });

    it('normalizes oauth2 with multiple flows into multiple schemes', () => {
      const raw: SecuritySchemeV03 = {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'http://auth/authorize',
            tokenUrl: 'http://auth/token',
            scopes: { read: 'Read' },
          },
          clientCredentials: {
            tokenUrl: 'http://auth/token',
            scopes: { read: 'Read' },
          },
        },
      };
      const requiredScopes = ['read'];
      const result = normalizeScheme(raw, requiredScopes);

      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(OAuth2AuthorizationCodeAuthScheme);
      expect(result[1]).toBeInstanceOf(OAuth2ClientCredentialsAuthScheme);
      expect(
        (result[0] as OAuth2AuthorizationCodeAuthScheme).params.requiredScopes,
      ).toEqual(['read']);
      expect(
        (result[1] as OAuth2ClientCredentialsAuthScheme).params.requiredScopes,
      ).toEqual(['read']);
      requiredScopes.push('write');
      expect(
        (result[0] as OAuth2AuthorizationCodeAuthScheme).params.requiredScopes,
      ).toEqual(['read']);
      expect(Object.isFrozen(
        (result[0] as OAuth2AuthorizationCodeAuthScheme).params.requiredScopes,
      )).toBe(true);
    });

    it('normalizes oauth2 deviceCode flow as non-standard v0.3 extension', () => {
      const raw: SecuritySchemeV03 = {
        type: 'oauth2',
        flows: {
          deviceCode: {
            deviceAuthorizationUrl: 'http://auth/device',
            tokenUrl: 'http://auth/token',
            scopes: { 'agent:invoke': 'Invoke' },
            refreshUrl: 'http://auth/refresh',
          },
        },
      };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(OAuth2DeviceCodeAuthScheme);
      expect((result[0] as OAuth2DeviceCodeAuthScheme).params).toEqual({
        deviceAuthorizationUrl: 'http://auth/device',
        tokenUrl: 'http://auth/token',
        scopes: { 'agent:invoke': 'Invoke' },
        refreshUrl: 'http://auth/refresh',
      });
    });

    it('normalizes oauth2 with deviceCode alongside a standard flow', () => {
      const raw: SecuritySchemeV03 = {
        type: 'oauth2',
        flows: {
          deviceCode: {
            deviceAuthorizationUrl: 'http://auth/device',
            tokenUrl: 'http://auth/token',
            scopes: {},
          },
          authorizationCode: {
            authorizationUrl: 'http://auth/authorize',
            tokenUrl: 'http://auth/token',
            scopes: {},
          },
        },
      };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(OAuth2DeviceCodeAuthScheme);
      expect(result[1]).toBeInstanceOf(OAuth2AuthorizationCodeAuthScheme);
    });

    it('normalizes openIdConnect scheme', () => {
      const raw: SecuritySchemeV03 = { type: 'openIdConnect', openIdConnectUrl: 'http://auth/.well-known' };
      const result = normalizeScheme(raw, ['openid']);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(OpenIdConnectAuthScheme);
      expect((result[0] as OpenIdConnectAuthScheme).params.requiredScopes)
        .toEqual(['openid']);
    });

    it('returns empty for mutualTLS', () => {
      const raw: SecuritySchemeV03 = { type: 'mutualTLS' };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(0);
    });
  });

  describe('v1.0 schemes', () => {
    it('normalizes apiKeySecurityScheme', () => {
      const raw: SecuritySchemeV10 = {
        apiKeySecurityScheme: { location: 'header', name: 'x-api-key' },
      };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(ApiKeyAuthScheme);
    });

    it('normalizes httpAuthSecurityScheme bearer', () => {
      const raw: SecuritySchemeV10 = {
        httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'JWT' },
      };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(HttpBearerAuthScheme);
    });

    it('normalizes oauth2SecurityScheme with deviceCode flow', () => {
      const raw: SecuritySchemeV10 = {
        oauth2SecurityScheme: {
          flows: {
            deviceCode: {
              deviceAuthorizationUrl: 'http://auth/device',
              tokenUrl: 'http://auth/token',
              scopes: { invoke: 'Invoke' },
            },
          },
        },
      };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(OAuth2DeviceCodeAuthScheme);
      expect((result[0] as OAuth2DeviceCodeAuthScheme).params.deviceAuthorizationUrl).toBe('http://auth/device');
    });

    it('distinguishes an empty required scope list from an absent one', () => {
      const raw: SecuritySchemeV10 = {
        oauth2SecurityScheme: {
          flows: {
            deviceCode: {
              deviceAuthorizationUrl: 'http://auth/device',
              tokenUrl: 'http://auth/token',
              scopes: { invoke: 'Invoke' },
            },
          },
        },
      };

      const withEmpty = normalizeScheme(raw, [])[0] as OAuth2DeviceCodeAuthScheme;
      const withoutRequirement = normalizeScheme(raw)[0] as OAuth2DeviceCodeAuthScheme;

      expect(withEmpty.params.requiredScopes).toEqual([]);
      expect(withoutRequirement.params.requiredScopes).toBeUndefined();
    });

    it('normalizes oauth2SecurityScheme with multiple flows', () => {
      const raw: SecuritySchemeV10 = {
        oauth2SecurityScheme: {
          flows: {
            deviceCode: {
              deviceAuthorizationUrl: 'http://auth/device',
              tokenUrl: 'http://auth/token',
              scopes: {},
            },
            authorizationCode: {
              authorizationUrl: 'http://auth/authorize',
              tokenUrl: 'http://auth/token',
              scopes: {},
            },
          },
        },
      };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(OAuth2DeviceCodeAuthScheme);
      expect(result[1]).toBeInstanceOf(OAuth2AuthorizationCodeAuthScheme);
    });

    it('normalizes openIdConnectSecurityScheme', () => {
      const raw: SecuritySchemeV10 = {
        openIdConnectSecurityScheme: { openIdConnectUrl: 'http://auth/.well-known' },
      };
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(OpenIdConnectAuthScheme);
    });
  });
});

describe('normalizeRequirements', () => {
  const schemes: Record<string, SecuritySchemeV10> = {
    apiKey: {
      apiKeySecurityScheme: { location: 'header', name: 'x-api-key' },
    },
    mfa: {
      httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'TOTP' },
    },
    oauth: {
      oauth2SecurityScheme: {
        flows: {
          deviceCode: {
            deviceAuthorizationUrl: 'http://auth/device',
            tokenUrl: 'http://auth/token',
            scopes: {
              invoke: 'Invoke the agent',
              admin: 'Administer the agent',
            },
          },
          authorizationCode: {
            authorizationUrl: 'http://auth/authorize',
            tokenUrl: 'http://auth/token',
            scopes: {
              invoke: 'Invoke the agent',
              admin: 'Administer the agent',
            },
          },
        },
      },
    },
    oidc: {
      openIdConnectSecurityScheme: {
        openIdConnectUrl: 'http://auth/.well-known/openid-configuration',
      },
    },
  };

  it('creates separate OR groups for each requirement', () => {
    const requirements = [{ apiKey: [] as string[] }, { mfa: [] as string[] }];
    const result = normalizeRequirements(requirements, schemes);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0]).toBeInstanceOf(ApiKeyAuthScheme);
    expect(result[1]).toHaveLength(1);
    expect(result[1][0]).toBeInstanceOf(HttpBearerAuthScheme);
  });

  it('creates AND group for multi-scheme requirement', () => {
    const requirements = [{ apiKey: [] as string[], mfa: [] as string[] }];
    const result = normalizeRequirements(requirements, schemes);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
    expect(result[0][0]).toBeInstanceOf(ApiKeyAuthScheme);
    expect(result[0][1]).toBeInstanceOf(HttpBearerAuthScheme);
  });

  it('expands OAuth2 multi-flow into separate OR groups', () => {
    const requirements = [{ oauth: ['invoke'] as string[] }];
    const result = normalizeRequirements(requirements, schemes);

    // oauth has 2 flows → 2 OR groups
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0]).toBeInstanceOf(OAuth2DeviceCodeAuthScheme);
    expect(result[1]).toHaveLength(1);
    expect(result[1][0]).toBeInstanceOf(OAuth2AuthorizationCodeAuthScheme);
    expect(
      (result[0][0] as OAuth2DeviceCodeAuthScheme).params.requiredScopes,
    ).toEqual(['invoke']);
    expect(
      (result[1][0] as OAuth2AuthorizationCodeAuthScheme).params.requiredScopes,
    ).toEqual(['invoke']);
  });

  it('combines AND schemes with OAuth2 flow expansion', () => {
    const requirements = [{ apiKey: [] as string[], oauth: ['invoke'] as string[] }];
    const result = normalizeRequirements(requirements, schemes);

    // apiKey (AND) + oauth with 2 flows → 2 OR groups, each with apiKey + one flow
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(2);
    expect(result[0][0]).toBeInstanceOf(ApiKeyAuthScheme);
    expect(result[0][1]).toBeInstanceOf(OAuth2DeviceCodeAuthScheme);
    expect(result[1]).toHaveLength(2);
    expect(result[1][0]).toBeInstanceOf(ApiKeyAuthScheme);
    expect(result[1][1]).toBeInstanceOf(OAuth2AuthorizationCodeAuthScheme);
  });

  it('rejects a non-empty requirement containing an unknown scheme', () => {
    const requirements = [{ unknown: [] as string[] }];
    const result = normalizeRequirements(requirements, schemes);

    expect(result).toEqual([]);
  });

  it('rejects an entire AND requirement when one scheme is unsupported', () => {
    const requirements = [{ apiKey: [] as string[], unknown: [] as string[] }];
    const result = normalizeRequirements(requirements, schemes);

    expect(result).toEqual([]);
  });

  it('preserves an explicitly empty anonymous requirement', () => {
    const result = normalizeRequirements([{}], schemes);

    expect(result).toEqual([[]]);
  });

  it('rejects an AND group whose schemes overwrite one Authorization header', () => {
    const result = normalizeRequirements(
      [{ bearer: [], oidc: ['openid'] }],
      {
        bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } },
        oidc: schemes.oidc!,
      },
    );

    expect(result).toEqual([]);
  });

  it('rejects a Cookie header API key combined with cookie API keys', () => {
    const result = normalizeRequirements(
      [{ wholeCookieHeader: [], sessionCookie: [] }],
      {
        wholeCookieHeader: {
          apiKeySecurityScheme: { location: 'header', name: 'Cookie' },
        },
        sessionCookie: {
          apiKeySecurityScheme: { location: 'cookie', name: 'session' },
        },
      },
    );

    expect(result).toEqual([]);
  });

  it('rejects duplicate header destinations case-insensitively', () => {
    const result = normalizeRequirements(
      [{ first: [], second: [] }],
      {
        first: {
          apiKeySecurityScheme: { location: 'header', name: 'X-API-Key' },
        },
        second: {
          apiKeySecurityScheme: { location: 'header', name: 'x-api-key' },
        },
      },
    );

    expect(result).toEqual([]);
  });

  it('rejects duplicate query destinations', () => {
    const result = normalizeRequirements(
      [{ first: [], second: [] }],
      {
        first: {
          apiKeySecurityScheme: { location: 'query', name: 'api_key' },
        },
        second: {
          apiKeySecurityScheme: { location: 'query', name: 'api_key' },
        },
      },
    );

    expect(result).toEqual([]);
  });

  it('rejects duplicate cookie names', () => {
    const result = normalizeRequirements(
      [{ first: [], second: [] }],
      {
        first: {
          apiKeySecurityScheme: { location: 'cookie', name: 'session' },
        },
        second: {
          apiKeySecurityScheme: { location: 'cookie', name: 'session' },
        },
      },
    );

    expect(result).toEqual([]);
  });

  it('allows a cookie literally named * alongside a distinct cookie', () => {
    const result = normalizeRequirements(
      [{ star: [], session: [] }],
      {
        star: { apiKeySecurityScheme: { location: 'cookie', name: '*' } },
        session: {
          apiKeySecurityScheme: { location: 'cookie', name: 'session' },
        },
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
  });

  it('rejects multi-OAuth AND groups that collide on Authorization', () => {
    const result = normalizeRequirements(
      [{ oauth: ['invoke'], secondOAuth: ['invoke'] }],
      { ...schemes, secondOAuth: schemes.oauth! },
    );

    expect(result).toEqual([]);
  });

  it('bounds OAuth flow expansion from an untrusted AgentCard', () => {
    const requirement: Record<string, string[]> = {};
    const manySchemes: Record<string, SecuritySchemeV10> = {};
    for (let index = 0; index < 9; index++) {
      const name = `oauth${index}`;
      requirement[name] = ['invoke'];
      manySchemes[name] = schemes.oauth!;
    }

    expect(() => normalizeRequirements([requirement], manySchemes))
      .toThrow(InvalidAgentResponseError);
    expect(() => normalizeRequirements([requirement], manySchemes))
      .toThrow('more than 256 authentication alternatives');
  });

  it('preserves requirement-specific OpenID Connect scopes', () => {
    const result = normalizeRequirements([{ oidc: ['openid', 'profile'] }], schemes);

    expect(result).toHaveLength(1);
    expect(result[0]![0]).toBeInstanceOf(OpenIdConnectAuthScheme);
    expect((result[0]![0] as OpenIdConnectAuthScheme).params.requiredScopes)
      .toEqual(['openid', 'profile']);
  });

  it('keeps different scope sets on separate alternatives', () => {
    const result = normalizeRequirements(
      [{ oauth: ['invoke'] }, { oauth: ['admin'] }],
      schemes,
    );

    expect(result).toHaveLength(4);
    expect(result.slice(0, 2).map((group) =>
      (group[0] as OAuth2DeviceCodeAuthScheme).params.requiredScopes,
    )).toEqual([['invoke'], ['invoke']]);
    expect(result.slice(2).map((group) =>
      (group[0] as OAuth2DeviceCodeAuthScheme).params.requiredScopes,
    )).toEqual([['admin'], ['admin']]);
  });

  it('returns empty for empty requirements', () => {
    const result = normalizeRequirements([], schemes);
    expect(result).toHaveLength(0);
  });
});

// ═══ A2XClient Auth Integration Tests ═══

describe('A2XClient auth integration', () => {
  it('accepts the legacy a2x values spelling for v1.0 requirement scopes', async () => {
    const legacyCard: AgentCardV10 = {
      ...V10_CARD_WITH_AUTH,
      securityRequirements: [
        { schemes: { deviceCode: { values: ['agent:invoke'] } } },
      ],
    };
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const provide = vi.fn(async (requirements: AuthScheme[][]) => {
      const scheme = requirements[0]![0] as OAuth2DeviceCodeAuthScheme;
      expect(scheme.params.requiredScopes).toEqual(['agent:invoke']);
      return [scheme.setCredential('legacy-compatible-token')];
    });
    const client = new A2XClient(legacyCard, {
      fetch: mockFetch,
      authProvider: { provide },
    });

    await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    expect(provide).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![1].headers.Authorization)
      .toBe('Bearer legacy-compatible-token');
  });

  it.each([
    ['canonical list', { list: 'agent:invoke' }],
    ['legacy values', { values: ['agent:invoke', 42] }],
  ])('rejects malformed %s requirement scopes before transport', async (_label, wrapper) => {
    const malformedCard = {
      ...V10_CARD_WITH_AUTH,
      securityRequirements: [{ schemes: { deviceCode: wrapper } }],
    } as unknown as AgentCardV10;
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const provide = vi.fn();
    const client = new A2XClient(malformedCard, {
      fetch: mockFetch,
      authProvider: { provide },
    });

    await expect(client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    })).rejects.toThrow('must contain an array of strings');
    expect(provide).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects v1 requirement scheme arrays before transport', async () => {
    const malformedCard = {
      ...V10_CARD_WITH_AUTH,
      securityRequirements: [{ schemes: [] }],
    } as unknown as AgentCardV10;
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const provide = vi.fn();
    const client = new A2XClient(malformedCard, {
      fetch: mockFetch,
      authProvider: { provide },
    });

    await expect(client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    })).rejects.toThrow('requirement schemes must be an object');
    expect(provide).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects malformed v0.3 requirement scopes before transport', async () => {
    const malformedCard = {
      name: 'Malformed v0.3 Agent',
      description: 'An agent with malformed auth requirements',
      version: '1.0.0',
      url: 'http://localhost:4000/a2a',
      protocolVersion: '0.3.0',
      capabilities: {},
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
      security: [{ apiKey: 'openid' }],
      skills: [],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
    } as unknown as AgentCardV03;
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const provide = vi.fn();
    const client = new A2XClient(malformedCard, {
      fetch: mockFetch,
      authProvider: { provide },
    });

    await expect(client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    })).rejects.toThrow('must contain an array of strings');
    expect(provide).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls authProvider.provide() and applies credentials', async () => {
    const mockFetch = createMockFetch(
      createJsonRpcSuccess(TASK_RESULT),
    );

    const authProvider: AuthProvider = {
      async provide(requirements) {
        // Find apiKey group and resolve it
        for (const group of requirements) {
          if (group[0] instanceof ApiKeyAuthScheme) {
            return [group[0].setCredential('my-secret-key')];
          }
        }
        throw new Error('No supported scheme');
      },
    };

    const client = new A2XClient(V10_CARD_WITH_AUTH, {
      fetch: mockFetch,
      authProvider,
    });

    await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    // Verify fetch was called with the auth header
    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers['x-api-key']).toBe('my-secret-key');
  });

  it('replaces case-variant custom API-key headers with the resolved credential', async () => {
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const client = new A2XClient(V10_CARD_WITH_AUTH, {
      fetch: mockFetch,
      headers: { 'X-API-KEY': 'caller-value' },
      authProvider: {
        async provide(requirements) {
          const group = requirements.find(
            (candidate) => candidate[0] instanceof ApiKeyAuthScheme,
          )!;
          group[0]!.setCredential('provider-value');
          return group;
        },
      },
    });

    await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('provider-value');
    expect(
      Object.keys(headers).filter((name) => name.toLowerCase() === 'x-api-key'),
    ).toEqual(['x-api-key']);
  });

  it('replaces a lowercase authorization header with bearer auth', async () => {
    const bearerCard: AgentCardV10 = {
      ...V10_CARD_WITH_AUTH,
      securitySchemes: {
        bearer: {
          httpAuthSecurityScheme: { scheme: 'bearer' },
        },
      },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    };
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const client = new A2XClient(bearerCard, {
      fetch: mockFetch,
      headers: { authorization: 'Bearer caller-value' },
      authProvider: {
        async provide(requirements) {
          requirements[0]![0]!.setCredential('provider-value');
          return requirements[0]!;
        },
      },
    });

    await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer provider-value');
    expect(headers.authorization).toBeUndefined();
  });

  it('composes distinct cookie API-key schemes in one AND group', async () => {
    const cookieCard: AgentCardV10 = {
      ...V10_CARD_WITH_AUTH,
      securitySchemes: {
        session: {
          apiKeySecurityScheme: { location: 'cookie', name: 'session' },
        },
        tenant: {
          apiKeySecurityScheme: { location: 'cookie', name: 'tenant' },
        },
      },
      securityRequirements: [{
        schemes: {
          session: { list: [] },
          tenant: { list: [] },
        },
      }],
    };
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const client = new A2XClient(cookieCard, {
      fetch: mockFetch,
      headers: { cookie: 'caller=present' },
      authProvider: {
        async provide(requirements) {
          requirements[0]![0]!.setCredential('one');
          requirements[0]![1]!.setCredential('two');
          return requirements[0]!;
        },
      },
    });

    await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.Cookie).toBe('caller=present; session=one; tenant=two');
    expect(headers.cookie).toBeUndefined();
  });

  it('preserves the built request context for custom auth schemes', async () => {
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const client = new A2XClient(V10_CARD_WITH_AUTH, {
      fetch: mockFetch,
      headers: { Cookie: 'session=caller' },
      authProvider: {
        async provide(requirements) {
          const group = requirements.find(
            (candidate) => candidate[0] instanceof ApiKeyAuthScheme,
          )!;
          group[0]!.applyToRequest = (ctx) => {
            ctx.headers['X-Context-Signature'] = [
              ctx.headers['Content-Type'],
              ctx.headers.Cookie,
              ctx.url.pathname,
            ].join('|');
            ctx.headers.Cookie = `${ctx.headers.Cookie}; auth=provider`;
          };
          return group;
        },
      },
    });

    await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['X-Context-Signature']).toBe(
      'application/json|session=caller|/a2a',
    );
    expect(headers.Cookie).toBe('session=caller; auth=provider');
  });

  it('does not call authProvider when no security requirements', async () => {
    const cardWithoutAuth: AgentCardV10 = {
      ...V10_CARD_WITH_AUTH,
      securitySchemes: undefined,
      securityRequirements: undefined,
    };

    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const provide = vi.fn();

    const client = new A2XClient(cardWithoutAuth, {
      fetch: mockFetch,
      authProvider: { provide },
    });

    await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    expect(provide).not.toHaveBeenCalled();
  });

  it('does not call authProvider when anonymous access is an explicit alternative', async () => {
    const anonymousCard: AgentCardV10 = {
      ...V10_CARD_WITH_AUTH,
      securityRequirements: [
        { schemes: { apiKey: { list: [] } } },
        { schemes: {} },
      ],
    };
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const provide = vi.fn();
    const client = new A2XClient(anonymousCard, {
      fetch: mockFetch,
      authProvider: { provide },
    });

    await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    expect(provide).not.toHaveBeenCalled();
    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('fails before sending when every non-empty auth requirement is unsupported', async () => {
    const unsupportedCard: AgentCardV10 = {
      ...V10_CARD_WITH_AUTH,
      securitySchemes: {
        mtls: { mtlsSecurityScheme: {} },
      },
      securityRequirements: [{ schemes: { mtls: { list: [] } } }],
    };
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const provide = vi.fn();
    const client = new A2XClient(unsupportedCard, {
      fetch: mockFetch,
      authProvider: { provide },
    });

    await expect(
      client.sendMessage({
        message: { role: 'user', parts: [{ text: 'Hello' }] },
      }),
    ).rejects.toThrow('none of its security requirements are supported');
    expect(provide).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('works without authProvider (public agents)', async () => {
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));

    const client = new A2XClient(V10_CARD_WITH_AUTH, {
      fetch: mockFetch,
    });

    // No authProvider → no auth applied, request goes through
    await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['Authorization']).toBeUndefined();
  });

  it('calls refresh and retries when first response is auth-required', async () => {
    // Spec a2a-v0.3 / v1.0: an auth failure surfaces as a Task whose
    // status.state === 'auth-required'. The client refreshes credentials
    // once and re-sends the same request.
    const authRequiredTask = {
      id: 'task-auth',
      contextId: 'ctx-auth',
      status: { state: TaskState.AUTH_REQUIRED, timestamp: new Date().toISOString() },
    };
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      const body = callCount === 1
        ? createJsonRpcSuccess(authRequiredTask)
        : createJsonRpcSuccess(TASK_RESULT);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(body),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    });

    const authProvider: AuthProvider = {
      async provide(requirements) {
        for (const group of requirements) {
          if (group[0] instanceof ApiKeyAuthScheme) {
            return [group[0].setCredential('old-key')];
          }
        }
        throw new Error('No supported scheme');
      },
      async refresh(schemes) {
        for (const scheme of schemes) {
          if (scheme instanceof ApiKeyAuthScheme) {
            scheme.setCredential('new-key');
          }
        }
        return schemes;
      },
    };

    const client = new A2XClient(V10_CARD_WITH_AUTH, {
      fetch: mockFetch,
      authProvider,
    });

    await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondCallHeaders = mockFetch.mock.calls[1][1].headers;
    expect(secondCallHeaders['x-api-key']).toBe('new-key');
  });

  it('returns the auth-required task when refresh is unsupported', async () => {
    const authRequiredTask = {
      id: 'task-auth',
      contextId: 'ctx-auth',
      status: { state: TaskState.AUTH_REQUIRED, timestamp: new Date().toISOString() },
    };
    const mockFetch = createMockFetch(createJsonRpcSuccess(authRequiredTask));

    const authProvider: AuthProvider = {
      async provide(requirements) {
        return [requirements[0][0].setCredential('key')];
      },
      // No refresh() — caller is expected to inspect the task state.
    };

    const client = new A2XClient(V10_CARD_WITH_AUTH, {
      fetch: mockFetch,
      authProvider,
    });

    const task = await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    expect(task.status.state).toBe(TaskState.AUTH_REQUIRED);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('propagates authProvider.provide() errors', async () => {
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));

    const authProvider: AuthProvider = {
      async provide() {
        throw new Error('No supported auth scheme');
      },
    };

    const client = new A2XClient(V10_CARD_WITH_AUTH, {
      fetch: mockFetch,
      authProvider,
    });

    await expect(
      client.sendMessage({
        message: { role: 'user', parts: [{ text: 'Hello' }] },
      }),
    ).rejects.toThrow('No supported auth scheme');

    // fetch should not have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('caches resolved schemes across multiple requests', async () => {
    const mockFetch = createMockFetch(createJsonRpcSuccess(TASK_RESULT));
    const provide = vi.fn().mockImplementation(async (requirements: AuthScheme[][]) => {
      return [requirements[0][0].setCredential('cached-key')];
    });

    const client = new A2XClient(V10_CARD_WITH_AUTH, {
      fetch: mockFetch,
      authProvider: { provide },
    });

    await client.sendMessage({ message: { role: 'user', parts: [{ text: '1' }] } });
    await client.sendMessage({ message: { role: 'user', parts: [{ text: '2' }] } });

    // provide() should only be called once
    expect(provide).toHaveBeenCalledTimes(1);
    // Both requests should have the auth header
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

});
