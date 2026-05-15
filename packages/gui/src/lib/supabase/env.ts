function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

export const supabaseEnv = {
  url: (): string => required('NEXT_PUBLIC_SUPABASE_URL'),
  anonKey: (): string => required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  serviceRoleKey: (): string => required('SUPABASE_SERVICE_ROLE_KEY'),
};
