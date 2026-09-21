import type { ItemInput } from './types.js';

/**
 * Sample supermarket catalogue (prices in Kenyan Shillings).
 * Real barcode scanners feed this via POST /api/sync/items; the seeds
 * below just give you data to test with (npm run seed).
 */
export const seedItems: ItemInput[] = [
  { barcode: '6152000694182', name: "Dad's Pride Self Raising Flour 2kg", price: 210, category: 'Flour & Grains', stock: 60 },
  { barcode: '6152000694183', name: 'Golden Penny Maize Flour 2kg', price: 168, category: 'Flour & Grains', stock: 120 },
  { barcode: '6152000694184', name: 'Batian Sugar 1kg', price: 195, category: 'Baking', stock: 150 },
  { barcode: '6152000694185', name: 'Pishori Rice 1kg', price: 220, category: 'Flour & Grains', stock: 90 },
  { barcode: '6152000694186', name: 'Malkia Fresh Milk 500ml', price: 65, category: 'Dairy', stock: 100 },
  { barcode: '6152000694187', name: 'Fresh White Bread 400g', price: 60, category: 'Bakery', stock: 80 },
  { barcode: '6152000694188', name: 'Farm Eggs (Tray of 30)', price: 460, category: 'Dairy', stock: 40 },
  { barcode: '6152000694189', name: 'Sunflower Cooking Oil 1L', price: 345, category: 'Oils & Fats', stock: 70 },
  { barcode: '6152000694190', name: 'Bar Soap 200g', price: 95, category: 'Household', stock: 110 },
  { barcode: '6152000694191', name: 'Kaimosi Tea Leaves 500g', price: 260, category: 'Beverages', stock: 55 },
  { barcode: '6152000694192', name: 'Instant Coffee 100g', price: 480, category: 'Beverages', stock: 45 },
  { barcode: '6152000694193', name: 'Table Salt 500g', price: 25, category: 'Pantry', stock: 200 },
  { barcode: '6152000694194', name: 'Spaghetti Pasta 500g', price: 135, category: 'Pantry', stock: 85 },
  { barcode: '6152000694195', name: 'Fresh Tomatoes 1kg', price: 140, category: 'Produce', stock: 75 },
  { barcode: '6152000694196', name: 'Onions 1kg', price: 110, category: 'Produce', stock: 70 },
  { barcode: '6152000694197', name: 'Coca-Cola 2L', price: 190, category: 'Beverages', stock: 95 },
  { barcode: '6152000694198', name: 'Mineral Water 1.5L', price: 55, category: 'Beverages', stock: 120 },
  { barcode: '6152000694199', name: 'Toothpaste 100g', price: 150, category: 'Personal Care', stock: 90 },
  { barcode: '6152000694200', name: 'Toilet Paper (12 rolls)', price: 620, category: 'Household', stock: 50 },
  { barcode: '6152000694201', name: 'Indomie Chicken Noodles 90g', price: 20, category: 'Pantry', stock: 350 },
];