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
  vat_rate: number;
  created_at: string;
  updated_at: string;
}

export interface ItemInput {
  barcode: string;
  name: string;
  price: number;
  category?: string | null;
  stock?: number;
  vat_rate?: number | null;
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
  store_id: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface Wallet {
  id: string;
  store_id: string;
  currency: string;
  balance: number;
  total_in: number;
  total_out: number;
  created_at: string;
  updated_at: string;
}

export interface WalletTransaction {
  id: string;
  wallet_id: string;
  store_id: string;
  order_id: string | null;
  type: 'payment' | 'refund' | 'withdrawal' | 'deposit';
  amount: number;
  balance_after: number;
  payment_method: PaymentMethod | null;
  status: 'pending' | 'completed' | 'failed';
  reference: string | null;
  description: string | null;
  created_at: string;
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
  /** VAT rate snapshot at scan time (percent); 0 = zero-rated. */
  vat_rate: number;
  created_at: string;
}

export interface OrderWithItems extends Order {
  items: OrderItem[];
}

export interface Supermarket {
  id: string;
  owner_id: string | null;
  name: string;
  is_default: boolean;
  vat_number: string | null;
  pin: string | null;
  till_number: string | null;
  created_at: string;
}

// ------------------------------------------------------------ receipts

export interface ReceiptLine {
  barcode: string | null;
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  /** VAT rate snapshot at scan time (percent); 0 = zero-rated. */
  vat_rate: number;
  /** Receipt tax code (A/B/C…) assigned by rate, highest first. */
  tax_code: string;
}

export interface ReceiptVatRow {
  code: string;
  rate: number;
  vatable: number;
  vat: number;
}

/** The fiscal receipt snapshot returned by checkout and re-print. */
export interface Receipt {
  store_name: string | null;
  vat_number: string | null;
  pin: string | null;
  till_number: string | null;
  customer_name: string | null;
  order_id: string;
  payment_method: string;
  total: number;
  /** Amount tendered (cash), or null when not captured. */
  tendered: number | null;
  change: number | null;
  paid_at: string | null;
  items: ReceiptLine[];
  vat_rows: ReceiptVatRow[];
  item_count: number;
  /** Data URL of the checkout-receipt QR code (scan at the till to reprint). */
  qr_data: string;
}

// ------------------------------------------------------------ printers

/** A registered receipt printer (PRN-XXXXXX) for one supermarket till. */
export interface Printer {
  id: string;
  store_id: string;
  till: string;
  /** Secret used by the Printer Agent to poll for jobs. */
  token: string;
  created_at: string;
}

/** The till/device currently bonded to a printer. */
export interface PrinterConnection {
  id: string;
  printer_id: string;
  device: string | null;
  connected_at: string;
  last_seen: string;
}

export interface PrinterWithConnection extends Printer {
  connection: PrinterConnection | null;
}

export type PrintJobStatus = 'pending' | 'printing' | 'done' | 'failed';

/** A receipt queued for a printer, awaited by the Printer Agent. */
export interface PrintJob {
  id: string;
  printer_id: string;
  order_id: string;
  status: PrintJobStatus;
  /** Receipt JSON snapshot (buildReceipt shape) — no store auth needed. */
  payload: unknown;
  created_at: string;
}