import { createHash } from 'node:crypto';

export function contentHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex');
}
