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

function authDestination(scheme: AuthScheme): string {
  if (scheme instanceof ApiKeyAuthScheme) {
    const name = scheme.params.location === 'header'
      ? scheme.params.name.toLowerCase()
      : scheme.params.name;
    if (scheme.params.location === 'header' && name === 'cookie') {
      return 'cookie:*';
    }
    return `${scheme.params.location}:${name}`;
  }
  return 'header:authorization';
}

function hasConflictingDestinations(group: AuthScheme[]): boolean {
  const destinations = new Set<string>();
  for (const scheme of group) {
    const destination = authDestination(scheme);
    if (
      destination === 'cookie:*'
        ? [...destinations].some((candidate) => candidate.startsWith('cookie:'))
        : destination.startsWith('cookie:') && destinations.has('cookie:*')
    ) return true;
    if (destinations.has(destination)) return true;
    destinations.add(destination);
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
  const result: AuthScheme[][] = [];

  for (const requirement of requirements) {
    const entries = Object.entries(requirement);
    if (entries.length === 0) {
      if (result.length >= MAX_NORMALIZED_AUTH_GROUPS) {
        throw new RangeError(
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
      const raw = schemes[schemeName];
      if (!raw) {
        supported = false;
        break;
      }

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
        throw new RangeError(
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
  // v0.3: has a `type` field directly
  if ('type' in raw) {
    return normalizeV03Scheme(raw as SecuritySchemeV03, requiredScopes);
  }

  // v1.0: has nested scheme objects
  return normalizeV10Scheme(raw as SecuritySchemeV10, requiredScopes);
}

function normalizeV03Scheme(
  scheme: SecuritySchemeV03,
  requiredScopes?: readonly string[],
): AuthScheme[] {
  switch (scheme.type) {
    case 'apiKey':
      return [
        new ApiKeyAuthScheme(
          scheme.name,
          scheme.in as 'header' | 'query' | 'cookie',
        ),
      ];

    case 'http':
      if (scheme.scheme === 'bearer') {
        return [new HttpBearerAuthScheme(scheme.bearerFormat)];
      }
      if (scheme.scheme === 'basic') {
        return [new HttpBasicAuthScheme()];
      }
      return [];

    case 'oauth2':
      return normalizeOAuth2FlowsV03(scheme.flows, requiredScopes);

    case 'openIdConnect':
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
  if (scheme.apiKeySecurityScheme) {
    const s = scheme.apiKeySecurityScheme;
    return [
      new ApiKeyAuthScheme(
        s.name,
        s.location as 'header' | 'query' | 'cookie',
      ),
    ];
  }

  if (scheme.httpAuthSecurityScheme) {
    const s = scheme.httpAuthSecurityScheme;
    if (s.scheme === 'bearer') {
      return [new HttpBearerAuthScheme(s.bearerFormat)];
    }
    if (s.scheme === 'basic') {
      return [new HttpBasicAuthScheme()];
    }
    return [];
  }

  if (scheme.oauth2SecurityScheme) {
    return normalizeOAuth2FlowsV10(
      scheme.oauth2SecurityScheme.flows,
      requiredScopes,
    );
  }

  if (scheme.openIdConnectSecurityScheme) {
    return [
      new OpenIdConnectAuthScheme(
        scheme.openIdConnectSecurityScheme.openIdConnectUrl,
        requiredScopes,
      ),
    ];
  }

  if (scheme.mtlsSecurityScheme) {
    // Not supported at HTTP level — skip
    return [];
  }

  return [];
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
