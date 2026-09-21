// Domain types for the checkout system.
// Note: PostgREST returns numeric columns as strings; coerce with the
// helpers in helpers.ts whenever you read rows.

export interface Item {
  id: string;
  barcode: string;
  name: string;
  price: number;
  category: string | null;
  stock: number;
  created_at: string;
  updated_at: string;
}

export interface ItemInput {
  barcode: string;
  name: string;
  price: number;
  category?: string | null;
  stock?: number;
  updated_at?: string;
}

export type OrderStatus = 'open' | 'paid' | 'cancelled';
export type PaymentMethod = 'cash' | 'card' | 'mobile';

export interface Order {
  id: string;
  customer_name: string | null;
  status: OrderStatus;
  payment_method: PaymentMethod | null;
  total: number;
  created_at: string;
  paid_at: string | null;
}

export interface OrderItem {
  id: string;
  order_id: string;
  item_id: string | null;
  barcode: string | null;
  name: string;
  /** Price snapshot at scan time (KES). */
  price: number;
  quantity: number;
  created_at: string;
}

export interface OrderWithItems extends Order {
  items: OrderItem[];
}