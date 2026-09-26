import type { Item, Order, OrderItem } from './types.js';

/** PostgREST sends numeric columns as strings; normalise them. */
export function toNumber(value: unknown): number {
  return typeof value === 'string' ? Number.parseFloat(value) : Number(value);
}

export function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeTotal(items: OrderItem[]): number {
  return money(items.reduce((sum, it) => sum + toNumber(it.price) * it.quantity, 0));
}

export function readablePrice(value: number): string {
  return value.toLocaleString('en-KE', { style: 'currency', currency: 'KES' });
}

type AnyRow = Record<string, unknown>;

export function normItem(row: AnyRow): Item {
  return {
    ...row,
    price: toNumber(row.price),
    stock: toNumber(row.stock),
    vat_rate: toNumber(row.vat_rate),
  } as unknown as Item;
}

export function normOrder(row: AnyRow): Order {
  return {
    ...row,
    total: toNumber(row.total),
  } as unknown as Order;
}

export function normOrderItem(row: AnyRow): OrderItem {
  return {
    ...row,
    price: toNumber(row.price),
    vat_rate: toNumber(row.vat_rate),
  } as unknown as OrderItem;
}