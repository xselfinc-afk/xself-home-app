/**
 * Write path for user-submitted reviews.
 *
 * Moderates input via reviewModerator, then inserts into public.product_reviews.
 * Blocked reviews are saved as status='hidden' (not hard-rejected) so content
 * is preserved for manual moderation.
 *
 * Usage:
 *   const result = await submitReview({ supplierProductId, rating, title, body, reviewerName, userId });
 *   if (result.ok) { // show success }
 *   else { // show result.userMessage }
 */

import { supabase } from '../lib/supabase';
import { moderateReviewInput } from './reviewModerator';

// ── Input ─────────────────────────────────────────────────────────────────────

export type SubmitReviewInput = {
  supplierProductId: string;
  rating: number;           // 1–5
  title: string;
  body: string;
  reviewerName: string;
  userId?: string | null;
  tags?: string[];
};

// ── Result ────────────────────────────────────────────────────────────────────

export type SubmitReviewResult = {
  ok: boolean;
  /** Human-readable message to display to the user */
  userMessage: string;
  /** 'active' | 'hidden' — what status the row was saved with */
  savedStatus?: 'active' | 'hidden';
  /** Moderation reason when blocked */
  moderationReason?: string | null;
};

// ── User-facing messages ──────────────────────────────────────────────────────

const MESSAGES = {
  success:
    'Your review has been submitted. Thank you!',
  hidden:
    'Your review was submitted but is pending review before it goes live.',
  db_error:
    'Something went wrong saving your review. Please try again.',
} as const;

// ── Main export ───────────────────────────────────────────────────────────────

export async function submitReview(input: SubmitReviewInput): Promise<SubmitReviewResult> {
  const { supplierProductId, rating, title, body, reviewerName, userId, tags } = input;

  const { allowed, reason } = moderateReviewInput(title, body);

  const now = new Date().toISOString();
  const status: 'active' | 'hidden' = allowed ? 'active' : 'hidden';

  // ── Allowed review payload ─────────────────────────────────────────────────
  //
  // {
  //   supplier_product_id: "SP-12345",
  //   rating: 5,
  //   title: "Really happy with this",
  //   body: "Solid build, easy to assemble...",
  //   reviewer_name: "Alex M.",
  //   user_id: "uuid-or-null",
  //   tags: ["Drawers slide smoothly", "Blends in nicely"],
  //   review_source: "user",
  //   is_generated: false,
  //   verified_purchase: false,
  //   status: "active",
  //   display_priority: 500,
  //   moderation_reason: null,
  //   helpful_count: 0,
  //   submitted_at: "2026-04-20T...",
  //   created_at: "2026-04-20T...",
  // }
  //
  // ── Hidden review payload (same, plus moderation_reason) ──────────────────
  //
  // {
  //   ...same as above,
  //   status: "hidden",
  //   moderation_reason: "abusive_language",
  // }

  const row = {
    supplier_product_id: supplierProductId,
    rating,
    title: title.trim(),
    body: body.trim(),
    reviewer_name: reviewerName.trim(),
    user_id: userId ?? null,
    tags: tags ?? [],
    review_source: 'user' as const,
    is_generated: false,
    verified_purchase: false,
    status,
    // Real reviews rank above generated (500). Verified purchase would use 50.
    display_priority: 100,
    moderation_reason: reason,
    helpful_count: 0,
    submitted_at: now,
    created_at: now,
  };

  const { error } = await supabase.from('product_reviews').insert(row);

  if (error) {
    return {
      ok: false,
      userMessage: MESSAGES.db_error,
    };
  }

  if (!allowed) {
    return {
      ok: false,
      userMessage: MESSAGES.hidden,
      savedStatus: 'hidden',
      moderationReason: reason,
    };
  }

  return {
    ok: true,
    userMessage: MESSAGES.success,
    savedStatus: 'active',
    moderationReason: null,
  };
}
