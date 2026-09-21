import { Router } from 'express';
import { supabase } from '../db.js';

export const storesRouter = Router();

// GET /api/stores/:id -> public lookup so a scanned store QR can be resolved.
storesRouter.get('/:id', async (req, res) => {
  const id = req.params.id.trim();
  // PostgREST rejects non-UUID filters, so bail early with a clean 404.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(404).json({ error: 'No supermarket with that code' });
  }
  const { data, error } = await supabase
    .from('supermarkets')
    .select('id, name')
    .eq('id', id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'No supermarket with that code' });
  res.json({ store: { id: String(data.id), name: String(data.name) } });
});

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