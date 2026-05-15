import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// API routes with their own auth must bypass the user-session gate here:
//   /api/cron/*  — CRON_SECRET bearer (scheduler / external cron)
//   /api/runner/* — per-runner bearer token (`authRunner` in api/runner/_auth.ts)
//   /api/github/webhook — HMAC-SHA256 against GITHUB_APP_WEBHOOK_SECRET
// Without these on the public list the middleware redirects to /login and
// callers (the runner daemon, GitHub) JSON-parse the HTML and fail.
const PUBLIC_ROUTES = [
  '/login',
  '/auth/callback',
  '/api/cron',
  '/api/runner',
  '/api/github/webhook',
];

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();

  const isPublic = PUBLIC_ROUTES.some((r) => request.nextUrl.pathname.startsWith(r));

  if (!user && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    return NextResponse.redirect(loginUrl);
  }

  if (user && request.nextUrl.pathname === '/login') {
    const dashUrl = request.nextUrl.clone();
    dashUrl.pathname = '/dashboard';
    return NextResponse.redirect(dashUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
