# CEZAR GUI — Manual Setup (before Phase 1)

## 1. Env file

```bash
cp packages/gui/.env.example packages/gui/.env.local
```

Fill in (from **Supabase → Project Settings → API**):

- `NEXT_PUBLIC_SUPABASE_URL` — `https://<project-ref>.supabase.co`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the `anon public` key
- `SUPABASE_SERVICE_ROLE_KEY` — the `service_role secret` key
- `ANTHROPIC_API_KEY` — for running actions server-side

## 2. Apply the SQL migration

Open **Supabase → SQL Editor → New query**, paste the entire contents of
`packages/gui/supabase/migrations/0001_init.sql`, run it. You should see
`workspaces`, `workspace_members`, `issues`, `flows`, `flow_events` under
Database → Tables, all with RLS enabled.

## 3. Create a GitHub OAuth App (for login)

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
   (https://github.com/settings/developers).
2. Fill in:
   - **Application name**: `CEZAR (local)`
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `https://<project-ref>.supabase.co/auth/v1/callback`
     ← must be the Supabase URL, not localhost
3. Register → copy the **Client ID**, then generate + copy the **Client Secret**.

## 4. Enable GitHub provider in Supabase

**Supabase → Authentication → Providers → GitHub**:

- Toggle **Enabled**
- Paste the **Client ID** and **Client Secret** from step 3
- **Scopes**: `read:user user:email repo` (the `repo` scope is what lets CEZAR
  later read issues and open PRs on behalf of the user)
- Save

## 5. Configure auth URLs in Supabase

**Supabase → Authentication → URL Configuration**:

- **Site URL**: `http://localhost:3000`
- **Redirect URLs** (add both):
  - `http://localhost:3000/**`
  - `http://localhost:3000/auth/callback`

## 6. Enable Realtime on flow_events

**Supabase → Database → Replication**:

- Find the `flow_events` table → toggle **Realtime ON**
- Same for `flows`
- (Phase 2 needs this; easier to flip now.)

## 7. (Optional) Seed a first workspace

You'll need this to actually see anything on the Issues page. After you've
logged in once (so `auth.users` has your row), paste into SQL Editor:

```sql
insert into workspaces (slug, name, repo_owner, repo_name)
values ('open-mercato', 'Open Mercato', 'comerito', 'open-mercato');

insert into workspace_members (workspace_id, user_id, role)
values (
  (select id from workspaces where slug = 'open-mercato'),
  (select id from auth.users order by created_at desc limit 1),
  'admin'
);
```

Replace `repo_owner`/`repo_name` with whichever repo you want to test against.
