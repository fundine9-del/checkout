import { Router } from 'express';
import { supabase } from '../db.js';
import { money, normItem, toNumber } from '../helpers.js';
import type { ItemInput } from '../types.js';

export const syncRouter = Router();

/**
 * POST /api/sync/items
 * Body: { items: [{ barcode, name, price, category?, stock? }, ...] }
 *
 * Bulk upserts the supermarket's item feed into the local catalogue.
 * Matches on barcode: new barcodes are inserted, existing ones are
 * updated (including price and stock). This is how the checkout system
 * stays "synced with the supermarket db".
 */
syncRouter.post('/items', async (req, res) => {
  const raw = (req.body ?? {}) as { items?: unknown };
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  const items: ItemInput[] = [];
  const rejected: unknown[] = [];
  for (const entry of raw.items) {
    const e = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof e.barcode !== 'string' ||
      e.barcode.trim() === '' ||
      typeof e.name !== 'string' ||
      e.name.trim() === '' ||
      !Number.isFinite(toNumber(e.price)) ||
      toNumber(e.price) < 0
    ) {
      rejected.push(entry);
      continue;
    }
    items.push({
      barcode: e.barcode.trim(),
      name: e.name.trim(),
      price: money(toNumber(e.price)),
      category: typeof e.category === 'string' && e.category.trim() !== '' ? e.category.trim() : null,
      stock: e.stock === undefined ? 0 : toNumber(e.stock),
      updated_at: new Date().toISOString(),
    });
  }

  if (items.length === 0) {
    return res.status(400).json({
      error: 'No valid items in the request',
      hint: 'Each item needs a non-empty barcode, name, and a price >= 0',
    });
  }

  const { data, error } = await supabase
    .from('items')
    .upsert(items as never, { onConflict: 'barcode' })
    .select();
  if (error) return res.status(400).json({ error: error.message });

  res.json({
    synced: (data ?? []).length,
    rejected: rejected.length,
    items: (data ?? []).map(normItem),
  });
});