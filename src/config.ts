import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
} as const;

/** Fails fast with a clear message if required env vars are missing. */
export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}.\n` +
        'Copy .env.example to .env and fill them in (see README.md).',
    );
  }
}