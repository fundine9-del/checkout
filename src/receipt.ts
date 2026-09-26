import QRCode from 'qrcode';
import { supabase } from './db.js';
import { money, toNumber } from './helpers.js';
import type { Order, OrderItem, Receipt, ReceiptLine, ReceiptVatRow } from './types.js';

interface StoreMeta {
  name: string | null;
  vat_number: string | null;
  pin: string | null;
  till_number: string | null;
}

async function getStoreMeta(storeId: string | null): Promise<StoreMeta> {
  const empty: StoreMeta = { name: null, vat_number: null, pin: null, till_number: null };
  if (!storeId) return empty;
  const { data } = await supabase
    .from('supermarkets')
    .select('name, vat_number, pin, till_number')
    .eq('id', storeId)
    .maybeSingle();
  if (!data) return empty;
  return {
    name: data.name ? String(data.name) : null,
    vat_number: data.vat_number ? String(data.vat_number) : null,
    pin: data.pin ? String(data.pin) : null,
    till_number: data.till_number ? String(data.till_number) : null,
  };
}

/** Normalises a line's VAT rate (percent); missing data falls back to 16. */
function vatRateOf(line: OrderItem): number {
  const raw = toNumber(line.vat_rate);
  return Number.isFinite(raw) ? raw : 16;
}

/**
 * Groups the order's lines by VAT rate and computes the inclusive-VAT
 * breakdown for each: vatable + vat = the group's line amount (prices are
 * inclusive of VAT). Codes are assigned A, B, C… ordered by rate, highest
 * first, so the standard rate is usually A.
 */
function vatRowsFor(items: OrderItem[]): ReceiptVatRow[] {
  const byRate = new Map<number, number>();
  for (const line of items) {
    const rate = vatRateOf(line);
    byRate.set(rate, (byRate.get(rate) ?? 0) + toNumber(line.price) * toNumber(line.quantity));
  }
  const rates = [...byRate.keys()].sort((a, b) => b - a);
  return rates.map((rate, i) => {
    const amount = money(byRate.get(rate) ?? 0);
    const vatable = money(amount / (1 + rate / 100));
    return { code: String.fromCharCode(65 + i), rate, vatable, vat: money(amount - vatable) };
  });
}

/**
 * Builds the fiscal receipt payload for a paid order — KRA-style layout data:
 * store identity (name, VAT #, PIN, till), per-line price + VAT rate + tax
 * code, a VAT summary table, optional cash tender/change, and a reprint QR.
 * Shared by the customer checkout, the dashboard re-print endpoint, and the
 * receipt printers feature (payload snapshot in print_jobs).
 */
export async function buildReceipt(
  order: Order,
  items: OrderItem[],
  total: number,
  paymentMethod: string,
  tendered: number | null = null,
): Promise<Receipt> {
  const store = await getStoreMeta(order.store_id);
  const vatRows = vatRowsFor(items);
  const codeForRate = new Map<number, string>(vatRows.map((row) => [row.rate, row.code]));

  const receiptItems: ReceiptLine[] = items.map((line) => {
    const rate = vatRateOf(line);
    return {
      barcode: line.barcode,
      name: line.name,
      quantity: toNumber(line.quantity),
      unit_price: money(toNumber(line.price)),
      line_total: money(toNumber(line.price) * toNumber(line.quantity)),
      vat_rate: rate,
      tax_code: codeForRate.get(rate) ?? 'A',
    };
  });

  const qrData = await QRCode.toDataURL(`checkout-receipt:${order.id}`, {
    width: 240,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });

  return {
    store_name: store.name,
    vat_number: store.vat_number,
    pin: store.pin,
    till_number: store.till_number,
    customer_name: order.customer_name,
    order_id: order.id,
    payment_method: paymentMethod,
    total,
    tendered,
    change: tendered === null ? null : money(tendered - total),
    paid_at: order.paid_at,
    items: receiptItems,
    vat_rows: vatRows,
    item_count: items.reduce((sum, line) => sum + toNumber(line.quantity), 0),
    qr_data: qrData,
  };
}