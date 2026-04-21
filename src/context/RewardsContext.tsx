import React, { createContext, useContext, useState, useCallback } from 'react';

export type LedgerEntryType =
  | 'referral_earn'
  | 'membership_billing'
  | 'credit_spend'
  | 'credit_spend_reverse'
  | 'referral_earn_reverse'
  | 'membership_billing_reverse';

export type LedgerEntry = {
  id: string;
  type: LedgerEntryType;
  /** Signed amount: positive = credit added, negative = credit deducted */
  amount: number;
  checkoutSessionId?: string;
  orderId?: string;
  referralCode?: string;
  /** Stable user identity of the referrer (e.g. email) */
  referrerId?: string;
  /** Stable user identity of the buyer — used for self-referral guard */
  buyerUserId?: string;
  productId?: string | number;
  source?: string;
  /** For membership_billing entries: the covered annual billing period */
  membershipPeriod?: { start: string; end: string };
  note: string;
  date: string;
};

/** Backward-compat shape used by EarnScreen history list */
export type EarningEntry = {
  id: string;
  type: 'purchase_referral';
  label: string;
  amount: number;
  date: string;
};

export const MEMBERSHIP_FEE = 29;
export const REFERRAL_CODE = 'JOHN2024';

/**
 * Maps referral codes to their owner's stable user identity.
 * Self-referral check compares buyerUserId against this, not the code string.
 */
const REFERRAL_OWNER: Record<string, string> = {
  [REFERRAL_CODE]: 'john@example.com',
};

export function getReferralLink(productId: string | number, source: string): string {
  return `https://xself.app/shop?ref=${REFERRAL_CODE}&product=${productId}&src=${source}`;
}

/** Commission tiers based on referred purchase amount. Members earn +30%. */
export function calcCommission(purchaseAmount: number, isMember: boolean): number {
  let base = 0;
  if (purchaseAmount >= 800) base = 20;
  else if (purchaseAmount >= 300) base = 10;
  else if (purchaseAmount >= 100) base = 5;
  return isMember ? parseFloat((base * 1.3).toFixed(2)) : base;
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Seed ledger: three referral earns (+$20) + one legacy credit spend (-$7.50) = $12.50 balance.
 * The legacy spend uses a historical checkoutSessionId so it is idempotency-safe.
 */
const INITIAL_LEDGER: LedgerEntry[] = [
  {
    id: 'seed-1',
    type: 'referral_earn',
    amount: 10,
    orderId: 'ORD-SEED-001',
    referralCode: REFERRAL_CODE,
    note: 'Referral purchase — Sarah M. ($499 order)',
    date: 'Mar 10, 2026',
  },
  {
    id: 'seed-2',
    type: 'referral_earn',
    amount: 5,
    orderId: 'ORD-SEED-002',
    referralCode: REFERRAL_CODE,
    note: 'Referral purchase — James T. ($149 order)',
    date: 'Feb 28, 2026',
  },
  {
    id: 'seed-3',
    type: 'referral_earn',
    amount: 5,
    orderId: 'ORD-SEED-003',
    referralCode: REFERRAL_CODE,
    note: 'Referral purchase — Mia L. ($149 order)',
    date: 'Feb 15, 2026',
  },
  {
    id: 'seed-spend-1',
    type: 'credit_spend',
    amount: -7.50,
    orderId: 'ORD-HIST-000',
    checkoutSessionId: 'sess-hist-000',
    note: 'Shopping credit applied — order ORD-HIST-000',
    date: 'Jan 20, 2026',
  },
];

type RewardsCtx = {
  ledger: LedgerEntry[];
  balance: number;
  totalEarned: number;
  clicks: number;
  referralOrders: number;
  /** True when the latest membership_billing entry's period covers today */
  isMember: boolean;
  /** ISO date the current membership period expires, or null */
  membershipExpiresAt: string | null;
  /** EarnScreen backward-compat: referral_earn entries as EarningEntry[] */
  history: EarningEntry[];
  membershipCovered: number;
  shoppingCredit: number;
  membershipProgress: number;
  /** True if a credit_spend for this session is already in the ledger */
  hasProcessedSession: (checkoutSessionId: string) => boolean;
  /**
   * Idempotent deduction for a completed order.
   * No-ops if checkoutSessionId is already present.
   */
  recordCreditSpend: (orderId: string, checkoutSessionId: string, amount: number) => void;
  /**
   * Records a referral commission earn on successful payment.
   * Guards: idempotent per orderId, blocks self-referrals by user identity.
   */
  recordReferralEarn: (
    purchaseAmount: number,
    label: string,
    opts?: {
      orderId?: string;
      referralCode?: string;
      /** Stable user identity of referrer (resolved from referral code) */
      referrerId?: string;
      /** Stable user identity of buyer — required for self-referral prevention */
      buyerUserId?: string;
    }
  ) => void;
  /**
   * Applies available balance toward a new annual membership billing cycle.
   * Creates a ledger entry with a 1-year membershipPeriod.
   * No-ops if there is already an active (unexpired) billing period.
   */
  applyMembershipEarnings: () => void;
  /**
   * Atomically reverses all reversible ledger entries for an order:
   * referral_earn and credit_spend entries are both reversed.
   * Skips any already-reversed entries. Uses reverse ledger entries, not mutation.
   */
  refundOrder: (orderId: string) => void;
  /** Reverses a single ledger entry by id. Prefer refundOrder for order-level refunds. */
  reverseEntry: (entryId: string) => void;
  trackClick: () => void;
  /** @deprecated — use recordCreditSpend */
  spendCredit: (amount: number) => void;
  /** @deprecated — use recordReferralEarn */
  addEarning: (purchaseAmount: number, label: string) => void;
};

const RewardsContext = createContext<RewardsCtx>(null!);

export function RewardsProvider({ children }: { children: React.ReactNode }) {
  const [ledger, setLedger] = useState<LedgerEntry[]>(INITIAL_LEDGER);
  const [clicks, setClicks] = useState(12);

  // ── Derived values ──────────────────────────────────────────────────────
  const balance = parseFloat(ledger.reduce((sum, e) => sum + e.amount, 0).toFixed(2));

  // All-time referral commissions earned (gross, never decreases)
  const totalEarned = parseFloat(
    ledger
      .filter(e => e.type === 'referral_earn')
      .reduce((sum, e) => sum + e.amount, 0)
      .toFixed(2)
  );

  const referralOrders = ledger.filter(e => e.type === 'referral_earn').length;

  // Membership: derived from latest unexpired billing period, not a stored boolean
  const todayIso = isoDate(new Date());
  const activeBilling = ledger
    .filter(e => e.type === 'membership_billing' && e.membershipPeriod && e.membershipPeriod.end >= todayIso)
    .sort((a, b) => (b.membershipPeriod!.end > a.membershipPeriod!.end ? 1 : -1))[0];
  const isMember = !!activeBilling;
  const membershipExpiresAt = activeBilling?.membershipPeriod?.end ?? null;

  // EarnScreen backward-compat: referral_earn entries newest-first
  const history: EarningEntry[] = [...ledger]
    .filter(e => e.type === 'referral_earn')
    .reverse()
    .map(e => ({ id: e.id, type: 'purchase_referral' as const, label: e.note, amount: e.amount, date: e.date }));

  const membershipCovered = Math.min(balance, MEMBERSHIP_FEE);
  const shoppingCredit = parseFloat(Math.max(0, balance - MEMBERSHIP_FEE).toFixed(2));
  const membershipProgress = Math.min(balance / MEMBERSHIP_FEE, 1);

  // ── Idempotency check ───────────────────────────────────────────────────
  const hasProcessedSession = useCallback(
    (checkoutSessionId: string) =>
      ledger.some(e => e.type === 'credit_spend' && e.checkoutSessionId === checkoutSessionId),
    [ledger]
  );

  // ── Mutations ───────────────────────────────────────────────────────────
  const recordCreditSpend = useCallback(
    (orderId: string, checkoutSessionId: string, amount: number) => {
      if (amount <= 0) return;
      setLedger(prev => {
        if (prev.some(e => e.type === 'credit_spend' && e.checkoutSessionId === checkoutSessionId)) return prev;
        const entry: LedgerEntry = {
          id: `spend-${Date.now()}`,
          type: 'credit_spend',
          amount: -amount,
          orderId,
          checkoutSessionId,
          note: `Shopping credit applied — order ${orderId}`,
          date: fmtDate(new Date()),
        };
        return [...prev, entry];
      });
    },
    []
  );

  const recordReferralEarn = useCallback(
    (
      purchaseAmount: number,
      label: string,
      opts?: { orderId?: string; referralCode?: string; referrerId?: string; buyerUserId?: string }
    ) => {
      // Self-referral prevention: resolve referrer's user identity from referral code,
      // then compare against the buyer's identity — not just the code string.
      const code = opts?.referralCode ?? REFERRAL_CODE;
      const referrerUserId = opts?.referrerId ?? REFERRAL_OWNER[code];
      if (referrerUserId && opts?.buyerUserId && referrerUserId === opts.buyerUserId) return;

      const amount = calcCommission(purchaseAmount, isMember);
      if (amount === 0) return;

      setLedger(prev => {
        if (opts?.orderId && prev.some(e => e.type === 'referral_earn' && e.orderId === opts.orderId)) return prev;
        const entry: LedgerEntry = {
          id: `earn-${Date.now()}`,
          type: 'referral_earn',
          amount,
          orderId: opts?.orderId,
          referralCode: code,
          referrerId: referrerUserId,
          buyerUserId: opts?.buyerUserId,
          note: label,
          date: fmtDate(new Date()),
        };
        return [...prev, entry];
      });
    },
    [isMember]
  );

  const applyMembershipEarnings = useCallback(() => {
    setLedger(prev => {
      // Guard: already have an active (unexpired) billing period — no double-billing
      const today = isoDate(new Date());
      const hasActive = prev.some(
        e => e.type === 'membership_billing' && e.membershipPeriod && e.membershipPeriod.end >= today
      );
      if (hasActive) return prev;

      const currentBalance = parseFloat(prev.reduce((s, e) => s + e.amount, 0).toFixed(2));
      const covered = Math.min(currentBalance, MEMBERSHIP_FEE);
      if (covered <= 0) return prev;

      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);

      const entry: LedgerEntry = {
        id: `mem-${Date.now()}`,
        type: 'membership_billing',
        amount: -covered,
        membershipPeriod: { start: isoDate(now), end: isoDate(periodEnd) },
        note: `Membership — ${fmtDate(now)} to ${fmtDate(periodEnd)} ($${covered.toFixed(2)} from rewards)`,
        date: fmtDate(now),
      };
      return [...prev, entry];
    });
  }, []);

  const refundOrder = useCallback((orderId: string) => {
    setLedger(prev => {
      const reversible: LedgerEntryType[] = ['referral_earn', 'credit_spend'];
      const newEntries: LedgerEntry[] = [];
      const now = new Date();

      for (const entry of prev) {
        if (entry.orderId !== orderId) continue;
        if (!reversible.includes(entry.type)) continue;
        const reverseType = `${entry.type}_reverse` as LedgerEntryType;
        // Skip if already reversed (match by original entry id stored in note, or by session+order combo)
        const alreadyReversed = prev.some(
          e => e.type === reverseType &&
            e.orderId === orderId &&
            e.checkoutSessionId === entry.checkoutSessionId
        );
        if (alreadyReversed) continue;

        newEntries.push({
          id: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: reverseType,
          amount: -entry.amount,
          orderId,
          checkoutSessionId: entry.checkoutSessionId,
          note: `Refund — ${entry.note}`,
          date: fmtDate(now),
        });
      }

      return newEntries.length > 0 ? [...prev, ...newEntries] : prev;
    });
  }, []);

  const reverseEntry = useCallback((entryId: string) => {
    setLedger(prev => {
      const target = prev.find(e => e.id === entryId);
      if (!target) return prev;
      const reverseType = `${target.type}_reverse` as LedgerEntryType;
      if (
        prev.some(e => e.type === reverseType &&
          e.orderId === target.orderId &&
          e.checkoutSessionId === target.checkoutSessionId)
      ) return prev;
      const entry: LedgerEntry = {
        id: `rev-${Date.now()}`,
        type: reverseType,
        amount: -target.amount,
        orderId: target.orderId,
        checkoutSessionId: target.checkoutSessionId,
        note: `Reversal — ${target.note}`,
        date: fmtDate(new Date()),
      };
      return [...prev, entry];
    });
  }, []);

  const trackClick = useCallback(() => setClicks(c => c + 1), []);

  // ── Deprecated shims ─────────────────────────────────────────────────────
  const spendCredit = useCallback(
    (amount: number) => {
      const ts = Date.now();
      recordCreditSpend(`ord_legacy_${ts}`, `sess-legacy-${ts}`, amount);
    },
    [recordCreditSpend]
  );

  const addEarning = useCallback(
    (purchaseAmount: number, label: string) => recordReferralEarn(purchaseAmount, label),
    [recordReferralEarn]
  );

  return (
    <RewardsContext.Provider value={{
      ledger,
      balance,
      totalEarned,
      clicks,
      referralOrders,
      isMember,
      membershipExpiresAt,
      history,
      membershipCovered,
      shoppingCredit,
      membershipProgress,
      hasProcessedSession,
      recordCreditSpend,
      recordReferralEarn,
      applyMembershipEarnings,
      refundOrder,
      reverseEntry,
      trackClick,
      spendCredit,
      addEarning,
    }}>
      {children}
    </RewardsContext.Provider>
  );
}

export function useRewards() {
  return useContext(RewardsContext);
}
