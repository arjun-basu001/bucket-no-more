/**
 * @module agent-card/agent-card
 *
 * Agent Card creation & validation. An Agent Card is the A2A discovery
 * document: a signed JSON object an agent publishes (typically at
 * `/.well-known/agent-card.json`) so peers can learn who it is, where to reach
 * it, what it can do, and how to authenticate to it.
 *
 * We validate structure with zod (fail fast, friendly errors) and sign/verify
 * with the detached-JWS scheme in {@link auth/agent-card-signature}.
 */

import { z } from 'zod';
import type { KeyLike, JWK } from 'jose';
import {
  signAgentCard,
  verifyAgentCard,
  type CardProof,
} from '../auth/agent-card-signature.js';

/** Supported authentication schemes an agent may advertise. */
export const AuthSchemeSchema = z.object({
  type: z.enum(['oauth2-client-credentials', 'bearer-jwt', 'mtls']),
  /** Token endpoint for OAuth2 schemes. */
  tokenEndpoint: z.string().url().optional(),
  /** JWKS URL where this agent's verification keys are published. */
  jwksUri: z.string().url().optional(),
  scopes: z.array(z.string()).default([]),
});

/** A capability/skill the agent exposes via A2A. */
export const CapabilitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  /** Protocol-level method name handled by this capability. */
  method: z.string().min(1),
  inputSchemaRef: z.string().optional(),
  outputSchemaRef: z.string().optional(),
});

export const ProofSchema = z.object({
  type: z.literal('JsonWebSignature2020'),
  created: z.string(),
  verificationMethod: z.string().min(1),
  jws: z.string().min(1),
});

/** The full Agent Card schema. */
export const AgentCardSchema = z.object({
  /** Spec version for forward compatibility. */
  schemaVersion: z.literal('1.0'),
  /** Stable, globally-unique agent id (often a URI). */
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  /** Base URL of the agent's A2A endpoint. */
  endpoint: z.string().url(),
  /** Org/operator that vouches for this agent. */
  provider: z.object({ name: z.string(), url: z.string().url().optional() }),
  version: z.string().default('1.0.0'),
  auth: AuthSchemeSchema,
  capabilities: z.array(CapabilitySchema).min(1),
  /** Optional signature; absent on an unsigned draft, present once published. */
  proof: ProofSchema.optional(),
});

export type AgentCard = z.infer<typeof AgentCardSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;

export class AgentCardValidationError extends Error {
  constructor(message: string, readonly issues: unknown) {
    super(message);
    this.name = 'AgentCardValidationError';
  }
}

/** Validate an unknown object as an AgentCard, throwing on failure. */
export function parseAgentCard(input: unknown): AgentCard {
  const result = AgentCardSchema.safeParse(input);
  if (!result.success) {
    throw new AgentCardValidationError('Invalid agent card', result.error.format());
  }
  return result.data;
}

/**
 * Build and sign an Agent Card. The card is validated first (without proof),
 * then signed, then the proof is attached and the whole thing re-validated.
 */
export async function createSignedAgentCard(
  draft: Omit<AgentCard, 'proof'>,
  privateKey: KeyLike,
  verificationMethod: string,
): Promise<AgentCard> {
  // Validate the body before signing so we never sign garbage.
  const body = AgentCardSchema.omit({ proof: true }).parse(draft);
  const proof: CardProof = await signAgentCard(
    body as unknown as Record<string, unknown>,
    privateKey,
    verificationMethod,
  );
  return parseAgentCard({ ...body, proof });
}

/**
 * Validate structure AND signature of a received card. Returns the parsed card
 * on success; throws AgentCardValidationError / CardSignatureError otherwise.
 */
export async function verifySignedAgentCard(input: unknown, publicKey: KeyLike): Promise<AgentCard> {
  const card = parseAgentCard(input);
  await verifyAgentCard(card as unknown as Record<string, unknown> & { proof?: CardProof }, publicKey);
  return card;
}

/** Locate a capability by its method name (used during A2A dispatch). */
export function findCapability(card: AgentCard, method: string): Capability | undefined {
  return card.capabilities.find((c) => c.method === method);
}

export type { JWK };
