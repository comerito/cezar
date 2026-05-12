import Link from 'next/link';
import { signOut } from '@/app/auth/actions';
import { switchWorkspace } from '@/app/workspace/actions';
import { NavLink } from './nav-link';
import type { SessionUser } from '@/lib/auth';
import type { ActiveWorkspace, WorkspaceListItem } from '@/lib/workspace';
import { cn } from './ui/cn';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/issues',    label: 'Issues' },
  { href: '/cockpit',   label: 'Cockpit' },
  { href: '/flows',     label: 'My Flows' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/activity',  label: 'Activity' },
  { href: '/settings',  label: 'Settings' },
];

interface SidebarProps {
  user: SessionUser;
  workspace: ActiveWorkspace | null;
  workspaces: WorkspaceListItem[];
}

export function Sidebar({ user, workspace, workspaces }: SidebarProps) {
  return (
    <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-elevated px-3 py-5">
      {/* Brand */}
      <div className="px-3 pb-4">
        <div className="text-lg font-semibold tracking-tight">CEZAR</div>
        <div className="text-xs text-fg-muted">issue intelligence</div>
      </div>

      {/* Workspace switcher */}
      <div className="mb-4 px-1">
        {workspace ? (
          <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
        ) : (
          <Link
            href="/workspaces/new"
            className="block rounded-md border border-dashed border-border px-3 py-2 text-center text-xs text-fg-muted hover:border-accent hover:text-fg"
          >
            + Add workspace
          </Link>
        )}
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5">
        {NAV.map((item) => (
          <NavLink key={item.href} href={item.href} label={item.label} />
        ))}
        {workspace?.role === 'admin' && (
          <Link
            href="/workspaces/new"
            className="rounded-md px-3 py-2 text-sm text-fg-muted hover:bg-bg-subtle hover:text-fg"
          >
            + New workspace
          </Link>
        )}
      </nav>

      {/* User + logout at bottom */}
      <div className="mt-auto border-t border-border pt-3">
        <div className="flex items-center gap-2 px-3 py-1">
          {user.avatarUrl && (
            <img
              src={user.avatarUrl}
              alt=""
              className="h-6 w-6 rounded-full"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-fg">{user.name}</div>
            {workspace && (
              <div className="truncate text-xs text-fg-subtle">{workspace.role}</div>
            )}
          </div>
        </div>
        <form action={signOut}>
          <button
            type="submit"
            className="mt-1 w-full rounded-md px-3 py-1.5 text-left text-xs text-fg-subtle hover:bg-bg-subtle hover:text-fg"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}

function WorkspaceSwitcher({
  current,
  workspaces,
}: {
  current: ActiveWorkspace;
  workspaces: WorkspaceListItem[];
}) {
  if (workspaces.length <= 1) {
    return (
      <div className="rounded-md border border-border bg-bg-subtle px-3 py-2">
        <div className="truncate text-xs font-medium text-fg">{current.name}</div>
        <div className="truncate text-xs text-fg-subtle">
          {current.repoOwner}/{current.repoName}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {workspaces.map((ws) => (
        <form key={ws.id} action={switchWorkspace.bind(null, ws.id)}>
          <button
            type="submit"
            className={cn(
              'w-full rounded-md border px-3 py-2 text-left transition-colors',
              ws.id === current.id
                ? 'border-accent/40 bg-bg-subtle'
                : 'border-transparent hover:border-border hover:bg-bg-subtle',
            )}
          >
            <div className="truncate text-xs font-medium text-fg">{ws.name}</div>
            <div className="truncate text-xs text-fg-subtle">
              {ws.repoOwner}/{ws.repoName}
            </div>
          </button>
        </form>
      ))}
    </div>
  );
}
