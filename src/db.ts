import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WebSocketLikeConstructor } from '@supabase/realtime-js';
import { WebSocket } from 'ws';
import { config } from './config.js';

// Server-side client using the service role key. Never expose it publicly.
//
// supabase-js constructs a RealtimeClient on createClient(), and that client
// needs a WebSocket implementation. Node >= 22 has a native global WebSocket,
// but on older runtimes (Node 20/21 — e.g. Railway defaulting to Node 20) it
// is missing and createClient() throws at boot. We never use realtime, so we
// hand the client the `ws` implementation instead, which works on every Node
// version and makes the server independent of the runtime's WebSocket support.
//
// @types/ws declares a `constructor(address: null)` overload that realtime-js's
// transport type rejects, hence the cast to the exact type it expects.
export const supabase: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
  {
    realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
  },
);