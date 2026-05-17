import Link from 'next/link';
import { signOut } from '@/app/auth/actions';
import { switchWorkspace } from '@/app/workspace/actions';
import { NavLink } from './nav-link';
import {
  InboxIcon,
  IssuesIcon,
  PullRequestIcon,
  SparkleIcon,
  BoltIcon,
  TerminalIcon,
  ClockIcon,
  SettingsIcon,
} from './icons';
import type { SessionUser } from '@/lib/auth';
import type { ActiveWorkspace, WorkspaceListItem } from '@/lib/workspace';
import { cn } from './ui/cn';

const NAV = [
  { href: '/dashboard', label: 'Inbox',    icon: <InboxIcon className="h-5 w-5" /> },
  { href: '/issues',    label: 'Issues',   icon: <IssuesIcon className="h-5 w-5" /> },
  { href: '/prs',       label: 'PRs',      icon: <PullRequestIcon className="h-5 w-5" /> },
  { href: '/skills',    label: 'Skills',   icon: <SparkleIcon className="h-5 w-5" /> },
  { href: '/actions',   label: 'Actions',  icon: <BoltIcon className="h-5 w-5" /> },
  { href: '/cockpit',   label: 'Runs',     icon: <TerminalIcon className="h-5 w-5" /> },
  { href: '/activity',  label: 'Activity', icon: <ClockIcon className="h-5 w-5" /> },
  { href: '/settings',  label: 'Settings', icon: <SettingsIcon className="h-5 w-5" /> },
] as const;

interface SidebarProps {
  user: SessionUser;
  workspace: ActiveWorkspace | null;
  workspaces: WorkspaceListItem[];
}

export function Sidebar({ user, workspace, workspaces }: SidebarProps) {
  const initials = (user.name || user.email || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <aside className="sticky top-0 flex h-screen w-sidebar shrink-0 flex-col overflow-y-auto border-r border-outline-variant bg-surface-container-low">
      {/* Brand */}
      <div className="px-6 pt-6 pb-5">
        <div className="text-[20px] font-semibold leading-none tracking-tight text-on-surface">Cezar AI</div>
        <div className="mt-1 text-xs text-on-surface-variant">
          {workspace ? `${workspace.repoOwner}/${workspace.repoName}` : 'Global Workspace'}
        </div>
      </div>

      {/* Workspace switcher (compact, optional) */}
      {workspace ? (
        workspaces.length > 1 ? (
          <div className="mb-3 px-3">
            <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
          </div>
        ) : null
      ) : (
        <div className="mb-3 px-3">
          <Link
            href="/workspaces/new"
            className="block rounded-md border border-dashed border-outline-variant px-3 py-2 text-center text-xs text-on-surface-variant hover:border-primary hover:text-on-surface"
          >
            + Add workspace
          </Link>
        </div>
      )}

      {/* Nav */}
      <nav className="flex flex-col gap-1 px-3">
        {NAV.map((item) => (
          <NavLink key={item.href} href={item.href} label={item.label} icon={item.icon} />
        ))}
        {workspace?.role === 'admin' && (
          <Link
            href="/workspaces/new"
            className="mt-1 rounded-md px-3 py-2 text-sm text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
          >
            + New workspace
          </Link>
        )}
      </nav>

      {/* User block at bottom */}
      <div className="mt-auto border-t border-outline-variant p-4">
        <div className="flex items-center gap-3">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-9 w-9 rounded-md object-cover" />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary-container text-sm font-semibold text-primary-on-container">
              {initials || 'CZ'}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-on-surface">{user.name || 'Cezar User'}</div>
            <div className="truncate text-xs text-on-surface-variant">
              {workspace?.role === 'admin' ? 'Admin Account' : workspace?.role ?? user.email}
            </div>
          </div>
        </div>
        <form action={signOut}>
          <button
            type="submit"
            className="mt-3 w-full rounded-md px-2 py-1.5 text-left text-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
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
  return (
    <div className="flex flex-col gap-1">
      {workspaces.map((ws) => (
        <form key={ws.id} action={switchWorkspace.bind(null, ws.id)}>
          <button
            type="submit"
            className={cn(
              'w-full rounded-md border px-3 py-2 text-left transition-colors',
              ws.id === current.id
                ? 'border-primary/40 bg-surface-container'
                : 'border-transparent hover:border-outline-variant hover:bg-surface-container',
            )}
          >
            <div className="truncate text-xs font-medium text-on-surface">{ws.name}</div>
            <div className="truncate text-xs text-on-surface-variant">
              {ws.repoOwner}/{ws.repoName}
            </div>
          </button>
        </form>
      ))}
    </div>
  );
}
