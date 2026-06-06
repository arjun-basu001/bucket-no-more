/**
 * @module auth/jwt
 *
 * JWT issuance and verification for agent-to-agent calls, built on `jose`
 * (RFC 7519 / 7515). We use EdDSA (Ed25519) for short-lived access tokens:
 * fast, small signatures, no parameter-choice foot-guns like RSA padding.
 *
 * Two token shapes flow through the system:
 *   1. Agent access tokens — minted after an agent authenticates (client
 *      credentials / OAuth2) and used as the Bearer on A2A requests.
 *   2. Delegation tokens — represent a user delegating spend authority to a
 *      shopping agent (the seed of the AP2 payment mandate).
 *
 * SECURITY POSTURE
 *   - Always pin `alg` on verify; never trust the token header's `alg` blindly
 *     (prevents alg-confusion / `none` attacks).
 *   - Always validate `iss`, `aud`, and `exp` with a small clock skew.
 *   - Short lifetimes (minutes) + a separate refresh/mandate mechanism.
 */

import {
  SignJWT,
  jwtVerify,
  generateKeyPair,
  exportJWK,
  importJWK,
  type JWTPayload,
  type JWK,
  type KeyLike,
} from 'jose';

export const JWT_ALG = 'EdDSA' as const;

/** Scopes are coarse capabilities an agent token may carry. */
export type Scope =
  | 'catalog:read'
  | 'cart:write'
  | 'checkout:execute'
  | 'payment:authorize'
  | 'agent:discover';

export interface AgentTokenClaims extends JWTPayload {
  /** The acting agent's stable identifier (matches its agent card id). */
  readonly sub: string;
  /** Granted capabilities. */
  readonly scope: string;
  /** Optional id of the user on whose behalf the agent acts. */
  readonly act_for?: string;
}

export interface IssueOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly scopes: readonly Scope[];
  readonly actForUser?: string;
  /** Token lifetime in seconds (default 300s / 5 min). */
  readonly ttlSeconds?: number;
  readonly keyId?: string;
}

export interface VerifyOptions {
  readonly issuer: string;
  readonly audience: string;
  /** Clock-skew tolerance in seconds (default 30s). */
  readonly clockToleranceSeconds?: number;
  readonly requiredScopes?: readonly Scope[];
}

/** Generate a fresh Ed25519 keypair for token signing. */
export async function generateSigningKeys(): Promise<{ privateKey: KeyLike; publicKey: KeyLike; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair(JWT_ALG, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicKey, publicJwk };
}

/** Mint a signed agent access token. */
export async function issueAgentToken(privateKey: KeyLike, opts: IssueOptions): Promise<string> {
  const ttl = opts.ttlSeconds ?? 300;
  const builder = new SignJWT({
    scope: opts.scopes.join(' '),
    ...(opts.actForUser ? { act_for: opts.actForUser } : {}),
  })
    .setProtectedHeader({ alg: JWT_ALG, ...(opts.keyId ? { kid: opts.keyId } : {}) })
    .setIssuedAt()
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject(opts.subject)
    .setExpirationTime(`${ttl}s`)
    .setJti(crypto.randomUUID());
  return builder.sign(privateKey);
}

export class TokenVerificationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

/**
 * Verify an agent token. Pins the algorithm, validates iss/aud/exp, and (if
 * requested) checks that all required scopes are present. Throws a typed
 * {@link TokenVerificationError} on any failure.
 */
export async function verifyAgentToken(
  token: string,
  publicKey: KeyLike,
  opts: VerifyOptions,
): Promise<AgentTokenClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, publicKey, {
      algorithms: [JWT_ALG], // pin alg — reject anything else, including "none"
      issuer: opts.issuer,
      audience: opts.audience,
      clockTolerance: opts.clockToleranceSeconds ?? 30,
    }));
  } catch (e) {
    throw new TokenVerificationError(
      `JWT verification failed: ${(e as Error).message}`,
      'JWT_INVALID',
    );
  }

  const claims = payload as AgentTokenClaims;
  if (opts.requiredScopes && opts.requiredScopes.length > 0) {
    const granted = new Set((claims.scope ?? '').split(' ').filter(Boolean));
    const missing = opts.requiredScopes.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      throw new TokenVerificationError(
        `Token missing required scopes: ${missing.join(', ')}`,
        'INSUFFICIENT_SCOPE',
      );
    }
  }
  return claims;
}

/** Re-import a public key from a published JWK (e.g. from a JWKS endpoint). */
export async function importPublicJwk(jwk: JWK): Promise<KeyLike> {
  return (await importJWK(jwk, JWT_ALG)) as KeyLike;
}
