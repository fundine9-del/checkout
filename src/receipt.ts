import { supabase } from './db.js';
import { money } from './helpers.js';
import type { Order, OrderItem } from './types.js';

export async function getStoreName(storeId: string | null): Promise<string | null> {
  if (!storeId) return null;
  const { data } = await supabase
    .from('supermarkets')
    .select('name')
    .eq('id', storeId)
    .maybeSingle();
  return data ? String(data.name) : null;
}

/**
 * Builds the receipt payload for a paid order. Shared by the customer
 * checkout, the dashboard re-print endpoint, and partner POS ingest.
 */
export async function buildReceipt(
  order: Order,
  items: OrderItem[],
  total: number,
  paymentMethod: string,
) {
  const storeName = await getStoreName(order.store_id);
  return {
    store_name: storeName,
    customer_name: order.customer_name,
    order_id: order.id,
    payment_method: paymentMethod,
    total,
    paid_at: order.paid_at,
    items: items.map((i) => ({
      barcode: i.barcode,
      name: i.name,
      quantity: i.quantity,
      unit_price: money(i.price),
      line_total: money(i.price * i.quantity),
    })),
  };
}