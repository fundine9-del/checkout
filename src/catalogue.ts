import { supabase } from './db.js';

export interface CatalogueItem {
  id: string;
  barcode: string;
  name: string;
  price: number;
  stock: number;
}

const CATALOGUE_COLUMNS = 'id, barcode, name, price, stock';

/**
 * Resolves a barcode within a store's catalogue: the store's own products
 * first, then the shared base catalogue (store_id IS NULL). With no store
 * context it falls back to a global lookup, so legacy scanners keep working.
 *
 * This mirrors the dashboard rule for the store's product list:
 *   store_id IS NULL OR store_id = <my store>
 */
export async function resolveItemByBarcode(
  barcode: string,
  storeId?: string | null,
): Promise<CatalogueItem | null> {
  if (storeId) {
    const { data: owned } = await supabase
      .from('items')
      .select(CATALOGUE_COLUMNS)
      .eq('barcode', barcode)
      .eq('store_id', storeId)
      .maybeSingle();
    if (owned) return owned as unknown as CatalogueItem;

    const { data: shared } = await supabase
      .from('items')
      .select(CATALOGUE_COLUMNS)
      .eq('barcode', barcode)
      .is('store_id', null)
      .maybeSingle();
    if (shared) return shared as unknown as CatalogueItem;
    return null;
  }

  const { data } = await supabase
    .from('items')
    .select(CATALOGUE_COLUMNS)
    .eq('barcode', barcode)
    .maybeSingle();
  return data ? (data as unknown as CatalogueItem) : null;
}