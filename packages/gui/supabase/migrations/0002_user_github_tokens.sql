-- Persist the GitHub OAuth provider token from Supabase Auth.
-- Supabase only exposes session.provider_token immediately after the OAuth
-- callback; subsequent silent session refreshes drop the field, which forces
-- the user to sign out/in to get a working token. We mirror the token here
-- so server actions can read it on every request.

create table user_github_tokens (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  provider_token         text not null,
  provider_refresh_token text,
  updated_at             timestamptz not null default now()
);

alter table user_github_tokens enable row level security;

create policy "user reads own github token"
  on user_github_tokens for select
  using (auth.uid() = user_id);

create policy "user inserts own github token"
  on user_github_tokens for insert
  with check (auth.uid() = user_id);

create policy "user updates own github token"
  on user_github_tokens for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user deletes own github token"
  on user_github_tokens for delete
  using (auth.uid() = user_id);
