/**
 * @module auth/agent-card-signature
 *
 * Agent Cards are signed JSON documents that advertise an agent's identity,
 * endpoints, and capabilities (the A2A discovery primitive). Before any agent
 * trusts another, it MUST verify the card's signature against a key it can
 * anchor to the claimed issuer.
 *
 * We sign over a CANONICAL serialization of the card (stable key ordering) so
 * that re-serialization on the verifying side reproduces the exact bytes that
 * were signed. The signature itself is a compact JWS (RFC 7515) carried in a
 * sibling `proof` field, leaving the card body untouched and human-readable.
 *
 * Why canonicalization matters: JSON object key order and whitespace are not
 * guaranteed across languages/serializers. Without canonicalization, a card
 * that is semantically identical but byte-different fails verification — or
 * worse, an attacker reorders fields to confuse a naive verifier.
 */

import { CompactSign, compactVerify, type KeyLike, type JWK } from 'jose';
import { importPublicJwk } from './jwt.js';

/** A signature proof attached to an agent card. */
export interface CardProof {
  readonly type: 'JsonWebSignature2020';
  readonly created: string;
  /** Key id resolvable to the issuer's public key. */
  readonly verificationMethod: string;
  /** Detached compact JWS over the canonical card bytes (header..signature). */
  readonly jws: string;
}

/**
 * Deterministic JSON canonicalization (a pragmatic subset of RFC 8785):
 * recursively sorts object keys and emits compact JSON. Arrays preserve order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const encoder = new TextEncoder();

/**
 * Sign an agent card body (without its `proof`) and return a {@link CardProof}.
 * The caller attaches the returned proof to the card as `card.proof`.
 */
export async function signAgentCard(
  cardWithoutProof: Record<string, unknown>,
  privateKey: KeyLike,
  verificationMethod: string,
): Promise<CardProof> {
  const canonical = canonicalize(cardWithoutProof);
  const jws = await new CompactSign(encoder.encode(canonical))
    .setProtectedHeader({ alg: 'EdDSA', b64: true, kid: verificationMethod })
    .sign(privateKey);
  return {
    type: 'JsonWebSignature2020',
    created: new Date().toISOString(),
    verificationMethod,
    jws,
  };
}

export class CardSignatureError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CardSignatureError';
  }
}

/**
 * Verify an agent card's proof. `card` is the full card *including* `proof`;
 * we strip the proof, re-canonicalize the body, and confirm the JWS payload
 * matches and the signature is valid under `publicKey`.
 */
export async function verifyAgentCard(
  card: Record<string, unknown> & { proof?: CardProof },
  publicKey: KeyLike,
): Promise<{ verificationMethod: string }> {
  const proof = card.proof;
  if (!proof || typeof proof.jws !== 'string') {
    throw new CardSignatureError('Agent card is missing a signature proof', 'NO_PROOF');
  }

  const { proof: _omit, ...body } = card;
  const expected = canonicalize(body);

  let payloadBytes: Uint8Array;
  let header: Record<string, unknown>;
  try {
    const result = await compactVerify(proof.jws, publicKey, { algorithms: ['EdDSA'] });
    payloadBytes = result.payload;
    header = result.protectedHeader as Record<string, unknown>;
  } catch (e) {
    throw new CardSignatureError(`Signature verification failed: ${(e as Error).message}`, 'BAD_SIGNATURE');
  }

  const signedCanonical = new TextDecoder().decode(payloadBytes);
  if (signedCanonical !== expected) {
    // Body was tampered with after signing (or canonicalization mismatch).
    throw new CardSignatureError('Card body does not match its signature', 'PAYLOAD_MISMATCH');
  }
  if (header['kid'] !== proof.verificationMethod) {
    throw new CardSignatureError('Proof verificationMethod does not match JWS kid', 'KID_MISMATCH');
  }
  return { verificationMethod: proof.verificationMethod };
}

/** Convenience: verify a card given the issuer's published JWK. */
export async function verifyAgentCardWithJwk(
  card: Record<string, unknown> & { proof?: CardProof },
  jwk: JWK,
): Promise<{ verificationMethod: string }> {
  return verifyAgentCard(card, await importPublicJwk(jwk));
}
