import Link from 'next/link';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/issues',    label: 'Issues' },
  { href: '/flows',     label: 'My Flows' },
  { href: '/settings',  label: 'Settings' },
];

export function Sidebar() {
  return (
    <aside className="flex h-screen w-56 flex-col border-r border-border bg-bg-elevated px-3 py-5">
      <div className="px-3 pb-6">
        <div className="text-lg font-semibold tracking-tight">CEZAR</div>
        <div className="text-xs text-fg-muted">issue intelligence</div>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-md px-3 py-2 text-sm text-fg-muted hover:bg-bg-subtle hover:text-fg"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto px-3 text-xs text-fg-subtle">
        Phase 0 scaffold
      </div>
    </aside>
  );
}
