'use server';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

export async function signInWithGitHub() {
  const supabase = await createSupabaseServerClient();
  const headerStore = await headers();
  const origin = headerStore.get('origin') ?? 'http://localhost:3000';

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: `${origin}/auth/callback`,
      scopes: 'read:user user:email repo',
    },
  });

  if (error || !data.url) {
    redirect('/login?error=oauth_failed');
  }

  redirect(data.url);
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}
