/**
 * Normalizes agent card security schemes/requirements into AuthScheme[][].
 *
 * Handles v0.3 and v1.0 format differences. OAuth2 schemes with multiple
 * flows are expanded into separate OR groups.
 */

import type {
  SecuritySchemeV03,
  SecuritySchemeV10,
  SecurityRequirement,
} from '../types/security.js';
import { InvalidAgentResponseError } from '../types/errors.js';
import {
  AuthScheme,
  ApiKeyAuthScheme,
  HttpBearerAuthScheme,
  HttpBasicAuthScheme,
  OAuth2DeviceCodeAuthScheme,
  OAuth2AuthorizationCodeAuthScheme,
  OAuth2ClientCredentialsAuthScheme,
  OAuth2ImplicitAuthScheme,
  OAuth2PasswordAuthScheme,
  OpenIdConnectAuthScheme,
} from './auth-scheme.js';

/** Bound eager OAuth-flow expansion from an untrusted AgentCard. */
const MAX_NORMALIZED_AUTH_GROUPS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidSecurityScheme(message: string): never {
  throw new InvalidAgentResponseError(`Invalid AgentCard security scheme: ${message}`);
}

function assertOAuthFlows(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalidSecurityScheme('OAuth2 flows must be an object.');
}

function assertOAuthFlow(
  value: unknown,
  name: string,
  requiredUrls: readonly string[],
  supportsPkce = false,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    invalidSecurityScheme(`OAuth2 ${name} flow must be an object.`);
  }
  for (const field of requiredUrls) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      invalidSecurityScheme(
        `OAuth2 ${name} flow requires a non-empty ${field} string.`,
      );
    }
  }
  if (
    value.scopes !== undefined &&
    (!isRecord(value.scopes) ||
      !Object.values(value.scopes).every((entry) => typeof entry === 'string'))
  ) {
    invalidSecurityScheme(`OAuth2 ${name} flow scopes must be a string map.`);
  }
  if (value.refreshUrl !== undefined && typeof value.refreshUrl !== 'string') {
    invalidSecurityScheme(`OAuth2 ${name} flow refreshUrl must be a string.`);
  }
  if (
    supportsPkce &&
    value.pkceRequired !== undefined &&
    typeof value.pkceRequired !== 'boolean'
  ) {
    invalidSecurityScheme(
      `OAuth2 ${name} flow pkceRequired must be a boolean.`,
    );
  }
}

type AuthDestination =
  | { kind: 'cookie'; name: string }
  | { kind: 'cookie-header' }
  | { kind: 'slot'; key: string };

function authDestination(scheme: AuthScheme): AuthDestination {
  if (scheme instanceof ApiKeyAuthScheme) {
    const name = scheme.params.location === 'header'
      ? scheme.params.name.toLowerCase()
      : scheme.params.name;
    if (scheme.params.location === 'header' && name === 'cookie') {
      return { kind: 'cookie-header' };
    }
    if (scheme.params.location === 'cookie') {
      return { kind: 'cookie', name };
    }
    return { kind: 'slot', key: `${scheme.params.location}:${name}` };
  }
  return { kind: 'slot', key: 'header:authorization' };
}

function hasConflictingDestinations(group: AuthScheme[]): boolean {
  const slots = new Set<string>();
  const cookieNames = new Set<string>();
  let ownsCookieHeader = false;
  for (const scheme of group) {
    const destination = authDestination(scheme);
    if (destination.kind === 'cookie-header') {
      if (ownsCookieHeader || cookieNames.size > 0) return true;
      ownsCookieHeader = true;
    } else if (destination.kind === 'cookie') {
      if (ownsCookieHeader || cookieNames.has(destination.name)) return true;
      cookieNames.add(destination.name);
    } else {
      if (slots.has(destination.key)) return true;
      slots.add(destination.key);
    }
  }
  return false;
}

// ─── Public API ───

/**
 * Normalize agent card securityRequirements + securitySchemes
 * into AuthScheme[][] (outer: OR, inner: AND).
 *
 * OAuth2 schemes with multiple flows are expanded into separate OR groups.
 * A non-empty requirement is discarded as a whole when any named scheme is
 * absent or unsupported; an explicitly empty requirement remains an
 * anonymous alternative.
 */
export function normalizeRequirements(
  requirements: SecurityRequirement[],
  schemes: Record<string, SecuritySchemeV03 | SecuritySchemeV10>,
): AuthScheme[][] {
  if (!isRecord(schemes)) {
    throw new InvalidAgentResponseError(
      'AgentCard securitySchemes must be an object.',
    );
  }
  const result: AuthScheme[][] = [];

  for (const requirement of requirements) {
    const entries = Object.entries(requirement);
    if (entries.length === 0) {
      if (result.length >= MAX_NORMALIZED_AUTH_GROUPS) {
        throw new InvalidAgentResponseError(
          `AgentCard expands to more than ${MAX_NORMALIZED_AUTH_GROUPS} authentication alternatives`,
        );
      }
      result.push([]);
      continue;
    }

    // Each named scheme is an AND slot. A slot may normalize to multiple
    // OAuth flows, so form the Cartesian product of those alternatives.
    let groups: AuthScheme[][] = [[]];
    let supported = true;
    for (const [schemeName, requiredScopes] of entries) {
      if (!Object.hasOwn(schemes, schemeName)) {
        supported = false;
        break;
      }
      const raw = schemes[schemeName];

      const classes = normalizeScheme(raw, requiredScopes);
      if (classes.length === 0) {
        supported = false;
        break;
      }

      if (
        groups.length >
        Math.floor(
          (MAX_NORMALIZED_AUTH_GROUPS - result.length) / classes.length,
        )
      ) {
        throw new InvalidAgentResponseError(
          `AgentCard expands to more than ${MAX_NORMALIZED_AUTH_GROUPS} authentication alternatives`,
        );
      }

      groups = groups.flatMap((group) =>
        classes.map((scheme) => [...group, scheme]),
      );
    }

    if (supported) {
      result.push(...groups.filter((group) => !hasConflictingDestinations(group)));
    }
  }

  return result;
}

// ─── Internal: Scheme Normalization ───

/**
 * Normalize a single raw security scheme (v0.3 or v1.0) into one or more
 * AuthScheme instances. Returns multiple for OAuth2 with multiple flows.
 */
export function normalizeScheme(
  raw: SecuritySchemeV03 | SecuritySchemeV10,
  requiredScopes?: readonly string[],
): AuthScheme[] {
  if (!isRecord(raw)) {
    invalidSecurityScheme('each referenced scheme must be an object.');
  }
  const requiredScopesSnapshot = requiredScopes === undefined
    ? undefined
    : Object.freeze([...requiredScopes]);

  // v0.3: has a `type` field directly
  if (Object.hasOwn(raw, 'type')) {
    return normalizeV03Scheme(raw as SecuritySchemeV03, requiredScopesSnapshot);
  }

  // v1.0: has nested scheme objects
  return normalizeV10Scheme(raw as SecuritySchemeV10, requiredScopesSnapshot);
}

function normalizeV03Scheme(
  scheme: SecuritySchemeV03,
  requiredScopes?: readonly string[],
): AuthScheme[] {
  switch (scheme.type) {
    case 'apiKey': {
      if (
        !['header', 'query', 'cookie'].includes(scheme.in) ||
        typeof scheme.name !== 'string' ||
        scheme.name.length === 0
      ) {
        invalidSecurityScheme(
          'API key requires a non-empty name and location header, query, or cookie.',
        );
      }
      return [
        new ApiKeyAuthScheme(
          scheme.name,
          scheme.in as 'header' | 'query' | 'cookie',
        ),
      ];
    }

    case 'http': {
      if (typeof scheme.scheme !== 'string') {
        invalidSecurityScheme('HTTP authentication scheme must be a string.');
      }
      const name = scheme.scheme.toLowerCase();
      if (name === 'bearer') {
        return [new HttpBearerAuthScheme(scheme.bearerFormat)];
      }
      if (name === 'basic') {
        return [new HttpBasicAuthScheme()];
      }
      return [];
    }

    case 'oauth2':
      assertOAuthFlows(scheme.flows);
      return normalizeOAuth2FlowsV03(scheme.flows, requiredScopes);

    case 'openIdConnect':
      if (
        typeof scheme.openIdConnectUrl !== 'string' ||
        scheme.openIdConnectUrl.length === 0
      ) {
        invalidSecurityScheme(
          'OpenID Connect requires a non-empty openIdConnectUrl string.',
        );
      }
      return [
        new OpenIdConnectAuthScheme(
          scheme.openIdConnectUrl,
          requiredScopes,
        ),
      ];

    case 'mutualTLS':
      // Not supported at HTTP level — skip
      return [];

    default:
      return [];
  }
}

function normalizeV10Scheme(
  scheme: SecuritySchemeV10,
  requiredScopes?: readonly string[],
): AuthScheme[] {
  const members = [
    'apiKeySecurityScheme',
    'httpAuthSecurityScheme',
    'oauth2SecurityScheme',
    'openIdConnectSecurityScheme',
    'mtlsSecurityScheme',
  ] as const;
  const present = members.filter(
    (name) => Object.hasOwn(scheme, name) && scheme[name] !== undefined,
  );
  if (present.length !== 1) {
    invalidSecurityScheme(
      'v1.0 scheme must contain exactly one recognized security scheme member.',
    );
  }

  const memberName = present[0]!;
  const member = scheme[memberName];
  if (!isRecord(member)) {
    invalidSecurityScheme(`v1.0 ${memberName} must be an object.`);
  }

  if (memberName === 'apiKeySecurityScheme') {
    const s = member as unknown as NonNullable<SecuritySchemeV10['apiKeySecurityScheme']>;
    if (
      !['header', 'query', 'cookie'].includes(s.location) ||
      typeof s.name !== 'string' ||
      s.name.length === 0
    ) {
      invalidSecurityScheme(
        'API key requires a non-empty name and location header, query, or cookie.',
      );
    }
    return [
      new ApiKeyAuthScheme(
        s.name,
        s.location as 'header' | 'query' | 'cookie',
      ),
    ];
  }

  if (memberName === 'httpAuthSecurityScheme') {
    const s = member as unknown as NonNullable<SecuritySchemeV10['httpAuthSecurityScheme']>;
    if (typeof s.scheme !== 'string') {
      invalidSecurityScheme('HTTP authentication scheme must be a string.');
    }
    const name = s.scheme.toLowerCase();
    if (name === 'bearer') {
      return [new HttpBearerAuthScheme(s.bearerFormat)];
    }
    if (name === 'basic') {
      return [new HttpBasicAuthScheme()];
    }
    return [];
  }

  if (memberName === 'oauth2SecurityScheme') {
    const oauth2 = member as unknown as NonNullable<SecuritySchemeV10['oauth2SecurityScheme']>;
    assertOAuthFlows(oauth2.flows);
    return normalizeOAuth2FlowsV10(
      oauth2.flows,
      requiredScopes,
    );
  }

  if (memberName === 'openIdConnectSecurityScheme') {
    const oidc = member as unknown as NonNullable<SecuritySchemeV10['openIdConnectSecurityScheme']>;
    if (
      typeof oidc.openIdConnectUrl !== 'string' ||
      oidc.openIdConnectUrl.length === 0
    ) {
      invalidSecurityScheme(
        'OpenID Connect requires a non-empty openIdConnectUrl string.',
      );
    }
    return [
      new OpenIdConnectAuthScheme(
        oidc.openIdConnectUrl,
        requiredScopes,
      ),
    ];
  }

  if (memberName === 'mtlsSecurityScheme') {
    // Not supported at HTTP level — skip
    return [];
  }

  return invalidSecurityScheme('v1.0 scheme member is not supported.');
}

// ─── OAuth2 Flow Normalization ───

function normalizeOAuth2FlowsV03(
  flows: NonNullable<Extract<SecuritySchemeV03, { type: 'oauth2' }>['flows']>,
  requiredScopes?: readonly string[],
): AuthScheme[] {
  const result: AuthScheme[] = [];

  // `deviceCode` is a non-standard extension on v0.3. `@a2x/sdk` emits it
  // alongside standard flows, so consume it the same way v1.0 does.
  if (flows.deviceCode) {
    assertOAuthFlow(
      flows.deviceCode,
      'deviceCode',
      ['deviceAuthorizationUrl', 'tokenUrl'],
    );
    result.push(
      new OAuth2DeviceCodeAuthScheme(
        flows.deviceCode.deviceAuthorizationUrl,
        flows.deviceCode.tokenUrl,
        flows.deviceCode.scopes ?? {},
        flows.deviceCode.refreshUrl,
        requiredScopes,
      ),
    );
  }

  if (flows.authorizationCode) {
    assertOAuthFlow(
      flows.authorizationCode,
      'authorizationCode',
      ['authorizationUrl', 'tokenUrl'],
    );
    result.push(
      new OAuth2AuthorizationCodeAuthScheme(
        flows.authorizationCode.authorizationUrl,
        flows.authorizationCode.tokenUrl,
        flows.authorizationCode.scopes ?? {},
        flows.authorizationCode.refreshUrl,
        undefined,
        requiredScopes,
      ),
    );
  }

  if (flows.clientCredentials) {
    assertOAuthFlow(
      flows.clientCredentials,
      'clientCredentials',
      ['tokenUrl'],
    );
    result.push(
      new OAuth2ClientCredentialsAuthScheme(
        flows.clientCredentials.tokenUrl,
        flows.clientCredentials.scopes ?? {},
        flows.clientCredentials.refreshUrl,
        requiredScopes,
      ),
    );
  }

  if (flows.implicit) {
    assertOAuthFlow(flows.implicit, 'implicit', ['authorizationUrl']);
    result.push(
      new OAuth2ImplicitAuthScheme(
        flows.implicit.authorizationUrl,
        flows.implicit.scopes ?? {},
        flows.implicit.refreshUrl,
        requiredScopes,
      ),
    );
  }

  if (flows.password) {
    assertOAuthFlow(flows.password, 'password', ['tokenUrl']);
    result.push(
      new OAuth2PasswordAuthScheme(
        flows.password.tokenUrl,
        flows.password.scopes ?? {},
        flows.password.refreshUrl,
        requiredScopes,
      ),
    );
  }

  return result;
}

function normalizeOAuth2FlowsV10(
  flows: NonNullable<SecuritySchemeV10['oauth2SecurityScheme']>['flows'],
  requiredScopes?: readonly string[],
): AuthScheme[] {
  const result: AuthScheme[] = [];

  if (flows.deviceCode) {
    assertOAuthFlow(
      flows.deviceCode,
      'deviceCode',
      ['deviceAuthorizationUrl', 'tokenUrl'],
    );
    result.push(
      new OAuth2DeviceCodeAuthScheme(
        flows.deviceCode.deviceAuthorizationUrl,
        flows.deviceCode.tokenUrl,
        flows.deviceCode.scopes ?? {},
        flows.deviceCode.refreshUrl,
        requiredScopes,
      ),
    );
  }

  if (flows.authorizationCode) {
    assertOAuthFlow(
      flows.authorizationCode,
      'authorizationCode',
      ['authorizationUrl', 'tokenUrl'],
      true,
    );
    result.push(
      new OAuth2AuthorizationCodeAuthScheme(
        flows.authorizationCode.authorizationUrl,
        flows.authorizationCode.tokenUrl,
        flows.authorizationCode.scopes ?? {},
        flows.authorizationCode.refreshUrl,
        flows.authorizationCode.pkceRequired,
        requiredScopes,
      ),
    );
  }

  if (flows.clientCredentials) {
    assertOAuthFlow(
      flows.clientCredentials,
      'clientCredentials',
      ['tokenUrl'],
    );
    result.push(
      new OAuth2ClientCredentialsAuthScheme(
        flows.clientCredentials.tokenUrl,
        flows.clientCredentials.scopes ?? {},
        flows.clientCredentials.refreshUrl,
        requiredScopes,
      ),
    );
  }

  if (flows.implicit) {
    assertOAuthFlow(flows.implicit, 'implicit', ['authorizationUrl']);
    result.push(
      new OAuth2ImplicitAuthScheme(
        flows.implicit.authorizationUrl,
        flows.implicit.scopes ?? {},
        flows.implicit.refreshUrl,
        requiredScopes,
      ),
    );
  }

  if (flows.password) {
    assertOAuthFlow(flows.password, 'password', ['tokenUrl']);
    result.push(
      new OAuth2PasswordAuthScheme(
        flows.password.tokenUrl,
        flows.password.scopes ?? {},
        flows.password.refreshUrl,
        requiredScopes,
      ),
    );
  }

  return result;
}
