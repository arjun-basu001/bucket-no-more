/**
 * @module a2a/handshake
 *
 * A2A — Agent2Agent Protocol. Before two agents transact, they perform a
 * discovery + trust handshake:
 *
 *   1. DISCOVER   — the initiator fetches the responder's signed Agent Card
 *                   (here passed in; in production fetched from the card URL).
 *   2. VERIFY     — the initiator validates the card signature against the
 *                   responder's published key, anchoring trust.
 *   3. NEGOTIATE  — both sides agree on a protocol version and a set of
 *                   capabilities/methods that will be used in the session.
 *   4. AUTHENTICATE — the initiator obtains an access token (OAuth2 client
 *                   credentials) scoped to the responder's audience.
 *
 * The output is a {@link Session} the caller uses to make authenticated A2A
 * method invocations. JSON-RPC 2.0 envelopes are modeled here too, since A2A
 * messages are JSON-RPC requests/responses.
 */

import type { KeyLike } from 'jose';
import { verifySignedAgentCard, type AgentCard } from '../agent-card/agent-card.js';
import type { OAuth2Client } from '../auth/oauth2.js';

export const A2A_PROTOCOL_VERSIONS = ['1.0'] as const;
export type A2AProtocolVersion = (typeof A2A_PROTOCOL_VERSIONS)[number];

/** A JSON-RPC 2.0 request envelope, as carried over A2A. */
export interface JsonRpcRequest<P = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly method: string;
  readonly params: P;
}

/** A JSON-RPC 2.0 response envelope. */
export type JsonRpcResponse<R = unknown> =
  | { jsonrpc: '2.0'; id: string; result: R }
  | { jsonrpc: '2.0'; id: string; error: { code: number; message: string; data?: unknown } };

export interface Session {
  readonly peer: AgentCard;
  readonly protocolVersion: A2AProtocolVersion;
  readonly negotiatedMethods: readonly string[];
  /** Returns a fresh Bearer token for each call (handles refresh). */
  readonly getToken: () => Promise<string>;
}

export class HandshakeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'HandshakeError';
  }
}

export interface HandshakeOptions {
  /** Raw (unparsed) Agent Card the responder advertises. */
  readonly responderCard: unknown;
  /** Public key used to verify the responder's card signature. */
  readonly responderPublicKey: KeyLike;
  /** Methods the initiator wants to use this session. */
  readonly desiredMethods: readonly string[];
  /** Protocol versions the initiator supports (highest-preferred first). */
  readonly supportedVersions?: readonly A2AProtocolVersion[];
  /** OAuth2 client already configured against the responder's token endpoint. */
  readonly oauthClient: OAuth2Client;
}

/**
 * Perform the full A2A handshake and return an authenticated {@link Session}.
 * Throws {@link HandshakeError} if trust cannot be established or no common
 * protocol version / capability set exists.
 */
export async function performHandshake(opts: HandshakeOptions): Promise<Session> {
  // 1 + 2: DISCOVER & VERIFY the responder's signed agent card.
  let peer: AgentCard;
  try {
    peer = await verifySignedAgentCard(opts.responderCard, opts.responderPublicKey);
  } catch (e) {
    throw new HandshakeError(`Could not verify responder agent card: ${(e as Error).message}`, 'CARD_UNTRUSTED');
  }

  // 3: NEGOTIATE protocol version (intersection, prefer initiator order).
  const supported = opts.supportedVersions ?? A2A_PROTOCOL_VERSIONS;
  const protocolVersion = supported.find((v) =>
    (A2A_PROTOCOL_VERSIONS as readonly string[]).includes(v),
  );
  if (!protocolVersion) {
    throw new HandshakeError('No common A2A protocol version', 'VERSION_MISMATCH');
  }

  // Negotiate capabilities: only methods the peer actually advertises.
  const advertised = new Set(peer.capabilities.map((c) => c.method));
  const negotiatedMethods = opts.desiredMethods.filter((m) => advertised.has(m));
  const unsupported = opts.desiredMethods.filter((m) => !advertised.has(m));
  if (unsupported.length > 0) {
    throw new HandshakeError(
      `Peer does not support methods: ${unsupported.join(', ')}`,
      'CAPABILITY_MISMATCH',
    );
  }

  // 4: AUTHENTICATE — prime a token so the first call doesn't pay the latency.
  try {
    await opts.oauthClient.getAccessToken();
  } catch (e) {
    throw new HandshakeError(`Failed to obtain access token: ${(e as Error).message}`, 'AUTH_FAILED');
  }

  return {
    peer,
    protocolVersion,
    negotiatedMethods,
    getToken: () => opts.oauthClient.getAccessToken(),
  };
}

let rpcCounter = 0;
/** Build a JSON-RPC 2.0 request envelope for an A2A method call. */
export function buildRpcRequest<P>(method: string, params: P): JsonRpcRequest<P> {
  return { jsonrpc: '2.0', id: `rpc-${Date.now()}-${rpcCounter++}`, method, params };
}
