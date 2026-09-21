import { Router, type RequestHandler, type Response } from 'express';
import { supabase } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { getStoreByOwner } from '../stores.js';
import { getWalletForStore, recentTransactions } from '../wallet.js';
import { INTEGRATION_KEY_PREFIX, issueApiKey } from '../integration.js';
import { money, normItem, normOrder, normOrderItem, toNumber } from '../helpers.js';
import type { Supermarket } from '../types.js';

export const supermarketsRouter = Router();

// Every route below needs a valid Supabase session JWT.
supermarketsRouter.use(requireAuth);

type AuthedHandler = (req: AuthedRequest, res: Response) => Promise<void>;

/** Wraps a typed async handler so Express sees a standard RequestHandler. */
function authed(handler: AuthedHandler): RequestHandler {
  return (req, res, next) => {
    handler(req as AuthedRequest, res).catch(next);
  };
}

function normStore(row: Record<string, unknown>): Supermarket {
  return row as unknown as Supermarket;
}

/** Resolves the caller's supermarket or 404s. */
async function requireStore(req: AuthedRequest, res: Response): Promise<Supermarket | null> {
  const store = await getStoreByOwner(req.authUser.id);
  if (!store) {
    res.status(404).json({ error: 'No supermarket registered for this account' });
    return null;
  }
  return store;
}

// POST /api/supermarkets { name }  -> register my supermarket (signup step 2)
supermarketsRouter.post(
  '/',
  authed(async (req, res) => {
    const existing = await getStoreByOwner(req.authUser.id);
    if (existing) {
      res.status(409).json({ error: 'This account already has a supermarket' });
      return;
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const { data, error } = await supabase
      .from('supermarkets')
      .insert({ owner_id: req.authUser.id, name: name.slice(0, 120) })
      .select()
      .single();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(201).json({ supermarket: normStore(data) });
  }),
);

// GET /api/supermarkets/me
supermarketsRouter.get(
  '/me',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (store) res.json({ supermarket: store });
  }),
);

// GET /api/supermarkets/me/integration -> the store's partner API key + docs
supermarketsRouter.get(
  '/me/integration',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    res.json({
      store_id: store.id,
      store_name: store.name,
      api_key: issueApiKey(store.id),
      key_prefix: INTEGRATION_KEY_PREFIX,
      base_url: '/api/v1/integrations',
      auth_header: 'Authorization: Bearer <api_key>',
      endpoints: [
        'GET    /',
        'GET    /products (?search=, ?category=)',
        'GET    /products/:barcode',
        'POST   /sync/products   (push catalogue)',
        'POST   /sync/inventory  (push stock levels)',
        'POST   /orders          (record a POS sale)',
        'GET    /orders/:orderId',
      ],
    });
  }),
);

// ------------------------------------------------------------ my products

// GET /api/supermarkets/me/items  -> shared catalogue + my own products
supermarketsRouter.get(
  '/me/items',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    const { search, category } = req.query as { search?: string; category?: string };
    let query = supabase
      .from('items')
      .select('*')
      .or(`store_id.is.null,store_id.eq.${store.id}`)
      .order('name');
    if (search && search.trim() !== '') {
      query = query.or(`name.ilike.%${search.trim()}%,barcode.ilike.%${search.trim()}%`);
    }
    if (category) query = query.eq('category', category);

    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({
      items: (data ?? []).map(normItem),
      my_store: { id: store.id, name: store.name },
    });
  }),
);

// POST /api/supermarkets/me/items  -> add a product to my store
supermarketsRouter.post(
  '/me/items',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.barcode !== 'string' || b.barcode.trim() === '') {
      res.status(400).json({ error: 'barcode is required' });
      return;
    }
    if (typeof b.name !== 'string' || b.name.trim() === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const price = toNumber(b.price);
    if (!Number.isFinite(price) || price < 0) {
      res.status(400).json({ error: 'price must be a number >= 0' });
      return;
    }
    const stock = b.stock === undefined ? 0 : toNumber(b.stock);
    if (!Number.isInteger(stock) || stock < 0) {
      res.status(400).json({ error: 'stock must be a non-negative integer' });
      return;
    }

    const { data, error } = await supabase
      .from('items')
      .insert({
        barcode: b.barcode.trim(),
        name: b.name.trim(),
        price: money(price),
        stock,
        category:
          typeof b.category === 'string' && b.category.trim() !== ''
            ? b.category.trim()
            : null,
        store_id: store.id,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) {
      // e.g. barcode already exists in the shared catalogue
      res.status(409).json({ error: error.message });
      return;
    }
    res.status(201).json({ item: normItem(data) });
  }),
);

// PATCH /api/supermarkets/me/items/:id  -> update one of my products
supermarketsRouter.patch(
  '/me/items/:id',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    const { data: existing, error: fetchError } = await supabase
      .from('items')
      .select('id, store_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError) {
      res.status(500).json({ error: fetchError.message });
      return;
    }
    if (!existing) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    if (existing.store_id !== store.id) {
      res.status(403).json({ error: 'You can only edit products you added' });
      return;
    }

    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof b.name === 'string' && b.name.trim() !== '') patch.name = b.name.trim();
    if (
      b.price !== undefined &&
      Number.isFinite(toNumber(b.price)) &&
      toNumber(b.price) >= 0
    ) {
      patch.price = money(toNumber(b.price));
    }
    if (b.stock !== undefined) {
      const stock = toNumber(b.stock);
      if (!Number.isInteger(stock) || stock < 0) {
        res.status(400).json({ error: 'stock must be a non-negative integer' });
        return;
      }
      patch.stock = stock;
    }
    if (b.category !== undefined) {
      patch.category =
        typeof b.category === 'string' && b.category.trim() !== ''
          ? b.category.trim()
          : null;
    }

    const { data, error } = await supabase
      .from('items')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ item: normItem(data) });
  }),
);

// DELETE /api/supermarkets/me/items/:id  -> remove one of my products
supermarketsRouter.delete(
  '/me/items/:id',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    const { data: existing, error: fetchError } = await supabase
      .from('items')
      .select('id, store_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError) {
      res.status(500).json({ error: fetchError.message });
      return;
    }
    if (!existing) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    if (existing.store_id !== store.id) {
      res.status(403).json({ error: 'You can only delete products you added' });
      return;
    }

    const { error } = await supabase.from('items').delete().eq('id', req.params.id);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ deleted: req.params.id });
  }),
);

// ------------------------------------------------------------------ sales

// GET /api/supermarkets/me/sales  -> paid orders for my store, newest first
supermarketsRouter.get(
  '/me/sales',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('store_id', store.id)
      .eq('status', 'paid')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const sales = (orders ?? []).map(normOrder);
    const ids = sales.map((o) => o.id);
    const linesByOrder = new Map<string, ReturnType<typeof normOrderItem>[]>();
    if (ids.length > 0) {
      const { data: lines, error: linesError } = await supabase
        .from('order_items')
        .select('*')
        .in('order_id', ids);
      if (linesError) {
        res.status(500).json({ error: linesError.message });
        return;
      }
      for (const line of lines ?? []) {
        const row = normOrderItem(line);
        const list = linesByOrder.get(row.order_id) ?? [];
        list.push(row);
        linesByOrder.set(row.order_id, list);
      }
    }

    res.json({
      sales: sales.map((sale) => ({ ...sale, items: linesByOrder.get(sale.id) ?? [] })),
    });
  }),
);

// GET /api/supermarkets/me/stats  -> earnings summary
supermarketsRouter.get(
  '/me/stats',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('store_id', store.id)
      .eq('status', 'paid');
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const sales = (orders ?? []).map(normOrder);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todaySales = sales.filter((o) => new Date(o.created_at) >= startOfToday);

    const revenue = money(sales.reduce((sum, o) => sum + o.total, 0));
    const todayRevenue = money(todaySales.reduce((sum, o) => sum + o.total, 0));

    // Top products by revenue across these orders.
    const ids = sales.map((o) => o.id);
    const byName = new Map<string, { quantity: number; revenue: number }>();
    if (ids.length > 0) {
      const { data: lines } = await supabase.from('order_items').select('*').in('order_id', ids);
      for (const line of lines ?? []) {
        const row = normOrderItem(line);
        const entry = byName.get(row.name) ?? { quantity: 0, revenue: 0 };
        entry.quantity += row.quantity;
        entry.revenue += row.price * row.quantity;
        byName.set(row.name, entry);
      }
    }
    const topProducts = [...byName.entries()]
      .map(([name, agg]) => ({ name, quantity: agg.quantity, revenue: money(agg.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // Wallet balance for the store (null if the wallets migration is pending).
    const wallet = await getWalletForStore(store.id).catch(() => null);

    res.json({
      stats: {
        revenue,
        today_revenue: todayRevenue,
        orders_count: sales.length,
        today_orders_count: todaySales.length,
        avg_order_value: sales.length > 0 ? money(revenue / sales.length) : 0,
        top_products: topProducts,
        wallet: wallet
          ? {
              balance: money(wallet.balance),
              currency: wallet.currency,
              total_in: money(wallet.total_in),
              total_out: money(wallet.total_out),
            }
          : null,
      },
    });
  }),
);

// GET /api/supermarkets/me/transactions  -> recent wallet ledger entries
supermarketsRouter.get(
  '/me/transactions',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    try {
      const transactions = await recentTransactions(store.id);
      res.json({ transactions });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to load transactions',
      });
    }
  }),
);