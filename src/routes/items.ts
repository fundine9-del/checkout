import { Router, type RequestHandler, type Response } from 'express';
import { supabase } from '../db.js';
import { resolveItemByBarcode } from '../catalogue.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { getStoreByOwner } from '../stores.js';
import { money, normItem, toNumber } from '../helpers.js';
import type { ItemInput, Supermarket } from '../types.js';

export const itemsRouter = Router();

type AuthedHandler = (req: AuthedRequest, res: Response) => Promise<Response | void>;

/** Wraps a typed async handler so Express sees a standard RequestHandler. */
function authed(handler: AuthedHandler): RequestHandler {
  return (req, res, next) => {
    handler(req as AuthedRequest, res).catch(next);
  };
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

/** Parse + validate the JSON body of an item create/update. Returns null if invalid. */
function parseItemInput(body: unknown, res: Response): ItemInput | null {
  const b = (body ?? {}) as Partial<Record<string, unknown>>;
  if (typeof b.barcode !== 'string' || b.barcode.trim() === '') {
    res.status(400).json({ error: 'barcode is required (string)' });
    return null;
  }
  if (typeof b.name !== 'string' || b.name.trim() === '') {
    res.status(400).json({ error: 'name is required (string)' });
    return null;
  }
  const price = toNumber(b.price);
  if (!Number.isFinite(price) || price < 0) {
    res.status(400).json({ error: 'price must be a number >= 0' });
    return null;
  }
  const stock = b.stock === undefined ? 0 : toNumber(b.stock);
  if (!Number.isInteger(stock) || stock < 0) {
    res.status(400).json({ error: 'stock must be a non-negative integer' });
    return null;
  }
  const vatRate = b.vat_rate === undefined ? 16 : toNumber(b.vat_rate);
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) {
    res.status(400).json({ error: 'vat_rate must be a percentage between 0 and 100' });
    return null;
  }
  const category = typeof b.category === 'string' && b.category.trim() !== '' ? b.category.trim() : null;
  return {
    barcode: b.barcode.trim(),
    name: b.name.trim(),
    price: money(price),
    stock,
    vat_rate: vatRate,
    category,
  };
}

// The catalogue is public to READ (list + barcode lookup — legacy scanner
// clients and the Flutter app depend on those). WRITES require a supermarket
// session JWT and are scoped to the caller's OWN products, so nobody can
// tamper with prices in the shared base catalogue (store_id IS NULL) through
// this API. Store-owned product management lives in /api/supermarkets/me/items.

// GET /api/items                 -> list all, ?search= filters by name/barcode
// GET /api/items/barcode/:code   -> single item by barcode (the scan endpoint)
// POST /api/items                -> add a product to MY store (store JWT)
// PATCH /api/items/:id           -> update MY product (store JWT)
// DELETE /api/items/:id          -> remove MY product (store JWT)

itemsRouter.get('/', async (req, res) => {
  const { search, category } = req.query as { search?: string; category?: string };
  let query = supabase.from('items').select('*').order('name');
  if (search && search.trim() !== '') {
    query = query.or(`name.ilike.%${search.trim()}%,barcode.ilike.%${search.trim()}%`);
  }
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  const items = (data ?? []).map(normItem);
  res.json({ items, count: items.length });
});

itemsRouter.get('/barcode/:barcode', async (req, res) => {
  const { barcode } = req.params;
  // Optional ?store=<id> scopes the lookup like the cart does (own products +
  // shared base catalogue); without it the lookup stays global for legacy
  // scanner clients.
  const { store } = req.query as { store?: string };
  const storeId = store && store.trim() !== '' ? store.trim() : null;
  const item = await resolveItemByBarcode(barcode, storeId);
  if (!item) return res.status(404).json({ error: `No item found for barcode '${barcode}'` });
  res.json({ item: normItem(item as unknown as Record<string, unknown>) });
});

itemsRouter.post(
  '/',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;
    const input = parseItemInput(req.body, res);
    if (!input) return;
    const { data, error } = await supabase
      .from('items')
      .insert({ ...input, store_id: store.id, updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) return res.status(409).json({ error: error.message });
    res.status(201).json({ item: normItem(data) });
  }),
);

itemsRouter.patch(
  '/:id',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    const { data: existing, error: fetchError } = await supabase
      .from('items')
      .select('id, store_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError) return res.status(500).json({ error: fetchError.message });
    if (!existing) return res.status(404).json({ error: 'Item not found' });
    if (existing.store_id !== store.id) {
      return res.status(403).json({ error: 'You can only edit products you added' });
    }

    const input = parseItemInput(req.body, res);
    if (!input) return;
    const { data, error } = await supabase
      .from('items')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: normItem(data) });
  }),
);

itemsRouter.delete(
  '/:id',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    const { data: existing, error: fetchError } = await supabase
      .from('items')
      .select('id, store_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError) return res.status(500).json({ error: fetchError.message });
    if (!existing) return res.status(404).json({ error: 'Item not found' });
    if (existing.store_id !== store.id) {
      return res.status(403).json({ error: 'You can only delete products you added' });
    }

    const { error } = await supabase.from('items').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ deleted: req.params.id });
  }),
);