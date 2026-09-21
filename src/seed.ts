import { assertConfig } from './config.js';
import { supabase } from './db.js';
import { seedItems } from './seed-data.js';

// Run with: npm run seed
// Upserts the sample supermarket catalogue by barcode.
async function main(): Promise<void> {
  assertConfig();
  console.log(`Seeding ${seedItems.length} items into Supabase...`);

  const { data, error } = await supabase
    .from('items')
    .upsert(seedItems, { onConflict: 'barcode' })
    .select('id, barcode, name, price, stock');

  if (error) {
    console.error('Seed failed:', error.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Done. ${data?.length ?? 0} items upserted (inserted or updated by barcode).`);
}

void main();