import { describe, it, expect } from 'vitest';
import { detectClaim, CLAIM_PATTERNS, NEGATIVE_PATTERNS } from '../../../src/actions/claim-detector/patterns.js';

const makeComment = (body: string, author = 'contributor1', createdAt = '2024-06-01T12:00:00Z') => ({
  author,
  body,
  createdAt,
});

describe('CLAIM_PATTERNS', () => {
  const positives = [
    "I'll take it",
    "I'll take this",
    "I'll work on this",
    "I'll work on it",
    "I'd like to work on this",
    "I'd like to take this",
    "I'd like to fix this",
    "I'd like to tackle this",
    "I'd like to handle this",
    "I want to work on this",
    "I want to work on it",
    "I can take this",
    "I can take it",
    "I'll fix this",
    "I'll fix it",
    "I'll handle this",
    "I'll handle it",
    "I'll tackle this",
    "I'll tackle it",
    "I'll submit a PR for this",
    "I'll submit a pull request",
    "I'll submit a fix",
    "I'll submit a patch",
    "I'll implement this",
    "I'll implement it",
    "working on it",
    "working on this",
    "can I work on this",
    "can I work on it",
    "let me take this",
    "let me take it",
    "I'm on it",
    "I'm on this",
    "I'll pick this up",
  ];

  it.each(positives)('matches: "%s"', (phrase) => {
    const matched = CLAIM_PATTERNS.some(p => p.test(phrase));
    expect(matched).toBe(true);
  });

  it('matches with surrounding text', () => {
    const matched = CLAIM_PATTERNS.some(p => p.test("Hey, I'll take this! Let me know if you need anything."));
    expect(matched).toBe(true);
  });

  it('matches with smart quotes', () => {
    const matched = CLAIM_PATTERNS.some(p => p.test("I\u2019ll take it"));
    expect(matched).toBe(true);
  });

  it('is case insensitive', () => {
    const matched = CLAIM_PATTERNS.some(p => p.test("I'LL TAKE THIS"));
    expect(matched).toBe(true);
  });
});

describe('NEGATIVE_PATTERNS', () => {
  const negatives = [
    "I'll take a look",
    "I took a look at this",
    "Let me take a peek",
    "looking into it",
    "looking into this",
  ];

  it.each(negatives)('matches negative: "%s"', (phrase) => {
    const matched = NEGATIVE_PATTERNS.some(p => p.test(phrase));
    expect(matched).toBe(true);
  });
});

describe('detectClaim', () => {
  it('returns a match for a claim comment', () => {
    const result = detectClaim(makeComment("I'll take it"));
    expect(result).not.toBeNull();
    expect(result!.author).toBe('contributor1');
    expect(result!.snippet).toContain("I'll take it");
    expect(result!.createdAt).toBe('2024-06-01T12:00:00Z');
  });

  it('returns null for non-claim comment', () => {
    const result = detectClaim(makeComment('This is a great feature request!'));
    expect(result).toBeNull();
  });

  it('returns null when negative pattern matches', () => {
    // "I'll take a look" contains "I'll take" but negative should filter it
    const result = detectClaim(makeComment("I'll take a look at this issue"));
    expect(result).toBeNull();
  });

  it('returns null for "took a look" even with claim-like text nearby', () => {
    const result = detectClaim(makeComment("I took a look and I think this needs fixing"));
    expect(result).toBeNull();
  });

  it('extracts snippet around the match', () => {
    const longComment = 'This is a really long comment about the issue and how it affects me. ' +
      "I'll take this and work on a fix. Let me know if there are any constraints.";
    const result = detectClaim(makeComment(longComment));
    expect(result).not.toBeNull();
    expect(result!.snippet.length).toBeLessThanOrEqual(130);
    expect(result!.snippet).toContain("I'll take this");
  });

  it('preserves the author from the comment', () => {
    const result = detectClaim(makeComment("I'll work on this", 'gsobczyk'));
    expect(result).not.toBeNull();
    expect(result!.author).toBe('gsobczyk');
  });

  it('handles mixed case', () => {
    const result = detectClaim(makeComment("I'LL HANDLE THIS"));
    expect(result).not.toBeNull();
  });

  it('handles extra whitespace', () => {
    const result = detectClaim(makeComment("  I'll take it  "));
    expect(result).not.toBeNull();
  });

  it('does not match partial words', () => {
    // "reworking on it" shouldn't match — but "working on it" has a word boundary
    const result = detectClaim(makeComment("I was networking on it yesterday"));
    expect(result).toBeNull();
  });
});
