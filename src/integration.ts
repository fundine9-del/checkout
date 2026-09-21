import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export const INTEGRATION_KEY_PREFIX = 'sk_live_';

/**
 * Server secret used to sign integration API keys. Prefer INTEGRATION_SECRET
 * in .env; without it a deterministic fallback is derived from the
 * service-role key, so keys issued w/o the env var still stay valid across
 * restarts (the service-role key is stable for a Supabase project).
 */
function secret(): string {
  if (config.integrationSecret) return config.integrationSecret;
  return createHmac('sha256', 'checkout-integration')
    .update(config.supabaseServiceRoleKey)
    .digest('hex');
}

/**
 * Issues the partner API key for a supermarket:
 *   sk_live_<storeId>_<hmac-sha256(secret, storeId) prefix>
 * The store id is embedded, so the server can verify any key without a
 * database lookup (no schema changes needed to onboard partners).
 */
export function issueApiKey(storeId: string): string {
  const sig = createHmac('sha256', secret()).update(storeId).digest('hex').slice(0, 32);
  return `${INTEGRATION_KEY_PREFIX}${storeId}_${sig}`;
}

/** Verifies a bearer API key and returns the store id it was issued for, or null. */
export function verifyApiKey(token: string): string | null {
  if (!token.startsWith(INTEGRATION_KEY_PREFIX)) return null;
  const rest = token.slice(INTEGRATION_KEY_PREFIX.length);
  const sep = rest.lastIndexOf('_');
  if (sep <= 0) return null;
  const storeId = rest.slice(0, sep);
  const presented = rest.slice(sep + 1);
  const expected = createHmac('sha256', secret()).update(storeId).digest('hex').slice(0, 32);
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? storeId : null;
}