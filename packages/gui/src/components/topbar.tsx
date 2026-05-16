import { SearchIcon, BellIcon } from './icons';
import type { SessionUser } from '@/lib/auth';

interface TopBarProps {
  user: SessionUser;
  searchPlaceholder?: string;
}

export function TopBar({ user, searchPlaceholder = 'Search skills, documentation, or status…' }: TopBarProps) {
  const initials = (user.name || user.email || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header className="sticky top-0 z-10 flex h-topbar items-center gap-4 border-b border-outline-variant bg-surface px-6 backdrop-blur">
      <div className="flex-1 max-w-3xl">
        <label className="relative flex items-center">
          <SearchIcon className="absolute left-3 h-4 w-4 text-on-surface-variant" aria-hidden />
          <input
            type="search"
            placeholder={searchPlaceholder}
            className="h-9 w-full rounded-md border border-outline-variant bg-surface-container-low pl-9 pr-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:shadow-focus-primary focus:outline-none"
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
          aria-label="Notifications"
        >
          <BellIcon className="h-5 w-5" />
        </button>

        <div className="mx-2 h-6 w-px bg-outline-variant" aria-hidden />

        <div className="flex items-center gap-2 pr-1">
          <div className="text-sm font-medium text-on-surface">{user.name || 'Cezar'}</div>
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-md object-cover" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-container text-xs font-semibold text-primary-on-container">
              {initials || 'CZ'}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
