import { app } from './app.js';
import { assertConfig, config } from './config.js';
import { ensureOrdersLinkedToDefaultStore } from './stores.js';

assertConfig();

// Backfill older orders into the default store (safe to run every boot).
await ensureOrdersLinkedToDefaultStore();

app.listen(config.port, () => {
  console.log(`Checkout server listening on http://localhost:${config.port}`);
  console.log(`Health check:   http://localhost:${config.port}/health`);
  console.log(`Items endpoint: http://localhost:${config.port}/api/items`);
});