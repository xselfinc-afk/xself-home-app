/**
 * Home section title remote config.
 *
 * Loads section titles from Supabase `home_content_config`.
 * Falls back to hardcoded premium defaults if the network call fails
 * or the table is unavailable.
 */

import { supabase } from '../lib/supabase';

export type HomeSectionTitles = {
  newArrivals: string;
  topPicks: string;
  bestSellers: string;
  allProducts: string;
};

const DEFAULTS: HomeSectionTitles = {
  newArrivals: 'New This Season',
  topPicks: 'Handpicked For You',
  bestSellers: 'Loved By Our Customers',
  allProducts: 'Explore All Products',
};

const KEY_MAP: Record<string, keyof HomeSectionTitles> = {
  'home.section.new_arrivals': 'newArrivals',
  'home.section.top_picks':    'topPicks',
  'home.section.best_sellers': 'bestSellers',
  'home.section.all_products': 'allProducts',
};

export async function loadHomeSectionTitles(): Promise<HomeSectionTitles> {
  try {
    const { data, error } = await supabase
      .from('home_content_config')
      .select('key, value')
      .eq('screen', 'home')
      .eq('is_active', true);

    if (error || !data) return DEFAULTS;

    const titles: HomeSectionTitles = { ...DEFAULTS };
    for (const row of data) {
      const field = KEY_MAP[row.key];
      if (field && row.value) titles[field] = row.value;
    }
    return titles;
  } catch {
    return DEFAULTS;
  }
}
