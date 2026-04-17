import { createSupabaseServerClient } from './supabase/server';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? '',
    name: user.user_metadata?.full_name ?? user.user_metadata?.user_name ?? user.email ?? '',
    avatarUrl: user.user_metadata?.avatar_url ?? '',
  };
}
