/**
 * @module auth/gateway
 *
 * AuthGateway composes the auth primitives into a single request guard that a
 * resource server (a merchant agent's API) runs on every inbound A2A call:
 *
 *   1. Extract & verify the Bearer JWT (signature, iss, aud, exp).      [authn]
 *   2. Enforce the scopes required by the endpoint.                     [authz]
 *   3. Apply per-subject token-bucket rate limiting.                    [abuse]
 *
 * The result is a typed AuthContext that downstream handlers can trust. This
 * is intentionally framework-agnostic; adapt `authorize()` into Express,
 * Fastify, or an A2A message interceptor with a few lines.
 */

import { verifyAgentToken, type Scope, type AgentTokenClaims } from './jwt.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import type { KeyLike } from 'jose';

export interface AuthContext {
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly actForUser?: string;
  readonly claims: AgentTokenClaims;
}

export type AuthFailure =
  | { kind: 'unauthenticated'; code: string; message: string }
  | { kind: 'forbidden'; code: string; message: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number; message: string };

export type AuthResult =
  | { ok: true; context: AuthContext }
  | { ok: false; failure: AuthFailure };

export interface GatewayConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly clockToleranceSeconds?: number;
}

export class AuthGateway {
  constructor(
    private readonly publicKey: KeyLike,
    private readonly config: GatewayConfig,
    private readonly rateLimiter: TokenBucketRateLimiter,
  ) {}

  /** Pull a Bearer token out of an Authorization header value. */
  static extractBearer(headerValue: string | undefined | null): string | undefined {
    if (!headerValue) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    return match?.[1];
  }

  /**
   * Full guard. `requiredScopes` is what the called endpoint demands;
   * `cost` lets expensive endpoints (e.g. checkout) consume more rate budget.
   */
  async authorize(args: {
    authorizationHeader: string | undefined | null;
    requiredScopes: readonly Scope[];
    cost?: number;
  }): Promise<AuthResult> {
    const token = AuthGateway.extractBearer(args.authorizationHeader);
    if (!token) {
      return {
        ok: false,
        failure: { kind: 'unauthenticated', code: 'NO_BEARER', message: 'Missing Bearer token' },
      };
    }

    let claims: AgentTokenClaims;
    try {
      claims = await verifyAgentToken(token, this.publicKey, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockToleranceSeconds: this.config.clockToleranceSeconds,
        requiredScopes: args.requiredScopes,
      });
    } catch (e) {
      const err = e as { code?: string; message: string };
      const kind = err.code === 'INSUFFICIENT_SCOPE' ? 'forbidden' : 'unauthenticated';
      return {
        ok: false,
        failure: { kind, code: err.code ?? 'JWT_INVALID', message: err.message } as AuthFailure,
      };
    }

    // Rate limit per authenticated subject so one noisy agent can't starve others.
    const decision = await this.rateLimiter.consume(`agent:${claims.sub}`, args.cost ?? 1);
    if (!decision.allowed) {
      return {
        ok: false,
        failure: {
          kind: 'rate_limited',
          retryAfterSeconds: decision.retryAfterSeconds,
          message: `Rate limit exceeded for ${claims.sub}`,
        },
      };
    }

    return {
      ok: true,
      context: {
        subject: claims.sub,
        scopes: (claims.scope ?? '').split(' ').filter(Boolean),
        actForUser: claims.act_for,
        claims,
      },
    };
  }
}
