/**
 * End-to-end demo: the full agentic-commerce flow in one script.
 *
 * Run with:  npm run demo
 *
 * Flow:
 *   1. Two merchants publish UCP catalogs and signed Agent Cards.
 *   2. A shopping agent DISCOVERS + VERIFIES each merchant card (A2A handshake)
 *      and AUTHENTICATES via OAuth2 client-credentials.
 *   3. The shopping agent browses UCP catalogs and assembles a Universal Cart.
 *   4. Each merchant's API guards calls with the AuthGateway (authn/z + rate limit).
 *   5. The MultiMerchantCheckoutOrchestrator commits the cart across merchants,
 *      with full rollback semantics if anything fails.
 */

import { generateSigningKeys } from '../src/auth/jwt.js';
import { AuthorizationServer, OAuth2Client } from '../src/auth/oauth2.js';
import { TokenBucketRateLimiter } from '../src/auth/rate-limiter.js';
import { AuthGateway } from '../src/auth/gateway.js';
import { createSignedAgentCard } from '../src/agent-card/agent-card.js';
import { performHandshake } from '../src/a2a/handshake.js';
import { UCPCatalog, normalizeToUCP } from '../src/ucp/catalog.js';
import { buildUniversalCart, totalUnits } from '../src/checkout/cart-aggregator.js';
import { MultiMerchantCheckoutOrchestrator } from '../src/checkout/orchestrator.js';
import type { MerchantAdapter } from '../src/checkout/merchant-adapter.js';
import type { CartLineItem, MerchantId } from '../src/common/types.js';
import { format } from '../src/common/money.js';
import { MockMerchantAdapter } from '../examples/mock-merchant.js';

const line = (s: string) => console.log(s);
const rule = () => line('─'.repeat(64));

interface Merchant {
  readonly id: string;
  readonly name: string;
  readonly issuer: string;
  readonly audience: string;
  readonly catalog: UCPCatalog;
  readonly card: unknown;
  readonly cardPublicKey: Awaited<ReturnType<typeof generateSigningKeys>>['publicKey'];
  readonly authServer: AuthorizationServer;
  readonly asPublicKey: Awaited<ReturnType<typeof generateSigningKeys>>['publicKey'];
  readonly gateway: AuthGateway;
}

async function setupMerchant(args: {
  id: string;
  name: string;
  products: Array<Record<string, unknown>>;
}): Promise<Merchant> {
  const issuer = `https://auth.${args.id}.example`;
  const audience = `https://api.${args.id}.example`;

  // Catalog
  const catalog = new UCPCatalog(args.id);
  for (const raw of args.products) catalog.upsert(normalizeToUCP(raw, args.id));

  // Agent card signing keys
  const cardKeys = await generateSigningKeys();
  const card = await createSignedAgentCard(
    {
      schemaVersion: '1.0',
      id: `agent://${args.id}/merchant-agent`,
      name: args.name,
      description: `${args.name} merchant agent (UCP + A2A)`,
      endpoint: `${audience}/a2a`,
      provider: { name: args.name },
      version: '1.0.0',
      auth: { type: 'oauth2-client-credentials', tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`, scopes: ['catalog:read', 'checkout:execute'] },
      capabilities: [
        { id: 'search', name: 'Catalog search', description: 'UCP catalog query', method: 'ucp.catalog.search' },
        { id: 'reserve', name: 'Reserve', description: 'Begin checkout', method: 'checkout.reserve' },
      ],
    },
    cardKeys.privateKey,
    `agent://${args.id}/merchant-agent#key-1`,
  );

  // Authorization server + gateway
  const asKeys = await generateSigningKeys();
  const authServer = new AuthorizationServer(asKeys.privateKey, { issuer });
  authServer.registerClient({
    clientId: 'shopping-agent-001',
    clientSecretHash: await AuthorizationServer.hashSecret('s3cr3t'),
    allowedScopes: ['catalog:read', 'cart:write', 'checkout:execute'],
    subject: 'agent://acme/shopping-agent',
  });
  const gateway = new AuthGateway(
    asKeys.publicKey,
    { issuer, audience },
    new TokenBucketRateLimiter({ capacity: 20, refillPerSecond: 10 }),
  );

  return { id: args.id, name: args.name, issuer, audience, catalog, card, cardPublicKey: cardKeys.publicKey, authServer, asPublicKey: asKeys.publicKey, gateway };
}

async function main() {
  rule();
  line('  bucket-no-more — end-to-end agentic commerce demo');
  rule();

  // 1. Stand up two merchants.
  const audiophile = await setupMerchant({
    id: 'audiophile',
    name: 'Audiophile Co.',
    products: [
      { id: 'sku-aurora-headphones', name: 'Aurora Headphones', price: 249.99, currency: 'USD', category: ['Electronics', 'Headphones'], availability: 'in_stock' },
      { id: 'sku-usb-c-cable', name: 'USB-C Cable', price: 14.99, currency: 'USD', category: ['Electronics', 'Accessories'] },
    ],
  });
  const roastery = await setupMerchant({
    id: 'roastery',
    name: 'The Roastery',
    products: [
      { id: 'sku-espresso-beans', name: 'Single-Origin Beans 1kg', price: 32.0, currency: 'USD', category: ['Grocery', 'Coffee'] },
    ],
  });
  const merchants = [audiophile, roastery];

  // 2. Shopping agent performs A2A handshake with each merchant.
  line('\n[1] A2A discovery + trust handshake');
  for (const m of merchants) {
    const oauthClient = new OAuth2Client(() =>
      m.authServer.issueClientCredentials({
        clientId: 'shopping-agent-001',
        clientSecret: 's3cr3t',
        requestedScopes: ['catalog:read', 'checkout:execute'],
        audience: m.audience,
        actForUser: 'user-arjun',
      }),
    );
    const session = await performHandshake({
      responderCard: m.card,
      responderPublicKey: m.cardPublicKey,
      desiredMethods: ['ucp.catalog.search', 'checkout.reserve'],
      oauthClient,
    });
    line(`    ✓ verified ${session.peer.name} | proto ${session.protocolVersion} | methods: ${session.negotiatedMethods.join(', ')}`);

    // 4. Demonstrate the gateway guarding a catalog call with the session token.
    const decision = await m.gateway.authorize({
      authorizationHeader: `Bearer ${await session.getToken()}`,
      requiredScopes: ['catalog:read'],
    });
    line(`    ✓ gateway authorized catalog:read for ${m.name}: ${decision.ok}`);
  }

  // 3. Browse UCP catalogs + assemble Universal Cart.
  line('\n[2] Browsing UCP catalogs and assembling the Universal Cart');
  const items: CartLineItem[] = [
    audiophile.catalog.toLineItem('sku-aurora-headphones', 1),
    audiophile.catalog.toLineItem('sku-usb-c-cable', 2),
    roastery.catalog.toLineItem('sku-espresso-beans', 3),
  ];
  const cartResult = buildUniversalCart({ cartId: 'cart-e2e-001', userId: 'user-arjun', displayCurrency: 'USD', items });
  if (!cartResult.ok) throw new Error(cartResult.error.message);
  const cart = cartResult.value;
  for (const sc of cart.subCarts) line(`    • ${sc.merchantId}: subtotal ${format(sc.subtotal)}`);
  line(`    total units: ${totalUnits(cart)}`);

  // 5. Orchestrate the multi-merchant checkout.
  line('\n[3] Multi-merchant checkout orchestration');
  const adapters = new Map<MerchantId, MerchantAdapter>();
  for (const m of merchants) {
    adapters.set(m.id, new MockMerchantAdapter({ merchantId: m.id, feesMinor: 599, latencyMs: 20 }));
  }
  const orchestrator = new MultiMerchantCheckoutOrchestrator(adapters);
  const outcome = await orchestrator.checkout({ cart, userId: cart.userId, paymentMandate: 'ap2-mandate-e2e' });

  if (outcome.ok) {
    line(`    status: ${outcome.value.status}`);
    for (const [id, code] of Object.entries(outcome.value.confirmations)) {
      line(`    ✓ ${id} confirmed: ${code}`);
    }
  }

  rule();
  line('  Demo complete.');
  rule();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
