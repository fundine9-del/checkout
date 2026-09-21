import { supabase } from './db.js';
import { toNumber } from './helpers.js';
import type { PaymentMethod } from './types.js';

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

/** Reads the store's wallet (created automatically when the store is made). */
export async function getWalletForStore(storeId: string): Promise<Wallet | null> {
  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('store_id', storeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as Record<string, unknown>;
  return {
    ...(data as unknown as Wallet),
    balance: toNumber(row.balance),
    total_in: toNumber(row.total_in),
    total_out: toNumber(row.total_out),
  };
}

/**
 * Records a simulated payment against the store's wallet via the atomic
 * credit_wallet() RPC (row lock + ledger insert + balance update).
 * Idempotent: a second call for the same order hits the unique
 * "one payment per order" guard (error 23505) and is ignored.
 */
export async function creditOrderPayment(
  storeId: string,
  orderId: string,
  total: number,
  paymentMethod: PaymentMethod,
): Promise<void> {
  const { error } = await supabase.rpc('credit_wallet', {
    p_store_id: storeId,
    p_order_id: orderId,
    p_amount: total,
    p_payment_method: paymentMethod,
    p_description: 'Order checkout',
  });
  if (error && error.code !== '23505') throw error;
}

/** Recent ledger entries for a store, newest first. */
export async function recentTransactions(
  storeId: string,
  limit = 50,
): Promise<WalletTransaction[]> {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      ...(row as unknown as WalletTransaction),
      amount: toNumber(r.amount),
      balance_after: toNumber(r.balance_after),
    };
  });
}