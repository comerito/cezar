import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/sidebar';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace, listWorkspaces } from '@/lib/workspace';

export const metadata: Metadata = {
  title: 'CEZAR',
  description: 'AI-powered GitHub issue management',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  const isLoginPage = !user;

  if (isLoginPage) {
    return (
      <html lang="en" className="dark">
        <body>{children}</body>
      </html>
    );
  }

  const [workspace, workspaces] = await Promise.all([
    getActiveWorkspace(),
    listWorkspaces(),
  ]);

  return (
    <html lang="en" className="dark">
      <body>
        <div className="flex min-h-screen">
          <Sidebar user={user} workspace={workspace} workspaces={workspaces} />
          <main className="flex-1 overflow-x-hidden">{children}</main>
        </div>
      </body>
    </html>
  );
}
