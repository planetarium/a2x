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
import type { AgentCardV10 } from '../types/agent-card.js';
import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import { TaskState } from '../types/task.js';
import { A2A_ERROR_CODES, AuthenticationRequiredError } from '../types/errors.js';

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
    { apiKey: [] },
    { deviceCode: ['agent:invoke'] },
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
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(OAuth2AuthorizationCodeAuthScheme);
      expect(result[1]).toBeInstanceOf(OAuth2ClientCredentialsAuthScheme);
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
      const result = normalizeScheme(raw);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(OpenIdConnectAuthScheme);
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
            scopes: {},
          },
          authorizationCode: {
            authorizationUrl: 'http://auth/authorize',
            tokenUrl: 'http://auth/token',
            scopes: {},
          },
        },
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

  it('skips unknown scheme names', () => {
    const requirements = [{ unknown: [] as string[] }];
    const result = normalizeRequirements(requirements, schemes);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(0);
  });

  it('returns empty for empty requirements', () => {
    const result = normalizeRequirements([], schemes);
    expect(result).toHaveLength(0);
  });
});

// ═══ A2XClient Auth Integration Tests ═══

describe('A2XClient auth integration', () => {
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

  it('calls refresh on 401 and retries', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: 401
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () => Promise.resolve({}),
          headers: new Headers(),
        });
      }
      // Second call: success
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(createJsonRpcSuccess(TASK_RESULT)),
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
        // Replace with new credential
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
    // Second call should have the new key
    const secondCallHeaders = mockFetch.mock.calls[1][1].headers;
    expect(secondCallHeaders['x-api-key']).toBe('new-key');
  });

  it('does not retry more than once on 401', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({}),
      headers: new Headers(),
    });

    const authProvider: AuthProvider = {
      async provide(requirements) {
        return [requirements[0][0].setCredential('key')];
      },
      async refresh(schemes) {
        return schemes;
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
    ).rejects.toThrow('HTTP 401');

    // Once for initial, once for retry — no more
    expect(mockFetch).toHaveBeenCalledTimes(2);
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

  it('maps AUTHENTICATION_REQUIRED error code correctly', async () => {
    const mockFetch = createMockFetch(
      { jsonrpc: '2.0', id: 1, error: { code: -32008, message: 'Auth required' } },
    );

    const client = new A2XClient(V10_CARD_WITH_AUTH, { fetch: mockFetch });

    await expect(
      client.sendMessage({
        message: { role: 'user', parts: [{ text: 'Hello' }] },
      }),
    ).rejects.toThrow('Auth required');
  });

  it('JSON-RPC -32008 fallback triggers refresh and retries successfully', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: HTTP 200 but JSON-RPC auth error
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({
              jsonrpc: '2.0',
              id: 1,
              error: {
                code: A2A_ERROR_CODES.AUTHENTICATION_REQUIRED,
                message: 'Token expired',
              },
            }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Second call: success
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(createJsonRpcSuccess(TASK_RESULT)),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    });

    const refresh = vi.fn().mockImplementation(async (schemes: AuthScheme[]) => {
      for (const scheme of schemes) {
        if (scheme instanceof ApiKeyAuthScheme) {
          scheme.setCredential('refreshed-key');
        }
      }
      return schemes;
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
      refresh,
    };

    const client = new A2XClient(V10_CARD_WITH_AUTH, {
      fetch: mockFetch,
      authProvider,
    });

    const result = await client.sendMessage({
      message: { role: 'user', parts: [{ text: 'Hello' }] },
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.id).toBe(TASK_RESULT.id);
    // Second call should have the refreshed key
    const secondCallHeaders = mockFetch.mock.calls[1][1].headers;
    expect(secondCallHeaders['x-api-key']).toBe('refreshed-key');
  });

  it('JSON-RPC -32008 fallback does not retry more than once', async () => {
    const mockFetch = vi.fn().mockImplementation(() => {
      // Always return HTTP 200 with JSON-RPC auth error
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: A2A_ERROR_CODES.AUTHENTICATION_REQUIRED,
              message: 'Still expired',
            },
          }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    });

    const refresh = vi.fn().mockImplementation(async (schemes: AuthScheme[]) => {
      return schemes;
    });

    const authProvider: AuthProvider = {
      async provide(requirements) {
        return [requirements[0][0].setCredential('key')];
      },
      refresh,
    };

    const client = new A2XClient(V10_CARD_WITH_AUTH, {
      fetch: mockFetch,
      authProvider,
    });

    await expect(
      client.sendMessage({
        message: { role: 'user', parts: [{ text: 'Hello' }] },
      }),
    ).rejects.toThrow(AuthenticationRequiredError);

    // Once for initial, once for retry — no more
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
