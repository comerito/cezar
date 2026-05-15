'use client';

import { useActionState } from 'react';
import { inviteMember, changeMemberRole, removeMember, type TeamActionState } from './team-actions';
import type { WorkspaceRole } from '@/lib/supabase/types';

interface Member {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string;
  role: WorkspaceRole;
}

interface TeamSectionProps {
  members: Member[];
  isAdmin: boolean;
  currentUserId: string;
}

export function TeamSection({ members, isAdmin, currentUserId }: TeamSectionProps) {
  const [inviteState, inviteAction, invitePending] = useActionState<TeamActionState, FormData>(inviteMember, {});

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-bg-subtle text-left text-xs uppercase tracking-wider text-fg-subtle">
            <tr>
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Role</th>
              {isAdmin && <th className="px-4 py-3">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((m) => (
              <tr key={m.userId} className="bg-bg">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {m.avatarUrl && <img src={m.avatarUrl} alt="" className="h-6 w-6 rounded-full" />}
                    <div>
                      <div className="text-xs font-medium text-fg">{m.name}</div>
                      <div className="text-xs text-fg-subtle">{m.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  {isAdmin && m.userId !== currentUserId ? (
                    <select
                      value={m.role}
                      onChange={(e) => changeMemberRole(m.userId, e.target.value as WorkspaceRole)}
                      className="rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                    >
                      <option value="admin">admin</option>
                      <option value="actor">actor</option>
                      <option value="viewer">viewer</option>
                    </select>
                  ) : (
                    <span className="text-xs text-fg-muted">{m.role}{m.userId === currentUserId ? ' (you)' : ''}</span>
                  )}
                </td>
                {isAdmin && (
                  <td className="px-4 py-3">
                    {m.userId !== currentUserId && (
                      <button
                        onClick={() => removeMember(m.userId)}
                        className="text-xs text-danger hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <form action={inviteAction} className="flex items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-fg-muted">Invite by email</label>
            <input
              name="email"
              type="email"
              placeholder="user@example.com"
              required
              className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-fg-muted">Role</label>
            <select name="role" className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg">
              <option value="actor">actor</option>
              <option value="admin">admin</option>
              <option value="viewer">viewer</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={invitePending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg hover:bg-accent-hover disabled:opacity-50"
          >
            {invitePending ? 'Inviting...' : 'Invite'}
          </button>
          {inviteState.ok && <span className="text-xs text-accent">Invited</span>}
          {inviteState.error && <span className="text-xs text-danger">{inviteState.error}</span>}
        </form>
      )}
    </div>
  );
}
