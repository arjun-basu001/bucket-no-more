/**
 * Example: multi-merchant checkout — happy path AND rollback path.
 *
 * Run with:  npm run demo:checkout
 *
 * Demonstrates that:
 *   - A cart spanning 3 merchants commits atomically when all succeed.
 *   - If ONE merchant fails in phase 1, the orchestrator rolls back every other
 *     merchant (void auth + cancel reservation) and the user is never charged.
 */

import { buildUniversalCart } from '../src/checkout/cart-aggregator.js';
import { MultiMerchantCheckoutOrchestrator } from '../src/checkout/orchestrator.js';
import type { MerchantAdapter } from '../src/checkout/merchant-adapter.js';
import { format } from '../src/common/money.js';
import type { CartLineItem, MerchantId } from '../src/common/types.js';
import { MockMerchantAdapter, type FailAt } from './mock-merchant.js';

function sampleItems(): CartLineItem[] {
  return [
    { productId: 'sku-aurora-headphones', merchantId: 'merchant.audiophile', title: 'Aurora Headphones', unitPrice: { amountMinor: 24999, currency: 'USD' }, quantity: 1 },
    { productId: 'sku-usb-c-cable', merchantId: 'merchant.audiophile', title: 'USB-C Cable', unitPrice: { amountMinor: 1499, currency: 'USD' }, quantity: 2 },
    { productId: 'sku-running-shoes', merchantId: 'merchant.fleetfoot', title: 'Trail Running Shoes', unitPrice: { amountMinor: 12900, currency: 'USD' }, quantity: 1 },
    { productId: 'sku-espresso-beans', merchantId: 'merchant.roastery', title: 'Single-Origin Beans 1kg', unitPrice: { amountMinor: 3200, currency: 'USD' }, quantity: 3 },
  ];
}

function buildOrchestrator(failingMerchant?: { id: MerchantId; failAt: FailAt }) {
  const adapters = new Map<MerchantId, MerchantAdapter>();
  for (const id of ['merchant.audiophile', 'merchant.fleetfoot', 'merchant.roastery']) {
    adapters.set(
      id,
      new MockMerchantAdapter({
        merchantId: id,
        feesMinor: 599,
        latencyMs: 30,
        failAt: failingMerchant?.id === id ? failingMerchant.failAt : 'none',
      }),
    );
  }
  return { orchestrator: new MultiMerchantCheckoutOrchestrator(adapters), adapters };
}

async function run() {
  const cartResult = buildUniversalCart({
    cartId: 'cart-demo-001',
    userId: 'user-arjun',
    displayCurrency: 'USD',
    items: sampleItems(),
  });
  if (!cartResult.ok) throw new Error(cartResult.error.message);
  const cart = cartResult.value;

  console.log('\n=== Universal Cart ===');
  for (const sc of cart.subCarts) {
    console.log(`  ${sc.merchantId}: ${sc.items.length} line(s), subtotal ${format(sc.subtotal)}`);
  }

  // ---- Scenario A: everything succeeds ----
  console.log('\n=== Scenario A: all merchants succeed ===');
  {
    const { orchestrator } = buildOrchestrator();
    const result = await orchestrator.checkout({
      cart,
      userId: cart.userId,
      paymentMandate: 'ap2-mandate-demo',
    });
    if (result.ok) {
      console.log('  status:', result.value.status);
      console.log('  confirmations:', result.value.confirmations);
    }
  }

  // ---- Scenario B: one merchant fails to authorize -> full rollback ----
  console.log('\n=== Scenario B: merchant.fleetfoot fails at authorize -> rollback ===');
  {
    const { orchestrator, adapters } = buildOrchestrator({ id: 'merchant.fleetfoot', failAt: 'authorize' });
    const result = await orchestrator.checkout({
      cart,
      userId: cart.userId,
      paymentMandate: 'ap2-mandate-demo',
    });
    if (result.ok) {
      console.log('  status:', result.value.status);
      console.log('  failures:', result.value.failures);
      for (const [id, adapter] of adapters) {
        console.log(`  ${id} events:`, (adapter as MockMerchantAdapter).events);
      }
    }
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
