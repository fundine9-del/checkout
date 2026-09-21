import { Router, type Response } from 'express';
import { supabase } from '../db.js';
import { money, normItem, toNumber } from '../helpers.js';
import type { ItemInput } from '../types.js';

export const itemsRouter = Router();

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
  const category = typeof b.category === 'string' && b.category.trim() !== '' ? b.category.trim() : null;
  return {
    barcode: b.barcode.trim(),
    name: b.name.trim(),
    price: money(price),
    stock,
    category,
  };
}

// GET /api/items                 -> list all, ?search= filters by name/barcode
// GET /api/items/barcode/:code   -> single item by barcode (the scan endpoint)
// POST /api/items                -> add one item
// PATCH /api/items/:id           -> update one item
// DELETE /api/items/:id          -> remove one item

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
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('barcode', barcode)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: `No item found for barcode '${barcode}'` });
  res.json({ item: normItem(data) });
});

itemsRouter.post('/', async (req, res) => {
  const input = parseItemInput(req.body, res);
  if (!input) return;
  const { data, error } = await supabase
    .from('items')
    .insert({ ...input, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) return res.status(409).json({ error: error.message });
  res.status(201).json({ item: normItem(data) });
});

itemsRouter.patch('/:id', async (req, res) => {
  const input = parseItemInput(req.body, res);
  if (!input) return;
  const { data, error } = await supabase
    .from('items')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Item not found' });
  res.json({ item: normItem(data) });
});

itemsRouter.delete('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('items')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Item not found' });
  res.json({ deleted: data.id });
});