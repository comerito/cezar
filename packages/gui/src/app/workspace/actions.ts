'use server';

import { setActiveWorkspace } from '@/lib/workspace';
import { redirect } from 'next/navigation';

export async function switchWorkspace(workspaceId: string) {
  await setActiveWorkspace(workspaceId);
  redirect('/dashboard');
}
