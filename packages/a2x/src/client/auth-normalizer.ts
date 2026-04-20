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

// ─── Public API ───

/**
 * Normalize agent card securityRequirements + securitySchemes
 * into AuthScheme[][] (outer: OR, inner: AND).
 *
 * OAuth2 schemes with multiple flows are expanded into
 * separate OR groups, each containing a single flow class.
 */
export function normalizeRequirements(
  requirements: SecurityRequirement[],
  schemes: Record<string, SecuritySchemeV03 | SecuritySchemeV10>,
): AuthScheme[][] {
  const result: AuthScheme[][] = [];

  for (const requirement of requirements) {
    const schemeNames = Object.keys(requirement);
    const nonOAuth2Schemes: AuthScheme[] = [];
    const oAuth2FlowGroups: AuthScheme[][] = [];

    for (const schemeName of schemeNames) {
      const raw = schemes[schemeName];
      if (!raw) continue;

      const classes = normalizeScheme(raw);

      if (classes.length > 1) {
        // OAuth2 with multiple flows — each flow becomes a separate OR group
        oAuth2FlowGroups.push(...classes.map((cls) => [cls]));
      } else if (classes.length === 1) {
        nonOAuth2Schemes.push(classes[0]);
      }
    }

    if (oAuth2FlowGroups.length > 0) {
      // Combine non-OAuth2 AND schemes with each OAuth2 flow as separate OR groups
      for (const flowGroup of oAuth2FlowGroups) {
        result.push([...nonOAuth2Schemes, ...flowGroup]);
      }
    } else {
      result.push(nonOAuth2Schemes);
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
): AuthScheme[] {
  // v0.3: has a `type` field directly
  if ('type' in raw) {
    return normalizeV03Scheme(raw as SecuritySchemeV03);
  }

  // v1.0: has nested scheme objects
  return normalizeV10Scheme(raw as SecuritySchemeV10);
}

function normalizeV03Scheme(scheme: SecuritySchemeV03): AuthScheme[] {
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
      return normalizeOAuth2FlowsV03(scheme.flows);

    case 'openIdConnect':
      return [new OpenIdConnectAuthScheme(scheme.openIdConnectUrl)];

    case 'mutualTLS':
      // Not supported at HTTP level — skip
      return [];

    default:
      return [];
  }
}

function normalizeV10Scheme(scheme: SecuritySchemeV10): AuthScheme[] {
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
    return normalizeOAuth2FlowsV10(scheme.oauth2SecurityScheme.flows);
  }

  if (scheme.openIdConnectSecurityScheme) {
    return [
      new OpenIdConnectAuthScheme(
        scheme.openIdConnectSecurityScheme.openIdConnectUrl,
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
      ),
    );
  }

  if (flows.clientCredentials) {
    result.push(
      new OAuth2ClientCredentialsAuthScheme(
        flows.clientCredentials.tokenUrl,
        flows.clientCredentials.scopes ?? {},
        flows.clientCredentials.refreshUrl,
      ),
    );
  }

  if (flows.implicit) {
    result.push(
      new OAuth2ImplicitAuthScheme(
        flows.implicit.authorizationUrl,
        flows.implicit.scopes ?? {},
        flows.implicit.refreshUrl,
      ),
    );
  }

  if (flows.password) {
    result.push(
      new OAuth2PasswordAuthScheme(
        flows.password.tokenUrl,
        flows.password.scopes ?? {},
        flows.password.refreshUrl,
      ),
    );
  }

  return result;
}

function normalizeOAuth2FlowsV10(
  flows: NonNullable<SecuritySchemeV10['oauth2SecurityScheme']>['flows'],
): AuthScheme[] {
  const result: AuthScheme[] = [];

  if (flows.deviceCode) {
    result.push(
      new OAuth2DeviceCodeAuthScheme(
        flows.deviceCode.deviceAuthorizationUrl,
        flows.deviceCode.tokenUrl,
        flows.deviceCode.scopes ?? {},
        flows.deviceCode.refreshUrl,
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
      ),
    );
  }

  if (flows.clientCredentials) {
    result.push(
      new OAuth2ClientCredentialsAuthScheme(
        flows.clientCredentials.tokenUrl,
        flows.clientCredentials.scopes ?? {},
        flows.clientCredentials.refreshUrl,
      ),
    );
  }

  if (flows.implicit) {
    result.push(
      new OAuth2ImplicitAuthScheme(
        flows.implicit.authorizationUrl,
        flows.implicit.scopes ?? {},
        flows.implicit.refreshUrl,
      ),
    );
  }

  if (flows.password) {
    result.push(
      new OAuth2PasswordAuthScheme(
        flows.password.tokenUrl,
        flows.password.scopes ?? {},
        flows.password.refreshUrl,
      ),
    );
  }

  return result;
}
