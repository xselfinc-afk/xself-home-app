/**
 * Client-side moderation for user-submitted reviews.
 *
 * Scheme A: auto-approve + rule-based filtering.
 * Blocked reviews are inserted as status='hidden', not hard-rejected,
 * so content is preserved for manual review.
 *
 * Usage:
 *   import { moderateReviewInput } from './reviewModerator';
 *   const { allowed, reason } = moderateReviewInput(title, body);
 */

export type ModerationResult = {
  allowed: boolean;
  reason: string | null;
};

// ── Word blocklist ────────────────────────────────────────────────────────────

const BLOCKED_WORDS = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy',
  'nigger', 'faggot', 'retard', 'whore', 'slut',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function hasContactInfo(s: string): boolean {
  // URLs
  if (/https?:\/\//i.test(s)) return true;
  // Bare domains (e.g. "visit example.com")
  if (/\b\w+\.(com|net|org|io|co|shop|store)\b/i.test(s)) return true;
  // Email addresses
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) return true;
  // Phone numbers — 7+ consecutive digits, optionally formatted
  if (/(\+?[\d][\d\s\-().]{6,}\d)/.test(s)) return true;
  return false;
}

function hasAbusiveWords(s: string): boolean {
  const lower = normalize(s);
  return BLOCKED_WORDS.some(w => {
    // Whole-word match to avoid false positives inside normal words
    const re = new RegExp(`\\b${w}\\b`);
    return re.test(lower);
  });
}

function isGibberish(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;

  // Same character repeated 4+ times consecutively (e.g. "aaaa", "!!!!")
  if (/(.)\1{3,}/.test(trimmed)) return true;

  // No vowels at all in a string longer than 5 chars (keyboard smash)
  const letters = trimmed.replace(/[^a-z]/gi, '');
  if (letters.length > 5 && !/[aeiou]/i.test(letters)) return true;

  // Extremely high non-alpha ratio (> 60% non-letter chars)
  const nonAlpha = (trimmed.match(/[^a-z\s]/gi) ?? []).length;
  if (nonAlpha / trimmed.length > 0.6) return true;

  return false;
}

function isRepeatedJunk(s: string): boolean {
  // Same word repeated 3+ times: "test test test", "good good good good"
  const words = normalize(s).split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const wordCounts: Record<string, number> = {};
  for (const w of words) {
    wordCounts[w] = (wordCounts[w] ?? 0) + 1;
    if (wordCounts[w] >= 3) return true;
  }
  return false;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function moderateReviewInput(title: string, body: string): ModerationResult {
  const t = title.trim();
  const b = body.trim();

  if (t.length < 4) {
    return { allowed: false, reason: 'title_too_short' };
  }

  if (b.length < 20) {
    return { allowed: false, reason: 'body_too_short' };
  }

  if (hasContactInfo(t) || hasContactInfo(b)) {
    return { allowed: false, reason: 'contains_contact_info' };
  }

  if (hasAbusiveWords(t) || hasAbusiveWords(b)) {
    return { allowed: false, reason: 'abusive_language' };
  }

  if (isGibberish(t) || isGibberish(b)) {
    return { allowed: false, reason: 'gibberish_content' };
  }

  if (isRepeatedJunk(t) || isRepeatedJunk(b)) {
    return { allowed: false, reason: 'repeated_junk_text' };
  }

  return { allowed: true, reason: null };
}
