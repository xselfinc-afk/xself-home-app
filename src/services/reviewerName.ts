/**
 * Reviewer-name resolver — suggests a privacy-safe public display name for a
 * product review, from the best available REAL customer information.
 *
 * Priority:
 *   1. default saved address  (addresses.first_name + last_name)
 *   2. latest order recipient (orders.address_json)
 *   3. auth user_metadata     (full_name / name / display_name)
 *   4. "Customer"             (fallback)
 *
 * NEVER returns the email local-part ("Tmyxads"). Public form is "First L."
 * (first name + last initial) so the full shipping name is not shown publicly.
 * The suggestion is editable in the modal before submit.
 *
 * No PII is logged from this module.
 */
import { supabase } from '../lib/supabase';
import { fetchAddresses } from './addressService';

export type ReviewerNameSource = 'address' | 'order' | 'metadata' | 'fallback';
export type ResolvedReviewerName = { suggestedName: string; source: ReviewerNameSource };

export const REVIEWER_NAME_FALLBACK = 'Customer';

/** Privacy-safe public name: "First L." Returns null when no usable name. */
export function toPublicName(first?: string | null, last?: string | null): string | null {
  const f = (first ?? '').trim();
  const l = (last ?? '').trim();
  if (f && l) return `${f} ${l[0].toUpperCase()}.`;
  return f || l || null; // single token -> use as-is; nothing -> null
}

/** "Jane Smith" -> "Jane S."; single token -> itself; empty -> null. */
function fullNameToPublic(full?: string | null): string | null {
  const s = (full ?? '').trim();
  if (!s) return null;
  const parts = s.split(/\s+/);
  return parts.length === 1 ? parts[0] : toPublicName(parts[0], parts[parts.length - 1]);
}

export async function resolveReviewerName(userId: string | null): Promise<ResolvedReviewerName> {
  if (!userId) return { suggestedName: REVIEWER_NAME_FALLBACK, source: 'fallback' };

  // 1) Default saved address (fetchAddresses orders is_default desc, created asc).
  try {
    const addrs = await fetchAddresses(userId);
    if (addrs.length > 0) {
      const name = toPublicName(addrs[0].first_name, addrs[0].last_name);
      if (name) return { suggestedName: name, source: 'address' };
    }
  } catch { /* fall through */ }

  // 2) Latest order recipient (address snapshot in orders.address_json).
  try {
    const { data } = await supabase
      .from('orders')
      .select('address_json, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);
    const aj = (data?.[0] as { address_json?: Record<string, any> } | undefined)?.address_json;
    if (aj) {
      const name =
        toPublicName(aj.first_name ?? aj.firstName, aj.last_name ?? aj.lastName) ??
        fullNameToPublic(aj.name ?? aj.recipient ?? aj.full_name ?? aj.recipientName);
      if (name) return { suggestedName: name, source: 'order' };
    }
  } catch { /* fall through */ }

  // 3) Auth user_metadata (cached session — no extra network round-trip).
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const meta = (session?.user?.user_metadata ?? {}) as Record<string, any>;
    const name = fullNameToPublic(meta.full_name ?? meta.name ?? meta.display_name);
    if (name) return { suggestedName: name, source: 'metadata' };
  } catch { /* fall through */ }

  // 4) Fallback — never the email prefix.
  return { suggestedName: REVIEWER_NAME_FALLBACK, source: 'fallback' };
}
