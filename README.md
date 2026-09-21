# Supermarket Checkout Server

A Node.js + TypeScript (Express) API that runs supermarket checkout:

1. The **catalogue stays synced** with the supermarket items DB (Supabase/Postgres) — prices and stock can be pushed in bulk by barcode.
2. A customer **scans barcodes** as they pick items; the server keeps their **cart** with the matching item, name and price.
3. On **Pay**, the server shows the **total**, decrements stock, and records the (simulated) payment.

The checkout apps (mobile/web scanning UI) come later — this is the backend they'll talk to.

## Tech

- Node.js 20+ · TypeScript · Express 5
- Supabase (Postgres) via `@supabase/supabase-js`
- Payments are **simulated** (cash / card / mobile recorded only)

## Project layout

```
checkout server/
├── supabase/schema.sql     # run once in the Supabase SQL editor
├── src/
│   ├── index.ts            # entry point (starts the server)
│   ├── app.ts              # Express app + routes + error handling
│   ├── config.ts           # env config
│   ├── db.ts               # Supabase client (service role key)
│   ├── types.ts            # domain types
│   ├── helpers.ts          # numeric coercion, totals, formatting
│   ├── seed.ts             # seeds the sample catalogue (npm run seed)
│   ├── seed-data.ts        # 20 sample items (KES prices)
│   └── routes/
│       ├── items.ts        # catalogue CRUD + barcode lookup
│       ├── orders.ts       # cart + checkout flow
│       └── sync.ts         # bulk catalogue sync
└── .env.example
```

## Setup

### 1. Create the Supabase database

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** → paste the contents of `supabase/schema.sql` → **Run**.
   This creates `items` (the supermarket catalogue), `orders`, and `order_items`.

### 2. Configure the server

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable                     | Where to find it                                        |
| ---------------------------- | ------------------------------------------------------- |
| `PORT`                       | Default `3000` — change if you like                     |
| `SUPABASE_URL`               | Project Settings → API → Project URL                    |
| `SUPABASE_SERVICE_ROLE_KEY`  | Project Settings → API → `service_role` secret          |

> Keep the service role key **server-side only**. The mobile/web apps must never ship with it.

### 3. Install, seed, run

```bash
npm install          # first time (approve esbuild's script if prompted)
npm run seed         # upserts the 20 sample items by barcode
npm run dev          # dev mode with auto-reload  ->  http://localhost:3000
# or:
npm run build && npm start   # production build ->  node dist/index.js
```

Check it's alive: <http://localhost:3000/health>

## API

### Catalogue (synced with the supermarket DB)

| Method | Path                          | Description                                    |
| ------ | ----------------------------- | ---------------------------------------------- |
| GET    | `/api/items`                  | List items (`?search=` by name/barcode, `?category=`) |
| GET    | `/api/items/barcode/:code`    | Look up one item by barcode (the scan lookup)  |
| POST   | `/api/items`                  | Add one item                                   |
| PATCH  | `/api/items/:id`              | Update one item                                |
| DELETE | `/api/items/:id`              | Remove one item                                |
| POST   | `/api/sync/items`             | **Bulk sync** the supermarket feed (upsert by barcode) |

### Cart & checkout

| Method | Path                                 | Description                                    |
| ------ | ------------------------------------ | ---------------------------------------------- |
| POST   | `/api/orders`                        | Start a new shopping session → returns `order.id` |
| GET    | `/api/orders`                        | List orders (`?status=open\|paid\|cancelled`)  |
| GET    | `/api/orders/:id`                    | Order details + line items + running total     |
| POST   | `/api/orders/:id/items`              | Scan a barcode into the cart `{ barcode, quantity? }` |
| PATCH  | `/api/orders/:id/items/:itemId`      | Change quantity (`0` removes the line)         |
| DELETE | `/api/orders/:id/items/:itemId`      | Remove a line                                  |
| POST   | `/api/orders/:id/checkout`           | Pay (simulated) & close the order              |

### Quick demo (PowerShell)

```powershell
# 1. Start a session
$order = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/orders -ContentType 'application/json' -Body '{"customer_name":"Ada"}'
$orderId = $order.order.id

# 2. Scan some barcodes
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/orders/$orderId/items" -ContentType 'application/json' -Body "{`"barcode`":`"6152000694186`"}"   # milk 500ml
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/orders/$orderId/items" -ContentType 'application/json' -Body "{`"barcode`":`"6152000694187`"}"   # bread
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/orders/$orderId/items" -ContentType 'application/json' -Body "{`"barcode`":`"6152000694186`",`"quantity`":2}"

# 3. See the cart + total
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/api/orders/$orderId"

# 4. Pay
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/orders/$orderId/checkout" -ContentType 'application/json' -Body '{"payment_method":"card"}'
```

### Sync the supermarket catalogue (bulk)

```powershell
$body = @{ items = @(
  @{ barcode = '6152000694186'; name = 'Malkia Fresh Milk 500ml'; price = 70; category = 'Dairy'; stock = 90 },
  @{ barcode = 'NEW123';         name = 'New Product';             price = 99; category = 'Pantry'; stock = 30 }
) } | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/sync/items -ContentType 'application/json' -Body $body
```

Existing barcodes get **price/stock updated**; new ones are inserted.

## How checkout works

1. `POST /orders` creates an `open` order.
2. Each scanned barcode is resolved against the synced `items` catalogue; the line is added (with a name/price **snapshot**) and stock is checked.
3. `POST /orders/:id/checkout`:
   - verifies every line still has enough stock (409 if not),
   - decrements stock for each line,
   - records `payment_method`, computes and stores the **total**, sets status `paid`,
   - returns the order + a **receipt**.
4. Payments are **simulated** — no real money moves. Swap the block in `orders.ts` for a real provider (Stripe, M-Pesa… ) later.

## Notes / next steps

- Race conditions between simultaneous checkouts are handled per-line via conditional updates (`stock >= quantity`); a Postgres stored procedure would make the whole checkout atomic — good future hardening.
- The apps will use the **anon key** + Supabase Auth instead of the service role key.
- Prices format as KES (`helpers.ts` → `readablePrice`); change the locale there if needed.