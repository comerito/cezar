'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from './ui/cn';

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + '/');

  return (
    <Link
      href={href}
      className={cn(
        'rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-bg-subtle font-medium text-fg'
          : 'text-fg-muted hover:bg-bg-subtle hover:text-fg',
      )}
    >
      {label}
    </Link>
  );
}
