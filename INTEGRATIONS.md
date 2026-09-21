# Partner Integration API — supermarket POS ⇄ Check Out

This is the contract a supermarket's developers implement against. Their
POS / ERP integration agent pushes **products**, **prices** and **stock** in
to Check Out, and records **completed POS sales** so the Check Out dashboard,
ledger and customer app reflect real till activity.

The supermarket's database is **never** accessed directly. Everything goes
over this HTTPS API, and every call is scoped to the store that owns the key.

Base URL: `<your-check-out-host>/api/v1/integrations`

## Authentication

Each supermarket has its own API key, shown in the dashboard
(**Integrations** page / `GET /api/supermarkets/me/integration`).

```
Authorization: Bearer sk_live_<storeId>_<signature>
```

- Keys look like `sk_live_...` and are per-supermarket.
- Omitting it (or using a key for a different store) returns `401`.
- A strong signing secret can be pinned with `INTEGRATION_SECRET` in the
  server's `.env`; without it a stable fallback is derived from the
  service-role key, so keys stay valid across restarts.

## Endpoints

| Method | Path                          | Purpose                                   |
| ------ | ----------------------------- | ----------------------------------------- |
| GET    | `/`                           | Who am I + endpoint list                  |
| GET    | `/products`                   | This store's catalogue (`?search=`)       |
| GET    | `/products/:barcode`          | Look up one product by barcode            |
| POST   | `/sync/products`              | Push the full catalogue (bulk)            |
| POST   | `/sync/inventory`             | Push stock-level changes (bulk)           |
| POST   | `/orders`                     | Record a sale that already happened at POS|
| GET    | `/orders/:orderId`            | Fetch one of this store's orders          |

## Push your catalogue

```
POST /api/v1/integrations/sync/products
Authorization: Bearer sk_live_...

{
  "products": [
    { "barcode": "5449000000999", "name": "Coca-Cola 500ml",
      "price": 60, "stock": 127, "category": "Beverages" },
    { "barcode": "1234567890123", "name": "Bread 400g",
      "price": 65, "stock": 43 }
  ]
}
```

Rules:

- `barcode`, `name` and `price >= 0` are required; `stock` defaults to `0`.
- New barcodes are **created for your store**; barcodes already owned by your
  store are **updated** (price + stock + name).
- A barcode already owned by **another store or the shared catalogue** is
  reported in `conflicts` and left untouched — the barcode is globally
  unique in Check Out.

Response:

```json
{
  "created":  ["5449000000999"],
  "updated":  [],
  "conflicts": [],
  "summary":  { "created": 1, "updated": 0, "conflicts": 0 }
}
```

## Push stock levels

```
POST /api/v1/integrations/sync/inventory
{
  "updates": [
    { "barcode": "5449000000999", "stock": 126 }
  ]
}
```

Only affects products **owned by your store**; anything else is reported in
`skipped` rather than erroring.

## Record a POS sale

Once the sale has really happened at your till, push it so the Check Out
dashboard / wallet / reports show it:

```
POST /api/v1/integrations/orders
{
  "customer_name": "John Doe",          // optional
  "payment_method": "cash",             // cash | card | mobile (default cash)
  "items": [
    { "barcode": "5449000000999", "quantity": 2 }
  ]
}
```

This creates a **paid** order for your store, decrements stock, credits your
store's wallet (same ledger as the till) and returns the order + a receipt.

Errors you may hit:

- `400` — empty `items`, unknown barcodes (in `unknown`), invalid quantity.
- `409` — insufficient stock at sync time.

## Error codes

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
| 400  | Malformed body (missing fields, bad values)      |
| 401  | Missing or invalid API key                       |
| 404  | Barcode/order not found in this store            |
| 409  | Stock conflict, or barcode owned elsewhere       |
| 500  | Server/database error                            |

## Field mapping

| Their POS/Database field | Our API field |
| ------------------------ | ------------- |
| `item_code` / SKU       | `barcode`     |
| `item_name`             | `name`        |
| `selling_price`         | `price`       |
| `qty_available`         | `stock`       |
| category                | `category`    |

The supermarket's developers build a small connector that maps their internal
columns to these fields — the Check Out server never needs to know their
schema.