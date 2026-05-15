import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { supabaseEnv } from './env';
import type { Database } from './types';

/**
 * Per-request client scoped to the signed-in user's session. RLS policies
 * apply to every query — this is the right client for most reads.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(supabaseEnv.url(), supabaseEnv.anonKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (entries) => {
        try {
          for (const { name, value, options } of entries) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Middleware handles cookie writes in Server Components.
        }
      },
    },
  });
}

/**
 * Privileged client that bypasses RLS. Only use inside server-only code paths
 * that have already authorized the caller (e.g. webhook handlers, admin
 * maintenance). Never expose to components rendered client-side.
 */
export function createSupabaseAdminClient() {
  return createClient<Database>(supabaseEnv.url(), supabaseEnv.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
