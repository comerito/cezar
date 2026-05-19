import Link from 'next/link';
import { getActiveWorkspace } from '@/lib/workspace';
import { loadInbox } from './load-inbox';
import { InboxView } from './inbox-view';

export const metadata = { title: 'Inbox · Cezar AI' };

export default async function InboxV2Page() {
  const workspace = await getActiveWorkspace();
  if (!workspace) {
    return (
      <div className="px-8 py-6">
        <div className="rounded-md border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected.{' '}
          <Link href="/workspaces/new" className="text-primary hover:underline">
            Create one first
          </Link>
          .
        </div>
      </div>
    );
  }

  const loaded = await loadInbox(workspace.id);
  return (
    <InboxView
      workspaceId={workspace.id}
      initialItems={loaded.items}
      syncedAt={loaded.syncedAt}
      healthAlerts={loaded.healthAlerts}
      actionNames={loaded.actionNames}
    />
  );
}
