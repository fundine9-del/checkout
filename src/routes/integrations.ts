import { Router, type NextFunction, type Request, type Response } from 'express';
import { supabase } from '../db.js';
import { INTEGRATION_KEY_PREFIX, verifyApiKey } from '../integration.js';
import { resolveItemByBarcode, type CatalogueItem } from '../catalogue.js';
import { buildReceipt } from '../receipt.js';
import { creditOrderPayment } from '../wallet.js';
import { computeTotal, money, normItem, normOrder, normOrderItem, toNumber } from '../helpers.js';
import type { OrderItem, PaymentMethod } from '../types.js';

/**
 * Partner integration API (/api/v1/integrations).
 *
 * This is the contract a supermarket's developers implement against — their
 * POS/integration agent pushes products, prices and stock IN to us, and
 * records completed POS sales SO the dashboard/ledger reflects real tills.
 * No direct database access is ever granted; the caller authenticates with
 * a per-store API key (sk_live_...) and every operation is scoped to that
 * store.
 */
export const integrationsRouter = Router();

const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'mobile'];

interface PartnerRequest extends Request {
  storeId?: string;
}

type PartnerHandler = (req: PartnerRequest, res: Response) => Promise<unknown>;

/** Wraps a typed async handler so Express sees a standard RequestHandler. */
function partner(handler: PartnerHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req as PartnerRequest, res).catch(next);
  };
}

/** Requires a valid partner API key; attaches the store id it was issued for. */
function requireKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const storeId = token === '' ? null : verifyApiKey(token);
  if (!storeId) {
    res.status(401).json({
      error: `A valid bearer integration API key is required (${INTEGRATION_KEY_PREFIX}...)`,
    });
    return;
  }
  (req as PartnerRequest).storeId = storeId;
  next();
}

integrationsRouter.use(requireKey);

// GET /api/v1/integrations -> who am I + what this API can do
integrationsRouter.get(
  '/',
  partner(async (req, res) => {
    const { data } = await supabase
      .from('supermarkets')
      .select('id, name')
      .eq('id', req.storeId!)
      .maybeSingle();
    res.json({
      integration: 'checkout-partner-v1',
      api_key_prefix: INTEGRATION_KEY_PREFIX,
      store: data ? { id: String(data.id), name: String(data.name) } : { id: req.storeId },
      base_url: '/api/v1/integrations',
      endpoints: [
        'GET    /',
        'GET    /products (?search=, ?category=)',
        'GET    /products/:barcode',
        'POST   /sync/products   { products: [{ barcode, name, price, stock?, category? }] }',
        'POST   /sync/inventory  { updates: [{ barcode, stock }] }',
        'POST   /orders          { customer_name?, payment_method?, items: [{ barcode, quantity }] }',
        'GET    /orders/:orderId',
      ],
    });
  }),
);

// GET /api/v1/integrations/products -> this store's catalogue (own + shared)
integrationsRouter.get(
  '/products',
  partner(async (req, res) => {
    const storeId = req.storeId!;
    const { search } = req.query as { search?: string };
    let query = supabase
      .from('items')
      .select('*')
      .or(`store_id.is.null,store_id.eq.${storeId}`)
      .order('name');
    if (search && search.trim() !== '') {
      query = query.or(`name.ilike.%${search.trim()}%,barcode.ilike.%${search.trim()}%`);
    }
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ products: (data ?? []).map(normItem) });
  }),
);

// GET /api/v1/integrations/products/:barcode
integrationsRouter.get(
  '/products/:barcode',
  partner(async (req, res) => {
    const barcode = String(req.params.barcode ?? '');
    const item = await resolveItemByBarcode(barcode, req.storeId);
    if (!item) {
      return res
        .status(404)
        .json({ error: `No item found for barcode '${barcode}' in this store` });
    }
    res.json({ product: normItem(item as unknown as Record<string, unknown>) });
  }),
);

// POST /api/v1/integrations/sync/products  { products: [...] }
// Pushes the supermarket's catalogue into our system, scoped to their store.
// New barcodes are created for the store; barcodes already owned by the store
// are updated; barcodes owned by another store / the shared catalogue are
// reported as conflicts (the global barcode is unique).
integrationsRouter.post(
  '/sync/products',
  partner(async (req, res) => {
    const storeId = req.storeId!;
    const raw = (req.body ?? {}) as { products?: unknown };
    if (!Array.isArray(raw.products) || raw.products.length === 0) {
      return res.status(400).json({ error: 'products must be a non-empty array' });
    }

    const created: string[] = [];
    const updated: string[] = [];
    const conflicts: { barcode: string; reason: string }[] = [];

    for (const entry of raw.products) {
      const e = (entry ?? {}) as Record<string, unknown>;
      const barcode = typeof e.barcode === 'string' ? e.barcode.trim() : '';
      const name = typeof e.name === 'string' ? e.name.trim() : '';
      const price = money(toNumber(e.price));
      const category =
        typeof e.category === 'string' && e.category.trim() !== '' ? e.category.trim() : null;
      if (barcode === '' || name === '' || !Number.isFinite(price) || price < 0) {
        conflicts.push({
          barcode: barcode || '(missing barcode)',
          reason: 'barcode/name are required and price must be a number >= 0',
        });
        continue;
      }
      const stock = e.stock === undefined ? 0 : toNumber(e.stock);
      if (!Number.isInteger(stock) || stock < 0) {
        conflicts.push({ barcode, reason: 'stock must be a non-negative integer' });
        continue;
      }

      const { data: existing, error: findErr } = await supabase
        .from('items')
        .select('id, store_id')
        .eq('barcode', barcode)
        .maybeSingle();
      if (findErr) {
        conflicts.push({ barcode, reason: findErr.message });
        continue;
      }

      if (existing) {
        if (String(existing.store_id ?? '') === storeId) {
          const { error } = await supabase
            .from('items')
            .update({ name, price, stock, category, updated_at: new Date().toISOString() })
            .eq('id', String(existing.id));
          if (error) conflicts.push({ barcode, reason: error.message });
          else updated.push(barcode);
        } else {
          conflicts.push({
            barcode,
            reason: 'barcode already belongs to another store or the shared catalogue',
          });
        }
      } else {
        const { error } = await supabase.from('items').insert({
          barcode,
          name,
          price,
          stock,
          category,
          store_id: storeId,
        });
        if (error) conflicts.push({ barcode, reason: error.message });
        else created.push(barcode);
      }
    }

    res.json({
      created,
      updated,
      conflicts,
      summary: { created: created.length, updated: updated.length, conflicts: conflicts.length },
    });
  }),
);

// POST /api/v1/integrations/sync/inventory  { updates: [{ barcode, stock }] }
// Stock-level-only updates for products the store owns.
integrationsRouter.post(
  '/sync/inventory',
  partner(async (req, res) => {
    const storeId = req.storeId!;
    const raw = (req.body ?? {}) as { updates?: unknown };
    if (!Array.isArray(raw.updates) || raw.updates.length === 0) {
      return res.status(400).json({ error: 'updates must be a non-empty array' });
    }

    const updated: string[] = [];
    const skipped: { barcode: string; reason: string }[] = [];

    for (const entry of raw.updates) {
      const e = (entry ?? {}) as Record<string, unknown>;
      const barcode = typeof e.barcode === 'string' ? e.barcode.trim() : '';
      const stock = toNumber(e.stock);
      if (barcode === '' || !Number.isInteger(stock) || stock < 0) {
        skipped.push({
          barcode: barcode || '(missing barcode)',
          reason: 'stock must be a non-negative integer',
        });
        continue;
      }
      const { data: existing, error } = await supabase
        .from('items')
        .select('id, store_id')
        .eq('barcode', barcode)
        .maybeSingle();
      if (error) {
        skipped.push({ barcode, reason: error.message });
        continue;
      }
      if (!existing) {
        skipped.push({ barcode, reason: 'not found in this store' });
        continue;
      }
      if (String(existing.store_id ?? '') !== storeId) {
        skipped.push({ barcode, reason: 'not owned by this store' });
        continue;
      }
      const { error: updErr } = await supabase
        .from('items')
        .update({ stock, updated_at: new Date().toISOString() })
        .eq('id', String(existing.id));
      if (updErr) skipped.push({ barcode, reason: updErr.message });
      else updated.push(barcode);
    }

    res.json({ updated, skipped, summary: { updated: updated.length, skipped: skipped.length } });
  }),
);

// POST /api/v1/integrations/orders  { customer_name?, payment_method?, items: [...] }
// Records a sale that already happened at the supermarket's POS. Creates a
// PAID order scoped to the store, decrements stock, credits the store's
// wallet and returns an order + receipt — so the dashboard Sales/Overview
// reflect real till transactions synced from their system.
integrationsRouter.post(
  '/orders',
  partner(async (req, res) => {
    const storeId = req.storeId!;
    const b = (req.body ?? {}) as Record<string, unknown>;

    const paymentMethod = (
      typeof b.payment_method === 'string' && b.payment_method.trim() !== ''
        ? b.payment_method.trim()
        : 'cash'
    ) as PaymentMethod;
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res
        .status(400)
        .json({ error: `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}` });
    }

    const rawItems = b.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res
        .status(400)
        .json({ error: 'items must be a non-empty array of { barcode, quantity }' });
    }

    const customerName =
      typeof b.customer_name === 'string' && b.customer_name.trim() !== ''
        ? b.customer_name.trim().slice(0, 200)
        : null;

    // Resolve every line against THIS store's catalogue up-front, so nothing
    // is mutated if any barcode is unknown here.
    const lines: { item: CatalogueItem; quantity: number }[] = [];
    const unknown: string[] = [];
    for (const entry of rawItems) {
      const e = (entry ?? {}) as Record<string, unknown>;
      const barcode = typeof e.barcode === 'string' ? e.barcode.trim() : '';
      const quantity = toNumber(e.quantity);
      if (barcode === '' || !Number.isInteger(quantity) || quantity < 1) {
        return res
          .status(400)
          .json({ error: `quantity must be a positive integer (barcode '${barcode || '(missing)'}')` });
      }
      const item = await resolveItemByBarcode(barcode, storeId);
      if (!item) {
        unknown.push(barcode);
        continue;
      }
      lines.push({ item, quantity });
    }
    if (unknown.length > 0) {
      return res.status(400).json({
        error: `Unknown barcodes in this store's catalogue: ${unknown.join(', ')}`,
        unknown,
      });
    }

    // Merge duplicate barcodes in the payload.
    const byItem = new Map<string, { item: CatalogueItem; quantity: number }>();
    for (const line of lines) {
      const key = line.item.id;
      const existing = byItem.get(key);
      if (existing) existing.quantity += line.quantity;
      else byItem.set(key, line);
    }

    // 1) Stock check before mutating anything.
    for (const { item, quantity } of byItem.values()) {
      if (item.stock < quantity) {
        return res.status(409).json({
          error: `Insufficient stock for '${item.name}': only ${item.stock} left (need ${quantity})`,
        });
      }
    }

    const total = money(
      Array.from(byItem.values()).reduce(
        (sum, { item, quantity }) => sum + item.price * quantity,
        0,
      ),
    );

    const paidAt =
      typeof b.paid_at === 'string' && !Number.isNaN(Date.parse(b.paid_at))
        ? new Date(b.paid_at).toISOString()
        : new Date().toISOString();

    // 2) Create the order (already paid).
    const { data: orderRow, error: orderErr } = await supabase
      .from('orders')
      .insert({
        customer_name: customerName,
        status: 'paid',
        payment_method: paymentMethod,
        total,
        store_id: storeId,
        paid_at: paidAt,
      })
      .select()
      .single();
    if (orderErr) return res.status(500).json({ error: orderErr.message });

    const order = normOrder(orderRow as unknown as Record<string, unknown>);

    // 3) Order lines.
    for (const { item, quantity } of byItem.values()) {
      const { error } = await supabase.from('order_items').insert({
        order_id: order.id,
        item_id: item.id,
        barcode: item.barcode,
        name: item.name,
        price: money(item.price),
        quantity,
      });
      if (error) throw error;
    }

    // 4) Decrement stock (guarded like the till checkout).
    for (const { item, quantity } of byItem.values()) {
      const { data: stockRow } = await supabase
        .from('items')
        .select('stock')
        .eq('id', item.id)
        .maybeSingle();
      const current = stockRow ? toNumber(stockRow.stock) : 0;
      const { error } = await supabase
        .from('items')
        .update({ stock: current - quantity, updated_at: new Date().toISOString() })
        .eq('id', item.id)
        .gte('stock', quantity)
        .select('id')
        .single();
      if (error) throw error;
    }

    // 5) Credit the store's wallet (same ledger as the till).
    await creditOrderPayment(storeId, order.id, total, paymentMethod).catch((err) => {
      console.error(`Wallet credit failed for ingested order ${order.id}:`, err);
    });

    const { data: lineRows, error: lineErr } = await supabase
      .from('order_items')
      .select('*')
      .eq('order_id', order.id)
      .order('created_at');
    if (lineErr) return res.status(500).json({ error: lineErr.message });
    const items = (lineRows ?? []).map(normOrderItem) as OrderItem[];

    res.status(201).json({
      order: { ...order, items, total },
      receipt: await buildReceipt(order, items, total, paymentMethod),
    });
  }),
);

// GET /api/v1/integrations/orders/:orderId -> one of THIS store's orders
integrationsRouter.get(
  '/orders/:orderId',
  partner(async (req, res) => {
    const storeId = req.storeId!;
    const { data: orderRow, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', req.params.orderId)
      .eq('store_id', storeId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!orderRow) return res.status(404).json({ error: 'Order not found in this store' });

    const order = normOrder(orderRow as unknown as Record<string, unknown>);
    const { data: lineRows, error: lineErr } = await supabase
      .from('order_items')
      .select('*')
      .eq('order_id', order.id)
      .order('created_at');
    if (lineErr) return res.status(500).json({ error: lineErr.message });
    const items = (lineRows ?? []).map(normOrderItem);
    res.json({ order: { ...order, items, total: computeTotal(items) } });
  }),
);