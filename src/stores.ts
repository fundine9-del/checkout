import { supabase } from './db.js';
import type { Supermarket } from './types.js';

export const DEFAULT_STORE_NAME = 'Demo Supermarket';

function normStore(row: Record<string, unknown>): Supermarket {
  return row as unknown as Supermarket;
}

/** The store that orders created by the customer app belong to. */
export async function getDefaultStore(): Promise<Supermarket> {
  const { data, error } = await supabase
    .from('supermarkets')
    .select('*')
    .eq('is_default', true)
    .maybeSingle();
  if (error) throw error;
  if (data) return normStore(data);

  const { data: created, error: insertError } = await supabase
    .from('supermarkets')
    .insert({ name: DEFAULT_STORE_NAME, is_default: true })
    .select()
    .single();
  if (insertError) throw insertError;
  return normStore(created);
}

export async function getStoreByOwner(ownerId: string): Promise<Supermarket | null> {
  const { data, error } = await supabase
    .from('supermarkets')
    .select('*')
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  return data ? normStore(data) : null;
}

/**
 * One-time-ish backfill: orders created before the multi-tenant migration
 * have no store; point them at the default store so earnings add up.
 */
export async function ensureOrdersLinkedToDefaultStore(): Promise<void> {
  try {
    const store = await getDefaultStore();
    const { error } = await supabase
      .from('orders')
      .update({ store_id: store.id })
      .is('store_id', null);
    if (error) console.warn('Order backfill skipped:', error.message);
  } catch (err) {
    console.warn(
      'Could not prepare default store (did you run migration_multi_tenant.sql?):',
      err instanceof Error ? err.message : err,
    );
  }
}