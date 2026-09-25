import { Router, type RequestHandler, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { supabase } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { getStoreByOwner } from '../stores.js';
import { buildReceipt } from '../receipt.js';
import { computeTotal, normOrder, normOrderItem } from '../helpers.js';
import type {
  PrintJob,
  Printer,
  PrinterConnection,
  PrinterWithConnection,
  Supermarket,
} from '../types.js';

// ------------------------------------------------------------ helpers

function normConnection(row: Record<string, unknown>): PrinterConnection {
  return { ...row } as unknown as PrinterConnection;
}

/** PRN-XXXXXX with a tiny uniqueness retry. */
async function freshPrinterId(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `PRN-${randomBytes(3).toString('hex').toUpperCase()}`;
    const { data } = await supabase
      .from('printers')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!data) return id;
  }
  return `PRN-${randomBytes(6).toString('hex').toUpperCase()}`;
}

// ---------------------------------------- store-authed management API
// Every printers route needs a valid Supabase session JWT (same as the
// rest of the /supermarkets/me endpoints).

export const printersRouter = Router();

printersRouter.use(requireAuth);

type AuthedHandler = (req: AuthedRequest, res: Response) => Promise<Response | void>;

function authed(handler: AuthedHandler): RequestHandler {
  return (req, res, next) => {
    handler(req as AuthedRequest, res).catch(next);
  };
}

async function requireStore(req: AuthedRequest, res: Response): Promise<Supermarket | null> {
  const store = await getStoreByOwner(req.authUser.id);
  if (!store) {
    res.status(404).json({ error: 'No supermarket registered for this account' });
    return null;
  }
  return store;
}

async function fetchPrinter(
  id: string,
  store: Supermarket,
  res: Response,
): Promise<Printer | null> {
  const { data } = await supabase.from('printers').select('*').eq('id', id).maybeSingle();
  if (!data || String(data.store_id) !== store.id) {
    res.status(404).json({ error: 'Printer not found' });
    return null;
  }
  return data as unknown as Printer;
}

async function connectionFor(printerId: string): Promise<PrinterConnection | null> {
  const { data } = await supabase
    .from('printer_connections')
    .select('*')
    .eq('printer_id', printerId)
    .maybeSingle();
  return data ? normConnection(data) : null;
}

async function withConnection(printer: Printer): Promise<PrinterWithConnection> {
  return { ...printer, connection: await connectionFor(printer.id) };
}

// GET /api/supermarkets/me/printers  -> every printer of this supermarket
printersRouter.get(
  '/me/printers',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    const { data, error } = await supabase
      .from('printers')
      .select('*')
      .eq('store_id', store.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const printers = (data ?? []) as unknown as Printer[];
    const ids = printers.map((p) => p.id);
    const byPrinter = new Map<string, PrinterConnection>();
    if (ids.length > 0) {
      const { data: conns } = await supabase
        .from('printer_connections')
        .select('*')
        .in('printer_id', ids);
      for (const row of conns ?? []) {
        const conn = normConnection(row);
        byPrinter.set(conn.printer_id, conn);
      }
    }

    res.json({
      printers: printers.map((p) => ({ ...p, connection: byPrinter.get(p.id) ?? null })),
    });
  }),
);

// POST /api/supermarkets/me/printers  { till }  -> register a printer
printersRouter.post(
  '/me/printers',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;

    const till = typeof req.body?.till === 'string' ? (req.body.till as string).trim() : '';
    if (till === '') return res.status(400).json({ error: 'till is required' });
    if (till.length > 60) return res.status(400).json({ error: 'till must be 60 characters or fewer' });

    const id = await freshPrinterId();
    const token = randomBytes(12).toString('hex');

    const { data, error } = await supabase
      .from('printers')
      .insert({ id, store_id: store.id, till, token })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json({ printer: await withConnection(data as unknown as Printer) });
  }),
);

// PATCH /api/supermarkets/me/printers/:id  { till }  -> rename the till
printersRouter.patch(
  '/me/printers/:id',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;
    const printer = await fetchPrinter(req.params.id as string, store, res);
    if (!printer) return;

    const till = typeof req.body?.till === 'string' ? (req.body.till as string).trim() : '';
    if (till === '') return res.status(400).json({ error: 'till is required' });
    if (till.length > 60) return res.status(400).json({ error: 'till must be 60 characters or fewer' });

    const { data, error } = await supabase
      .from('printers')
      .update({ till })
      .eq('id', printer.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ printer: await withConnection(data as unknown as Printer) });
  }),
);

// DELETE /api/supermarkets/me/printers/:id
printersRouter.delete(
  '/me/printers/:id',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;
    const printer = await fetchPrinter(req.params.id as string, store, res);
    if (!printer) return;

    const { error } = await supabase.from('printers').delete().eq('id', printer.id);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  }),
);

// POST /api/supermarkets/me/printers/:id/connect  { device? }
// Bonds this till/device to the printer (upsert, updates last_seen).
printersRouter.post(
  '/me/printers/:id/connect',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;
    const printer = await fetchPrinter(req.params.id as string, store, res);
    if (!printer) return;

    const device = typeof req.body?.device === 'string' ? (req.body.device as string).trim() : 'Checkout till';

    const { data, error } = await supabase
      .from('printer_connections')
      .upsert(
        { printer_id: printer.id, device, last_seen: new Date().toISOString() },
        { onConflict: 'printer_id' },
      )
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const connection = data ? normConnection(data) : null;
    res.json({ printer: { ...printer, connection } });
  }),
);

// POST /api/supermarkets/me/printers/:id/jobs  { order_id }
// Queues a paid order's receipt for that printer's agent.
printersRouter.post(
  '/me/printers/:id/jobs',
  authed(async (req, res) => {
    const store = await requireStore(req, res);
    if (!store) return;
    const printer = await fetchPrinter(req.params.id as string, store, res);
    if (!printer) return;

    const orderId = typeof req.body?.order_id === 'string' ? (req.body.order_id as string) : '';
    if (orderId === '') return res.status(400).json({ error: 'order_id is required' });

    const { data: orderRow, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();
    if (orderError) return res.status(500).json({ error: orderError.message });
    if (!orderRow || String(orderRow.store_id) !== store.id) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = normOrder(orderRow);
    if (order.status !== 'paid') {
      return res.status(409).json({ error: 'Order is not paid yet' });
    }

    const { data: lineRows, error: linesError } = await supabase
      .from('order_items')
      .select('*')
      .eq('order_id', order.id)
      .order('created_at');
    if (linesError) return res.status(500).json({ error: linesError.message });

    const items = (lineRows ?? []).map(normOrderItem);
    const total = computeTotal(items);
    const method = order.payment_method ?? 'cash';
    const payload = await buildReceipt(order, items, total, method);

    const { data: jobRow, error: jobError } = await supabase
      .from('print_jobs')
      .insert({ printer_id: printer.id, order_id: order.id, status: 'pending', payload })
      .select()
      .single();
    if (jobError) return res.status(500).json({ error: jobError.message });

    const job = jobRow as unknown as PrintJob;
    res.status(201).json({
      job: {
        id: job.id,
        printer_id: job.printer_id,
        order_id: job.order_id,
        status: job.status,
        created_at: job.created_at,
      },
    });
  }),
);

// -------------------------------------------- Printer Agent polling API
// Public routes gated by the printer's token (NOT the JWT). The agent runs
// on the supermarket PC next to the physical printer.

export const printJobsRouter = Router();

// GET /api/print-jobs?printer_id=PRN-...&token=...  -> claim pending jobs
printJobsRouter.get('/', async (req, res) => {
  const printerId = typeof req.query.printer_id === 'string' ? (req.query.printer_id as string) : '';
  const token = typeof req.query.token === 'string' ? (req.query.token as string) : '';
  if (printerId === '' || token === '') {
    return res.status(400).json({ error: 'printer_id and token are required' });
  }

  const { data: printer } = await supabase
    .from('printers')
    .select('*')
    .eq('id', printerId)
    .eq('token', token)
    .maybeSingle();
  if (!printer) return res.status(401).json({ error: 'Unknown printer or invalid token' });

  const { data: rows, error } = await supabase
    .from('print_jobs')
    .select('*')
    .eq('printer_id', printerId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });

  // Claim each job atomically (only still-pending rows become 'printing').
  const jobs: PrintJob[] = [];
  for (const row of rows ?? []) {
    const { data: claimed } = await supabase
      .from('print_jobs')
      .update({ status: 'printing' })
      .eq('id', (row as Record<string, unknown>).id as string)
      .eq('status', 'pending')
      .select()
      .single();
    if (claimed) jobs.push(claimed as unknown as PrintJob);
  }

  res.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      printer_id: j.printer_id,
      order_id: j.order_id,
      payload: j.payload,
      created_at: j.created_at,
    })),
  });
});

// POST /api/print-jobs/:id/status  { token, status: 'done'|'failed' }
printJobsRouter.post('/:id/status', async (req, res) => {
  const status = req.body?.status;
  if (status !== 'done' && status !== 'failed') {
    return res.status(400).json({ error: "status must be 'done' or 'failed'" });
  }
  const token = typeof req.body?.token === 'string' ? (req.body.token as string) : '';
  if (token === '') return res.status(400).json({ error: 'token is required' });

  const { data: job } = await supabase
    .from('print_jobs')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const { data: printer } = await supabase
    .from('printers')
    .select('*')
    .eq('id', (job as Record<string, unknown>).printer_id as string)
    .maybeSingle();
  if (!printer || String((printer as Record<string, unknown>).token) !== token) {
    return res.status(401).json({ error: 'Unknown printer or invalid token' });
  }

  const { data, error } = await supabase
    .from('print_jobs')
    .update({ status })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true, job: { id: (data as Record<string, unknown>).id } });
});