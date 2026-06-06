/**
 * @module auth/oauth2
 *
 * OAuth2 client-credentials grant for agent-to-agent authentication, plus a
 * minimal authorization server that issues the JWTs from {@link auth/jwt}.
 *
 * In agentic commerce, a shopping agent authenticates to a merchant's
 * authorization server using the *client credentials* grant (machine-to-machine,
 * no human in the loop). The server validates the client's registered secret
 * (or, better, a private-key-JWT client assertion) and the requested scopes,
 * then mints a short-lived access token bound to an audience.
 *
 * This module implements:
 *   - AuthorizationServer.issueClientCredentials(): validates client + scopes,
 *     enforces the scopes a client is allowed to request, and returns a token.
 *   - OAuth2Client: a tiny client that caches tokens until shortly before expiry
 *     and transparently refreshes them.
 */

import { issueAgentToken, type Scope } from './jwt.js';
import type { KeyLike } from 'jose';

/** A registered client (another agent) allowed to request tokens. */
export interface RegisteredClient {
  readonly clientId: string;
  /** Hash of the client secret (never store plaintext). */
  readonly clientSecretHash: string;
  /** Scopes this client is permitted to request — the upper bound. */
  readonly allowedScopes: readonly Scope[];
  /** Subject placed in minted tokens (usually the client's agent id). */
  readonly subject: string;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly scope: string;
}

export class OAuth2Error extends Error {
  constructor(readonly error: string, description: string) {
    super(description);
    this.name = 'OAuth2Error';
  }
}

/** Constant-time-ish secret comparison via SHA-256 (demo-grade). */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface AuthServerConfig {
  readonly issuer: string;
  readonly defaultTtlSeconds?: number;
}

/** Minimal OAuth2 authorization server (client-credentials grant only). */
export class AuthorizationServer {
  private readonly clients = new Map<string, RegisteredClient>();

  constructor(
    private readonly signingKey: KeyLike,
    private readonly config: AuthServerConfig,
    private readonly keyId = 'as-key-1',
  ) {}

  registerClient(client: RegisteredClient): void {
    this.clients.set(client.clientId, client);
  }

  /** Helper to hash a plaintext secret at registration time. */
  static hashSecret(secret: string): Promise<string> {
    return sha256Hex(secret);
  }

  /**
   * RFC 6749 §4.4 client-credentials grant. `audience` scopes the token to a
   * specific resource server (the merchant API the agent intends to call).
   */
  async issueClientCredentials(args: {
    clientId: string;
    clientSecret: string;
    requestedScopes: readonly Scope[];
    audience: string;
    actForUser?: string;
  }): Promise<TokenResponse> {
    const client = this.clients.get(args.clientId);
    if (!client) {
      throw new OAuth2Error('invalid_client', 'Unknown client_id');
    }
    const presentedHash = await sha256Hex(args.clientSecret);
    if (presentedHash !== client.clientSecretHash) {
      throw new OAuth2Error('invalid_client', 'Client authentication failed');
    }

    // Scope down-scoping: a client can only get scopes it is allowed to request.
    const allowed = new Set(client.allowedScopes);
    const granted = args.requestedScopes.filter((s) => allowed.has(s));
    const denied = args.requestedScopes.filter((s) => !allowed.has(s));
    if (denied.length > 0) {
      throw new OAuth2Error('invalid_scope', `Client may not request: ${denied.join(', ')}`);
    }
    if (granted.length === 0) {
      throw new OAuth2Error('invalid_scope', 'No valid scopes requested');
    }

    const ttl = this.config.defaultTtlSeconds ?? 300;
    const access_token = await issueAgentToken(this.signingKey, {
      issuer: this.config.issuer,
      audience: args.audience,
      subject: client.subject,
      scopes: granted,
      actForUser: args.actForUser,
      ttlSeconds: ttl,
      keyId: this.keyId,
    });
    return { access_token, token_type: 'Bearer', expires_in: ttl, scope: granted.join(' ') };
  }
}

/** Token-fetching function the client uses to (re)acquire access tokens. */
export type TokenFetcher = () => Promise<TokenResponse>;

/**
 * Client-side token manager: caches a token and refreshes it `skewSeconds`
 * before expiry so in-flight requests never carry an expired token.
 */
export class OAuth2Client {
  private cached?: { token: string; expiresAtMs: number };

  constructor(
    private readonly fetcher: TokenFetcher,
    private readonly skewSeconds = 30,
  ) {}

  /** Return a valid bearer token, fetching/refreshing as needed. */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAtMs - this.skewSeconds * 1000 > now) {
      return this.cached.token;
    }
    const resp = await this.fetcher();
    this.cached = { token: resp.access_token, expiresAtMs: now + resp.expires_in * 1000 };
    return resp.access_token;
  }

  /** Force the next call to fetch a fresh token (e.g. after a 401). */
  invalidate(): void {
    this.cached = undefined;
  }
}
