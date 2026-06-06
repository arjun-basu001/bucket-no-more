/**
 * Example: end-to-end authentication & authorization.
 *
 * Run with:  npm run demo:auth
 *
 * Demonstrates:
 *   1. An authorization server minting an agent access token via OAuth2
 *      client-credentials, with scope down-scoping.
 *   2. A resource server (AuthGateway) verifying the token, enforcing scopes,
 *      and rate limiting per agent.
 *   3. Signing an Agent Card and verifying it (and detecting tampering).
 */

import { generateSigningKeys } from '../src/auth/jwt.js';
import { AuthorizationServer, OAuth2Client } from '../src/auth/oauth2.js';
import { TokenBucketRateLimiter } from '../src/auth/rate-limiter.js';
import { AuthGateway } from '../src/auth/gateway.js';
import { createSignedAgentCard, verifySignedAgentCard } from '../src/agent-card/agent-card.js';

async function run() {
  const ISSUER = 'https://auth.fleetfoot.example';
  const AUDIENCE = 'https://api.fleetfoot.example';

  // --- Authorization server setup ---
  const asKeys = await generateSigningKeys();
  const authServer = new AuthorizationServer(asKeys.privateKey, { issuer: ISSUER, defaultTtlSeconds: 300 });
  authServer.registerClient({
    clientId: 'shopping-agent-001',
    clientSecretHash: await AuthorizationServer.hashSecret('s3cr3t-rotate-me'),
    allowedScopes: ['catalog:read', 'cart:write', 'checkout:execute'],
    subject: 'agent://acme/shopping-agent',
  });

  // --- Client obtains a token (client-credentials grant) ---
  const oauthClient = new OAuth2Client(() =>
    authServer.issueClientCredentials({
      clientId: 'shopping-agent-001',
      clientSecret: 's3cr3t-rotate-me',
      requestedScopes: ['catalog:read', 'checkout:execute'],
      audience: AUDIENCE,
      actForUser: 'user-arjun',
    }),
  );
  const token = await oauthClient.getAccessToken();
  console.log('\n=== OAuth2 token issued ===');
  console.log('  token (truncated):', token.slice(0, 40) + '...');

  // --- Resource server verifies, authorizes, rate limits ---
  const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 1 });
  const gateway = new AuthGateway(asKeys.publicKey, { issuer: ISSUER, audience: AUDIENCE }, limiter);

  console.log('\n=== Gateway authorization checks ===');
  const good = await gateway.authorize({
    authorizationHeader: `Bearer ${token}`,
    requiredScopes: ['checkout:execute'],
  });
  console.log('  checkout:execute allowed ->', good.ok);

  const forbidden = await gateway.authorize({
    authorizationHeader: `Bearer ${token}`,
    requiredScopes: ['payment:authorize'], // not granted
  });
  console.log('  payment:authorize allowed ->', forbidden.ok, forbidden.ok ? '' : `(${forbidden.failure.kind})`);

  console.log('\n=== Rate limiting (capacity 3) ===');
  for (let i = 1; i <= 5; i++) {
    const d = await gateway.authorize({
      authorizationHeader: `Bearer ${token}`,
      requiredScopes: ['catalog:read'],
    });
    console.log(`  request ${i}:`, d.ok ? 'allowed' : `blocked (${(d.failure as { kind: string }).kind})`);
  }

  // --- Agent card signing & tamper detection ---
  console.log('\n=== Agent card signature ===');
  const cardKeys = await generateSigningKeys();
  const card = await createSignedAgentCard(
    {
      schemaVersion: '1.0',
      id: 'agent://fleetfoot/merchant-agent',
      name: 'FleetFoot Merchant Agent',
      description: 'Sells running gear via UCP/A2A',
      endpoint: 'https://api.fleetfoot.example/a2a',
      provider: { name: 'FleetFoot Inc.', url: 'https://fleetfoot.example' },
      version: '1.0.0',
      auth: { type: 'oauth2-client-credentials', tokenEndpoint: `${ISSUER}/token`, jwksUri: `${ISSUER}/jwks`, scopes: ['catalog:read'] },
      capabilities: [
        { id: 'cat', name: 'Catalog', description: 'Browse products', method: 'ucp.catalog.search' },
        { id: 'chk', name: 'Checkout', description: 'Reserve/authorize/capture', method: 'checkout.reserve' },
      ],
    },
    cardKeys.privateKey,
    'agent://fleetfoot/merchant-agent#key-1',
  );
  const verified = await verifySignedAgentCard(card, cardKeys.publicKey);
  console.log('  verified card:', verified.name);

  // Tamper with the card and prove verification fails.
  const tampered = { ...card, endpoint: 'https://evil.example/a2a' };
  try {
    await verifySignedAgentCard(tampered, cardKeys.publicKey);
    console.log('  tamper check: FAILED to detect (bug!)');
  } catch (e) {
    console.log('  tamper detected ->', (e as Error).message);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
