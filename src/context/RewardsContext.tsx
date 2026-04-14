import React, { createContext, useContext, useState } from 'react';

export type EarningType = 'referral' | 'review' | 'purchase';

export type EarningEntry = {
  id: string;
  type: EarningType;
  label: string;
  points: number;
  date: string;
};

type RewardsState = {
  points: number;
  totalEarned: number;
  clicks: number;
  referralOrders: number;
  history: EarningEntry[];
};

type RewardsCtx = RewardsState & {
  addPoints: (pts: number, type: EarningType, label: string) => void;
  redeemPoints: (pts: number) => void;
  trackClick: () => void;
};

const RewardsContext = createContext<RewardsCtx>(null!);

const INITIAL_HISTORY: EarningEntry[] = [
  { id: '1', type: 'referral', label: 'Referral purchase — Sarah M.', points: 500, date: 'Mar 10, 2026' },
  { id: '2', type: 'review', label: 'Review submitted — Minimalist Sofa', points: 100, date: 'Mar 5, 2026' },
  { id: '3', type: 'referral', label: 'Referral click bonus', points: 50, date: 'Feb 28, 2026' },
  { id: '4', type: 'purchase', label: 'Order ORD-001 reward', points: 600, date: 'Feb 15, 2026' },
];

export function RewardsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RewardsState>({
    points: 1250,
    totalEarned: 2475,
    clicks: 12,
    referralOrders: 3,
    history: INITIAL_HISTORY,
  });

  const addPoints = (pts: number, type: EarningType, label: string) => {
    const entry: EarningEntry = {
      id: Date.now().toString(),
      type,
      label,
      points: pts,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    };
    setState(prev => ({
      ...prev,
      points: prev.points + pts,
      totalEarned: prev.totalEarned + pts,
      history: [entry, ...prev.history],
    }));
  };

  const redeemPoints = (pts: number) => {
    setState(prev => ({ ...prev, points: Math.max(0, prev.points - pts) }));
  };

  const trackClick = () => {
    setState(prev => ({
      ...prev,
      clicks: prev.clicks + 1,
      points: prev.points + 10,
      totalEarned: prev.totalEarned + 10,
    }));
  };

  return (
    <RewardsContext.Provider value={{ ...state, addPoints, redeemPoints, trackClick }}>
      {children}
    </RewardsContext.Provider>
  );
}

export function useRewards() {
  return useContext(RewardsContext);
}
