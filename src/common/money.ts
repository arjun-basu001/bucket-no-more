/**
 * @module common/money
 *
 * Safe integer-based money arithmetic. All operations validate that currencies
 * match before combining values, because silently adding USD to EUR is one of
 * the most expensive bugs a multi-merchant cart can ship.
 */

import type { Money, CurrencyCode } from './types.js';

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Cannot combine money of differing currencies: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

/** Create a Money value, validating the amount is a finite integer. */
export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(`Money amount must be an integer minor unit, got ${amountMinor}`);
  }
  if (!currency || currency.length !== 3) {
    throw new TypeError(`Invalid ISO-4217 currency code: "${currency}"`);
  }
  return { amountMinor, currency: currency.toUpperCase() };
}

export const zero = (currency: CurrencyCode): Money => money(0, currency);

/** Add two money values of the same currency. */
export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

/** Multiply a money value by an integer quantity. */
export function multiply(value: Money, quantity: number): Money {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new TypeError(`Quantity must be a non-negative integer, got ${quantity}`);
  }
  return money(value.amountMinor * quantity, value.currency);
}

/** Sum an array of money values; requires a currency for the empty case. */
export function sum(values: readonly Money[], currency: CurrencyCode): Money {
  return values.reduce((acc, v) => add(acc, v), zero(currency));
}

/** Human-readable formatting, e.g. money(1099, "USD") -> "$10.99". */
export function format(value: Money, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
  }).format(value.amountMinor / 100);
}
