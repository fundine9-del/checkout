import 'dotenv/config';

/** First non-empty value among the candidate env var names. */
function firstOf(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== '') return value.trim();
  }
  return '';
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  supabaseUrl: firstOf('SUPABASE_URL', 'VITE_SUPABASE_URL'),
  // Accepts both plain and Vite-style names (VITE_SUPABASE_SERVICEROLE_KEY
  // and the typo-prone VITE_SUPABASE_SERVICE_ROLE_KEY).
  supabaseServiceRoleKey: firstOf(
    'SUPABASE_SERVICE_ROLE_KEY',
    'VITE_SUPABASE_SERVICEROLE_KEY',
    'VITE_SUPABASE_SERVICE_ROLE_KEY',
  ),
  // Optional. Signs partner integration API keys. Without it a stable
  // fallback is derived from the service-role key (see integration.ts).
  integrationSecret: firstOf('INTEGRATION_SECRET'),
} as const;

/** Fails fast with a clear message if required env vars are missing. */
export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL or VITE_SUPABASE_URL');
  if (!config.supabaseServiceRoleKey)
    missing.push('SUPABASE_SERVICE_ROLE_KEY or VITE_SUPABASE_SERVICEROLE_KEY');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}.\n` +
        'Copy .env.example to .env and fill them in (see README.md).',
    );
  }
}