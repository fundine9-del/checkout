import { Router, type Response } from 'express';
import { supabase } from '../db.js';
import { computeTotal, money, normOrder, normOrderItem, toNumber } from '../helpers.js';
import { getDefaultStore } from '../stores.js';
import type { Order, OrderStatus, PaymentMethod, OrderWithItems } from '../types.js';

export const ordersRouter = Router();

const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'mobile'];

// ---------------------------------------------------------------- helpers

async function fetchOrder(id: string): Promise<Order | null> {
  const { data, error } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? normOrder(data) : null;
}

async function attachItems(order: Order): Promise<OrderWithItems> {
  const { data, error } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', order.id)
    .order('created_at');
  if (error) throw error;
  const items = (data ?? []).map(normOrderItem);
  return { ...order, items, total: computeTotal(items) };
}

function requireBody(res: Response, body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    res.status(400).json({ error: 'A JSON body is required' });
    return false;
  }
  return true;
}

function parsePositiveInt(value: unknown, res: Response, field = 'quantity'): number | 'invalid' {
  const n = toNumber(value);
  if (!Number.isInteger(n) || n < 1) {
    res.status(400).json({ error: `${field} must be a positive integer` });
    return 'invalid';
  }
  return n;
}

function requireOpenOrder(order: Order | null, res: Response): order is Order {
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return false;
  }
  if (order.status !== 'open') {
    res.status(409).json({ error: `Order is already ${order.status}` });
    return false;
  }
  return true;
}

async function getItemForBarcode(barcode: string, res: Response) {
  const { data, error } = await supabase
    .from('items')
    .select('id, barcode, name, price, stock')
    .eq('barcode', barcode)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return null;
  }
  if (!data) {
    res.status(404).json({ error: `No item found for barcode '${barcode}'` });
    return null;
  }
  return data;
}

// ---------------------------------------------------------------- routes

// POST /api/orders  { customer_name? }  -> start a new shopping session
ordersRouter.post('/', async (req, res) => {
  const raw = (req.body ?? {}) as { customer_name?: unknown };
  const customerName =
    typeof raw.customer_name === 'string' && raw.customer_name.trim() !== ''
      ? raw.customer_name.trim().slice(0, 200)
      : null;

  // Customer-app orders belong to the default store so sales/earnings add up.
  const store = await getDefaultStore();

  const { data, error } = await supabase
    .from('orders')
    .insert({
      customer_name: customerName,
      status: 'open',
      total: 0,
      store_id: store.id,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ order: normOrder(data) });
});

// GET /api/orders?status=open|paid|cancelled
ordersRouter.get('/', async (req, res) => {
  const { status } = req.query as { status?: OrderStatus };
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: (data ?? []).map(normOrder) });
});

// GET /api/orders/:id  -> full order with line items + running total
ordersRouter.get('/:id', async (req, res) => {
  const order = await fetchOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order: await attachItems(order) });
});

// POST /api/orders/:id/items  { barcode, quantity? }  -> scan an item into the cart
ordersRouter.post('/:id/items', async (req, res) => {
  const order = await fetchOrder(req.params.id);
  if (!requireOpenOrder(order, res)) return;
  if (!requireBody(res, req.body)) return;
  const barcode = typeof req.body.barcode === 'string' ? req.body.barcode.trim() : '';
  if (barcode === '') return res.status(400).json({ error: 'barcode is required' });
  const quantity =
    req.body.quantity === undefined ? 1 : parsePositiveInt(req.body.quantity, res);
  if (quantity === 'invalid') return;

  const item = await getItemForBarcode(barcode, res);
  if (!item) return;
  const available = toNumber(item.stock);
  if (available < quantity) {
    return res
      .status(409)
      .json({ error: `Only ${available} in stock of '${item.name}' (need ${quantity})` });
  }

  // If this item is already in the cart, bump the quantity.
  const { data: existing, error: existingError } = await supabase
    .from('order_items')
    .select('id, quantity')
    .eq('order_id', order.id)
    .eq('item_id', item.id)
    .maybeSingle();
  if (existingError) return res.status(500).json({ error: existingError.message });

  let savedRow: unknown;
  if (existing) {
    const newQty = toNumber(existing.quantity) + quantity;
    if (newQty > available) {
      return res.status(409).json({
        error: `Cart already has ${existing.quantity}; only ${available} in stock of '${item.name}'`,
      });
    }
    const { data, error } = await supabase
      .from('order_items')
      .update({ quantity: newQty })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    savedRow = data;
  } else {
    const { data, error } = await supabase
      .from('order_items')
      .insert({
        order_id: order.id,
        item_id: item.id,
        barcode: item.barcode,
        name: item.name,
        price: toNumber(item.price),
        quantity,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    savedRow = data;
  }

  res.status(201).json({
    item: normOrderItem(savedRow as unknown as Record<string, unknown>),
    order: await attachItems(order),
  });
});

// PATCH /api/orders/:id/items/:itemId  { quantity }  -> 0 removes the line
ordersRouter.patch('/:id/items/:itemId', async (req, res) => {
  const order = await fetchOrder(req.params.id);
  if (!requireOpenOrder(order, res)) return;
  if (!requireBody(res, req.body)) return;

  const quantity = toNumber(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) {
    return res.status(400).json({ error: 'quantity must be a non-negative integer (0 removes the item)' });
  }

  const { data: line, error: lineErr } = await supabase
    .from('order_items')
    .select('*')
    .eq('id', req.params.itemId)
    .eq('order_id', order.id)
    .maybeSingle();
  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!line) return res.status(404).json({ error: 'Item not found in this order' });

  if (quantity === 0) {
    const { error } = await supabase.from('order_items').delete().eq('id', line.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ removed: line.id, order: await attachItems(order) });
  }

  if (line.item_id) {
    const { data: stockRow } = await supabase
      .from('items')
      .select('stock')
      .eq('id', line.item_id)
      .maybeSingle();
    const available = stockRow ? toNumber(stockRow.stock) : 0;
    if (quantity > available) {
      return res.status(409).json({ error: `Only ${available} in stock of '${line.name}'` });
    }
  }

  const { data, error } = await supabase
    .from('order_items')
    .update({ quantity })
    .eq('id', line.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ item: normOrderItem(data), order: await attachItems(order) });
});

// DELETE /api/orders/:id/items/:itemId
ordersRouter.delete('/:id/items/:itemId', async (req, res) => {
  const order = await fetchOrder(req.params.id);
  if (!requireOpenOrder(order, res)) return;

  const { data, error } = await supabase
    .from('order_items')
    .delete()
    .eq('id', req.params.itemId)
    .eq('order_id', order.id)
    .select('id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Item not found in this order' });
  res.json({ removed: data.id, order: await attachItems(order) });
});

// POST /api/orders/:id/checkout  { payment_method }  -> pay (simulated) & close the order
ordersRouter.post('/:id/checkout', async (req, res) => {
  const order = await fetchOrder(req.params.id);
  if (!requireOpenOrder(order, res)) return;
  if (!requireBody(res, req.body)) return;

  const paymentMethod = req.body.payment_method as PaymentMethod;
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return res
      .status(400)
      .json({ error: `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}` });
  }

  const { data: lineRows, error: lineErr } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', order.id);
  if (lineErr) return res.status(500).json({ error: lineErr.message });

  const items = (lineRows ?? []).map(normOrderItem);
  if (items.length === 0) {
    return res.status(400).json({ error: "Order is empty - nothing to check out" });
  }
  const total = computeTotal(items);

  // 1) Verify every line still has enough stock before charging anything.
  for (const line of items) {
    if (!line.item_id) continue; // catalogue item was deleted; keep the snapshot
    const { data: stockRow, error } = await supabase
      .from('items')
      .select('stock')
      .eq('id', line.item_id)
      .maybeSingle();
    if (error) throw error;
    const available = stockRow ? toNumber(stockRow.stock) : 0;
    if (available < line.quantity) {
      return res.status(409).json({
        error: `Insufficient stock: only ${available} left of '${line.name}' (need ${line.quantity}). Adjust the cart and retry.`,
      });
    }
  }

  // 2) Decrement stock atomically (only if it still has enough left).
  for (const line of items) {
    if (!line.item_id) continue;
    const { data: stockRow } = await supabase
      .from('items')
      .select('stock')
      .eq('id', line.item_id)
      .maybeSingle();
    const current = stockRow ? toNumber(stockRow.stock) : 0;
    const { error } = await supabase
      .from('items')
      .update({ stock: current - line.quantity, updated_at: new Date().toISOString() })
      .eq('id', line.item_id)
      .gte('stock', line.quantity)
      .select('id')
      .single();
    if (error) {
      return res.status(409).json({
        error: `Stock changed while checking out ('${line.name}') - please retry`,
      });
    }
  }

  // 3) Mark the order paid (simulated payment).
  const { data: paidRow, error: paidErr } = await supabase
    .from('orders')
    .update({
      status: 'paid',
      payment_method: paymentMethod,
      total,
      paid_at: new Date().toISOString(),
    })
    .eq('id', order.id)
    .select()
    .single();
  if (paidErr) throw paidErr;

  const paid = normOrder(paidRow as unknown as Record<string, unknown>);
  res.json({
    order: await attachItems(paid),
    receipt: {
      order_id: paid.id,
      payment_method: paymentMethod,
      total,
      paid_at: paid.paid_at,
      items: items.map((i) => ({
        barcode: i.barcode,
        name: i.name,
        quantity: i.quantity,
        unit_price: money(i.price),
        line_total: money(i.price * i.quantity),
      })),
    },
  });
});