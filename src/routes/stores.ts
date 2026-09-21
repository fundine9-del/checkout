import { Router } from 'express';
import { supabase } from '../db.js';

export const storesRouter = Router();

// GET /api/stores -> public list of supermarkets for the kiosk store picker.
// Only exposes id + name; the kiosk picks which store its orders belong to.
storesRouter.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('supermarkets')
    .select('id, name')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    stores: (data ?? []).map((s) => ({ id: s.id as string, name: s.name as string })),
  });
});