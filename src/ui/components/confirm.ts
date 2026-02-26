import { confirm } from '@inquirer/prompts';

export async function confirmAction(message: string, defaultValue = true): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}
