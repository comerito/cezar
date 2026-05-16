import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/sidebar';
import { TopBar } from '@/components/topbar';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace, listWorkspaces } from '@/lib/workspace';

export const metadata: Metadata = {
  title: 'Cezar AI',
  description: 'AI-powered GitHub issue management',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  const isLoginPage = !user;

  if (isLoginPage) {
    return (
      <html lang="en" className="dark">
        <body className="bg-surface text-on-surface">{children}</body>
      </html>
    );
  }

  const [workspace, workspaces] = await Promise.all([
    getActiveWorkspace(),
    listWorkspaces(),
  ]);

  return (
    <html lang="en" className="dark">
      <body className="bg-surface text-on-surface">
        <div className="flex min-h-screen">
          <Sidebar user={user} workspace={workspace} workspaces={workspaces} />
          <div className="flex min-h-screen flex-1 flex-col overflow-x-hidden">
            <TopBar
              user={{
                id: user.id,
                email: user.email,
                name: user.name,
                avatarUrl: user.avatarUrl,
              }}
            />
            <main className="flex-1">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
