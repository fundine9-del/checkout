import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

// Server-side client using the service role key. Never expose it publicly.
export const supabase: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
);