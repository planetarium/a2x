/**
 * Client-side authentication scheme classes.
 *
 * Each AuthScheme subclass represents a normalized, version-agnostic
 * authentication mechanism. The client sets a credential via setCredential(),
 * and the scheme knows how to apply it to an outgoing request.
 */

// ─── Request Context ───

/**
 * Mutable context passed to applyToRequest().
 * Each scheme mutates the fields it needs.
 * Extensible — new fields can be added without changing existing schemes.
 */
export interface AuthRequestContext {
  headers: Record<string, string>;
  url: URL;
}

// ─── Base Class ───

export abstract class AuthScheme {
  protected credential?: string;

  /**
   * Set the raw credential value and return this instance (fluent).
   *
   * @example scheme.setCredential(token)
   */
  setCredential(value: string): this {
    this.credential = value;
    return this;
  }

  /**
   * Apply the stored credential to the outgoing request context.
   * Each subclass knows the correct placement and format.
   */
  abstract applyToRequest(ctx: AuthRequestContext): void;
}

// ─── API Key ───

export class ApiKeyAuthScheme extends AuthScheme {
  constructor(
    readonly name: string,
    readonly location: 'header' | 'query' | 'cookie',
  ) {
    super();
  }

  get params() {
    return { name: this.name, location: this.location };
  }

  applyToRequest(ctx: AuthRequestContext): void {
    if (this.location === 'header') {
      ctx.headers[this.name] = this.credential!;
    } else if (this.location === 'query') {
      ctx.url.searchParams.set(this.name, this.credential!);
    } else if (this.location === 'cookie') {
      ctx.headers['Cookie'] = `${this.name}=${this.credential!}`;
    }
  }
}

// ─── HTTP Bearer ───

export class HttpBearerAuthScheme extends AuthScheme {
  constructor(readonly bearerFormat?: string) {
    super();
  }

  get params() {
    return { bearerFormat: this.bearerFormat };
  }

  applyToRequest(ctx: AuthRequestContext): void {
    ctx.headers['Authorization'] = `Bearer ${this.credential!}`;
  }
}

// ─── HTTP Basic ───

export class HttpBasicAuthScheme extends AuthScheme {
  get params() {
    return {};
  }

  applyToRequest(ctx: AuthRequestContext): void {
    ctx.headers['Authorization'] = `Basic ${this.credential!}`;
  }
}

// ─── OAuth2: Device Code ───

export class OAuth2DeviceCodeAuthScheme extends AuthScheme {
  constructor(
    readonly deviceAuthorizationUrl: string,
    readonly tokenUrl: string,
    readonly scopes: Record<string, string>,
    readonly refreshUrl?: string,
  ) {
    super();
  }

  get params() {
    return {
      deviceAuthorizationUrl: this.deviceAuthorizationUrl,
      tokenUrl: this.tokenUrl,
      scopes: this.scopes,
      refreshUrl: this.refreshUrl,
    };
  }

  applyToRequest(ctx: AuthRequestContext): void {
    ctx.headers['Authorization'] = `Bearer ${this.credential!}`;
  }
}

// ─── OAuth2: Authorization Code ───

export class OAuth2AuthorizationCodeAuthScheme extends AuthScheme {
  constructor(
    readonly authorizationUrl: string,
    readonly tokenUrl: string,
    readonly scopes: Record<string, string>,
    readonly refreshUrl?: string,
    readonly pkceRequired?: boolean,
  ) {
    super();
  }

  get params() {
    return {
      authorizationUrl: this.authorizationUrl,
      tokenUrl: this.tokenUrl,
      scopes: this.scopes,
      refreshUrl: this.refreshUrl,
      pkceRequired: this.pkceRequired,
    };
  }

  applyToRequest(ctx: AuthRequestContext): void {
    ctx.headers['Authorization'] = `Bearer ${this.credential!}`;
  }
}

// ─── OAuth2: Client Credentials ───

export class OAuth2ClientCredentialsAuthScheme extends AuthScheme {
  constructor(
    readonly tokenUrl: string,
    readonly scopes: Record<string, string>,
    readonly refreshUrl?: string,
  ) {
    super();
  }

  get params() {
    return {
      tokenUrl: this.tokenUrl,
      scopes: this.scopes,
      refreshUrl: this.refreshUrl,
    };
  }

  applyToRequest(ctx: AuthRequestContext): void {
    ctx.headers['Authorization'] = `Bearer ${this.credential!}`;
  }
}

// ─── OAuth2: Implicit ───

export class OAuth2ImplicitAuthScheme extends AuthScheme {
  constructor(
    readonly authorizationUrl: string,
    readonly scopes: Record<string, string>,
    readonly refreshUrl?: string,
  ) {
    super();
  }

  get params() {
    return {
      authorizationUrl: this.authorizationUrl,
      scopes: this.scopes,
      refreshUrl: this.refreshUrl,
    };
  }

  applyToRequest(ctx: AuthRequestContext): void {
    ctx.headers['Authorization'] = `Bearer ${this.credential!}`;
  }
}

// ─── OAuth2: Password ───

export class OAuth2PasswordAuthScheme extends AuthScheme {
  constructor(
    readonly tokenUrl: string,
    readonly scopes: Record<string, string>,
    readonly refreshUrl?: string,
  ) {
    super();
  }

  get params() {
    return {
      tokenUrl: this.tokenUrl,
      scopes: this.scopes,
      refreshUrl: this.refreshUrl,
    };
  }

  applyToRequest(ctx: AuthRequestContext): void {
    ctx.headers['Authorization'] = `Bearer ${this.credential!}`;
  }
}

// ─── OpenID Connect ───

export class OpenIdConnectAuthScheme extends AuthScheme {
  constructor(readonly openIdConnectUrl: string) {
    super();
  }

  get params() {
    return { openIdConnectUrl: this.openIdConnectUrl };
  }

  applyToRequest(ctx: AuthRequestContext): void {
    ctx.headers['Authorization'] = `Bearer ${this.credential!}`;
  }
}
