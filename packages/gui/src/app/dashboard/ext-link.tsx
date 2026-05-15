'use client';

import type { AnchorHTMLAttributes, ReactNode } from 'react';

/**
 * An external `<a>` that doesn't bubble its click up. Used inside a
 * card-as-`<Link>` so the external link opens its new tab without also
 * triggering the wrapping link's client-side navigation. Server-only callers
 * can't pass the `onClick` handler themselves (RSC can't serialize functions),
 * hence this tiny client component.
 */
export function ExtLink({
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) {
  return (
    <a {...props} onClick={(e) => e.stopPropagation()}>
      {children}
    </a>
  );
}
