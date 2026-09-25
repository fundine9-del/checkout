import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { itemsRouter } from './routes/items.js';
import { ordersRouter } from './routes/orders.js';
import { storesRouter } from './routes/stores.js';
import { supermarketsRouter } from './routes/supermarkets.js';
import { integrationsRouter } from './routes/integrations.js';
import { printersRouter, printJobsRouter } from './routes/printers.js';

export const app = express();

app.use(cors());
app.use(express.json());

// Simple endpoints for checking the server is alive
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Supermarket Checkout Server',
    version: '0.1.0',
    endpoints: [
      'GET    /health',
      'GET    /api/items',
      'GET    /api/items/barcode/:barcode  (?store=<id> scopes to that store)',
      'POST   /api/items',
      'PATCH  /api/items/:id',
      'DELETE /api/items/:id',
      'POST   /api/orders',
      'GET    /api/orders',
      'GET    /api/orders/:id',
      'GET    /api/orders/:id/receipt  (re-print a paid receipt)',
      'POST   /api/orders/:id/items    (scan a barcode into the cart)',
      'PATCH  /api/orders/:id/items/:itemId',
      'DELETE /api/orders/:id/items/:itemId',
      'POST   /api/orders/:id/checkout (pay & close the order)',
      'GET    /api/stores              (list supermarkets for the kiosk)',
      'GET    /api/stores/:id          (resolve a store from a QR code)',
      'POST   /api/supermarkets         (register my store, JWT required)',
      'GET    /api/supermarkets/me      (my store)',
      'GET    /api/supermarkets/me/items',
      'POST   /api/supermarkets/me/items',
      'PATCH  /api/supermarkets/me/items/:id',
      'DELETE /api/supermarkets/me/items/:id',
      'GET    /api/supermarkets/me/sales',
      'GET    /api/supermarkets/me/stats (earnings)',
      'GET    /api/supermarkets/me/integration (my store partner API key)',
      'GET    /api/supermarkets/me/printers (registered receipt printers)',
      'POST   /api/supermarkets/me/printers (register a till printer)',
      'PATCH  /api/supermarkets/me/printers/:id (rename till)',
      'DELETE /api/supermarkets/me/printers/:id',
      'POST   /api/supermarkets/me/printers/:id/connect (bond this till)',
      'POST   /api/supermarkets/me/printers/:id/jobs (queue a receipt)',
      '',
      '--- Printer Agent API (token of the printer, no JWT) ---',
      'GET    /api/print-jobs?printer_id=<PRN-...>&token=<token> (claim jobs)',
      'POST   /api/print-jobs { printer_id, token, order_id } (customer scans a printer QR)',
      'POST   /api/print-jobs/:id/status { token, status: done|failed }',
      '',
      '--- Partner integration API (supermarket POS -> Check Out) ---',
      'All endpoints below need:  Authorization: Bearer <sk_live_...>',
      'GET    /api/v1/integrations',
      'GET    /api/v1/integrations/products',
      'GET    /api/v1/integrations/products/:barcode',
      'POST   /api/v1/integrations/sync/products  (push catalogue)',
      'POST   /api/v1/integrations/sync/inventory (push stock levels)',
      'POST   /api/v1/integrations/orders         (record a POS sale)',
      'GET    /api/v1/integrations/orders/:orderId',
    ],
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.use('/api/items', itemsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/stores', storesRouter);
app.use('/api/supermarkets', supermarketsRouter);
app.use('/api/supermarkets', printersRouter);
app.use('/api/print-jobs', printJobsRouter);
app.use('/api/v1/integrations', integrationsRouter);

// 404 for unknown routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler (Express 5 forwards rejected async handlers here)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: message });
});