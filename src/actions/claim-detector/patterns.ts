/**
 * Regex patterns to detect when a contributor claims an issue via comments.
 * Case-insensitive matching with word boundaries where appropriate.
 *
 * Apostrophe character class matches:
 *   U+0027 (') — standard apostrophe
 *   U+2018 — left single quotation mark
 *   U+2019 — right single quotation mark
 */

// Shorthand for apostrophe variants (standard + smart quotes)
const A = "['\\u2018\\u2019]";

function re(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

export const CLAIM_PATTERNS: RegExp[] = [
  re(`\\bi${A}ll take (?:it|this)\\b`),
  re(`\\bi${A}ll work on (?:this|it)\\b`),
  re(`\\bi${A}d like to (?:work on|take|fix|tackle|handle) (?:this|it)\\b`),
  re(`\\bi want to work on (?:this|it)\\b`),
  re(`\\bi can take (?:this|it)\\b`),
  re(`\\bi${A}ll fix (?:this|it)\\b`),
  re(`\\bi${A}ll handle (?:this|it)\\b`),
  re(`\\bi${A}ll tackle (?:this|it)\\b`),
  re(`\\bi${A}ll submit (?:a )?(?:pr|pull request|fix|patch)(?: for this)?\\b`),
  re(`\\bi${A}ll implement (?:this|it)\\b`),
  re(`\\bworking on (?:it|this)\\b`),
  re(`\\bcan i work on (?:this|it)\\b`),
  re(`\\blet me take (?:this|it)\\b`),
  re(`\\bi${A}m on (?:it|this)\\b`),
  re(`\\bi${A}ll pick this up\\b`),
];

export const NEGATIVE_PATTERNS: RegExp[] = [
  /\btake a look\b/i,
  /\btook a look\b/i,
  /\btake a peek\b/i,
  /\blooking into (?:it|this)\b/i,
];

export interface ClaimMatch {
  author: string;
  snippet: string;
  createdAt: string;
}

export function detectClaim(comment: { author: string; body: string; createdAt: string }): ClaimMatch | null {
  const { author, body, createdAt } = comment;

  // Check negative patterns first — if any match, skip this comment
  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.test(body)) return null;
  }

  for (const pattern of CLAIM_PATTERNS) {
    const match = pattern.exec(body);
    if (match) {
      // Extract a snippet around the match (up to 120 chars)
      const start = Math.max(0, match.index - 20);
      const end = Math.min(body.length, match.index + match[0].length + 60);
      const snippet = (start > 0 ? '...' : '') + body.slice(start, end).trim() + (end < body.length ? '...' : '');

      return { author, snippet, createdAt };
    }
  }

  return null;
}
