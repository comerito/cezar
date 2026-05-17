// Shared by the client form and the server action. Plain module (no
// 'use server'), so both sides import the same rules without a runtime split.

export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const NAME_MAX = 64;

export function validateActionName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return 'Name is required';
  if (name.length > NAME_MAX) return `Name must be ${NAME_MAX} characters or fewer`;
  if (!NAME_PATTERN.test(name)) {
    return 'Use lowercase letters, digits, and dashes only (no leading or trailing dash)';
  }
  return null;
}
