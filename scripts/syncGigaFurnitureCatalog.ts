/**
 * Bulk Furniture catalog sync — GIGA seller portal → Supabase giga_products.
 *
 * Flow:
 *   1. Open GIGA home page with saved session
 *   2. Expand the left-side category menu if collapsed
 *   3. Hover the left-side "Furniture" menu item to reveal second-level categories
 *   4. Skip "Youth, Kids & Baby Furniture" (and any matching /youth|kids|baby/i)
 *   5. For each allowed category: navigate, paginate listing pages, extract product cards
 *   6. Upsert every card into giga_products via (product_id) conflict key
 */

import 'dotenv/config';
import { chromium, Page } from 'playwright';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { gigaRequest } from '../src/services/gigaApiClient';
import * as path from 'path';
import * as fs from 'fs';

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SESSION_FILE =
  process.env.GIGA_SESSION_FILE ??
  path.join(process.cwd(), 'scripts', '.giga-session.json');

const HOME_URL =
  process.env.HOME_URL ??
  'https://www.gigab2b.com/index.php?route=common/home';

const DRY_RUN = process.env.DRY_RUN === '1';
const HEADED = process.env.HEADED === '1';
const MAX_PAGES = process.env.MAX_PAGES ? readIntEnv('MAX_PAGES', Infinity) : Infinity;
const PAGE_DELAY_MS = readIntEnv('PAGE_DELAY_MS', 800);
const UPSERT_BATCH_SIZE = 500;

const EXCLUDE_SUBCATEGORY_RE = /youth|kids|baby/i;
const FURNITURE_L2_RE =
  /^(bedroom furniture|dining furniture|primary living space|office|game\s*&\s*recreation|youth,\s*kids\s*&\s*baby furniture)$/i;

// Extraction strategy: 'api' (REST API), 'playwright' (browser), 'auto' (try API first)
const STRATEGY = (process.env.STRATEGY ?? 'auto') as 'api' | 'playwright' | 'auto';

// GIGA REST API paths (same base URL and signing as gigaApiClient.ts)
const API_SKU_LIST = '/b2b-overseas-api/v1/buyer/product/skus/v1';
const API_DETAIL   = '/b2b-overseas-api/v1/buyer/product/detailInfo/v1';
const API_PRICE    = '/b2b-overseas-api/v1/buyer/product/price/v1';
const DETAIL_BATCH = 10; // SKUs per detailInfo request (keep small to avoid timeouts)
const PRICE_BATCH  = 20; // SKUs per price request

type ProductCard = {
  productId: string;
  productUrl: string;
  title: string;
  priceText: string;
  imageUrl: string;
  itemCode: string | null;
  subCategory: string;
  sourcePage: string;
};

type Subcategory = {
  name: string;
  url: string;
};

type MenuCandidate = {
  text: string;
  tag: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strategy: string;
};

type CategoryLink = { name: string; url: string };

type FlyoutCandidate = {
  text: string;
  tag: string;
  x: number;
  y: number;
  href: string | null;
  hasClickableAncestor: boolean;
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function dedupeCardsByProductId(cards: ProductCard[]): ProductCard[] {
  const map = new Map<string, ProductCard>();
  for (const card of cards) {
    if (!card.productId) continue;
    if (!map.has(card.productId)) map.set(card.productId, card);
  }
  return [...map.values()];
}

function isLoginPage(text: string, url: string): boolean {
  return (
    (/log\s*in|sign\s*in|password/i.test(text) && !/product|category/i.test(text)) ||
    /login|sign-in/i.test(url)
  );
}

async function enumerateLeftNavItems(page: Page): Promise<MenuCandidate[]> {
  console.log('[sync] evaluate: enumerateLeftNavItems');
  return page.evaluate(() => {
    const LEFT_BOUNDARY = Math.min(window.innerWidth * 0.42, 520);
    const TOP_LIMIT = Math.min(window.innerHeight * 0.82, 900);
    const results: MenuCandidate[] = [];
    const seenText = new Set<string>();

    document.querySelectorAll('a, li, div, span, button').forEach(el => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (rect.left > LEFT_BOUNDARY) return;
      if (rect.top < 0 || rect.top > TOP_LIMIT) return;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (parseFloat(style.opacity ?? '1') === 0) return;

      const text = ((el as HTMLElement).innerText ?? '').trim();
      if (!text || text.length > 60 || seenText.has(text)) return;

      if (
        /popular searches|frequently-used filters|qty available|first arrival date|seller giga index|^and$|edit/i.test(
          text,
        )
      ) {
        return;
      }

      if (el.querySelectorAll('a, li').length > 3) return;
      seenText.add(text);

      results.push({
        text,
        tag: el.tagName.toLowerCase(),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        strategy: 'enumeration',
      });
    });

    return results.slice(0, 80);
  }) as Promise<MenuCandidate[]>;
}

async function findFurnitureNode(page: Page): Promise<MenuCandidate | null> {
  console.log('[sync] evaluate: findFurnitureNode');
  return page.evaluate(() => {
    const TEXT_RE = /^Furniture$/i;
    const LEFT_BOUND = Math.min(window.innerWidth * 0.42, 520);
    const TOP_MIN = 120;
    const TOP_MAX = Math.min(window.innerHeight * 0.82, 900);

    let best: Element | null = null;
    let bestScore = -Infinity;

    document.querySelectorAll('a, li, div, span, button').forEach(el => {
      const txt = (el as HTMLElement).innerText?.trim() ?? '';
      if (!TEXT_RE.test(txt)) return;

      const r = (el as HTMLElement).getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (r.left > LEFT_BOUND) return;
      if (r.top < TOP_MIN || r.top > TOP_MAX) return;

      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return;
      if (parseFloat(s.opacity ?? '1') === 0) return;

      const tag = el.tagName.toLowerCase();

      let score = 3000;
      score -= r.left * 3;
      score -= r.top * 1.2;
      score -= r.width * 0.6;
      score -= r.height * 0.6;

      if (tag === 'li') score += 300;
      if (tag === 'a') score += 250;
      if (tag === 'div') score += 50;
      if (tag === 'span') score += 20;

      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    });

    if (!best) return null;

    const r = (best as HTMLElement).getBoundingClientRect();
    return {
      text: (best as HTMLElement).innerText?.trim() ?? '',
      tag: best.tagName.toLowerCase(),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      width: Math.round(r.width),
      height: Math.round(r.height),
      strategy: 'relaxed-left-nav',
    };
  }) as Promise<MenuCandidate | null>;
}

async function snapshotCategoryHrefs(page: Page): Promise<Set<string>> {
  console.log('[sync] evaluate: snapshotCategoryHrefs');
  const hrefs: string[] = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('a[href*="product_category_id="]').forEach(el => {
      const a = el as HTMLAnchorElement;
      if (!a.href) return;
      try {
        if (new URL(a.href).searchParams.get('product_category_id') === '10013') return;
      } catch {
        return;
      }
      const r = a.getBoundingClientRect();
      const s = window.getComputedStyle(a);
      if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') {
        out.push(a.href);
      }
    });
    return out;
  });
  return new Set(hrefs);
}

async function extractVisibleCategoryLinks(page: Page): Promise<CategoryLink[]> {
  console.log('[sync] evaluate: extractVisibleCategoryLinks');
  return page.evaluate(() => {
    const results: { name: string; url: string }[] = [];
    const seen = new Set<string>();

    document.querySelectorAll('a[href*="product_category_id="]').forEach(el => {
      const a = el as HTMLAnchorElement;
      const href = a.href ?? '';
      const text = (a.innerText ?? a.textContent ?? '').trim();

      if (!href || !text || seen.has(href)) return;

      try {
        if (new URL(href).searchParams.get('product_category_id') === '10013') return;
      } catch {
        return;
      }

      const r = a.getBoundingClientRect();
      const s = window.getComputedStyle(a);

      const visible =
        r.width > 0 &&
        r.height > 0 &&
        s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        parseFloat(s.opacity ?? '1') > 0;

      if (!visible) return;

      seen.add(href);
      results.push({ name: text, url: href });
    });

    return results;
  });
}

async function snapshotVisibleTexts(page: Page): Promise<string[]> {
  console.log('[sync] evaluate: snapshotVisibleTexts');
  return page.evaluate(() => {
    const texts: string[] = [];
    const seen = new Set<string>();

    document.querySelectorAll('*').forEach(el => {
      if (el.querySelectorAll('*').length > 3) return;
      const txt = (el as HTMLElement).innerText?.trim() ?? '';
      if (!txt || txt.length > 80 || seen.has(txt)) return;

      const r = (el as HTMLElement).getBoundingClientRect();
      const s = window.getComputedStyle(el);
      if (!r.width || !r.height || s.display === 'none' || s.visibility === 'hidden') return;

      seen.add(txt);
      texts.push(txt);
    });

    return texts;
  });
}

async function extractFlyoutCandidates(
  page: Page,
  beforeTexts: string[],
): Promise<FlyoutCandidate[]> {
  console.log('[sync] evaluate: extractFlyoutCandidates');
  return page.evaluate((beforeArr: string[]) => {
    const beforeSet = new Set(beforeArr);
    const results: FlyoutCandidate[] = [];
    const seen = new Set<string>();

    document.querySelectorAll('a, li, div, span, button').forEach(el => {
      const txt = (el as HTMLElement).innerText?.trim() ?? '';
      if (!txt || txt.length > 80 || seen.has(txt)) return;
      if (beforeSet.has(txt)) return;

      const r = (el as HTMLElement).getBoundingClientRect();
      const s = window.getComputedStyle(el);
      if (!r.width || !r.height) return;
      if (s.display === 'none' || s.visibility === 'hidden') return;
      if (parseFloat(s.opacity ?? '1') === 0) return;

      seen.add(txt);

      const tag = el.tagName.toLowerCase();
      let href: string | null = null;
      let hasClickableAncestor = false;

      if (tag === 'a') {
        const h = (el as HTMLAnchorElement).href ?? '';
        if (h && !h.startsWith('javascript:') && h !== '#' && h !== window.location.href) {
          href = h;
        }
      }

      if (!href) {
        let anc = (el as HTMLElement).parentElement;
        while (anc && anc !== document.body) {
          const ancTag = anc.tagName.toLowerCase();

          if (ancTag === 'a') {
            const h = (anc as HTMLAnchorElement).href ?? '';
            if (h && !h.startsWith('javascript:') && h !== '#' && h !== window.location.href) {
              href = h;
              hasClickableAncestor = true;
            }
            break;
          }

          if (
            ancTag === 'button' ||
            (anc as HTMLElement).getAttribute('onclick') ||
            (anc as HTMLElement).getAttribute('role') === 'button'
          ) {
            hasClickableAncestor = true;
            break;
          }

          anc = anc.parentElement;
        }
      }

      results.push({
        text: txt,
        tag,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        href,
        hasClickableAncestor,
      });
    });

    results.sort((a, b) => a.y - b.y);
    return results.slice(0, 40);
  }, beforeTexts) as Promise<FlyoutCandidate[]>;
}

async function expandCategoryMenu(page: Page): Promise<void> {
  const furnitureAlreadyVisible = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('a, li, div, span, button')) as HTMLElement[];
    return candidates.some(el => {
      const txt = el.innerText?.trim() ?? '';
      if (!/^Furniture$/i.test(txt)) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.left < Math.min(window.innerWidth * 0.42, 520) &&
        r.top > 120 &&
        r.top < Math.min(window.innerHeight * 0.82, 900) &&
        s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        parseFloat(s.opacity ?? '1') > 0
      );
    });
  });

  if (furnitureAlreadyVisible) {
    console.log('[sync] Category menu already expanded');
    return;
  }

  console.log('[sync] evaluate: findCategoriesHeader');

  const headerInfo = await page.evaluate(() => {
    const HEADER_RE = /^categories:?$/i;
    const LEFT_BOUND = Math.min(window.innerWidth * 0.18, 180);
    const TOP_MIN = 250;
    const TOP_MAX = 460;

    let best: Element | null = null;
    let bestScore = -Infinity;

    document.querySelectorAll('*').forEach(el => {
      const txt = (el as HTMLElement).innerText?.trim() ?? '';
      if (!HEADER_RE.test(txt)) return;

      const r = (el as HTMLElement).getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (r.left > LEFT_BOUND) return;
      if (r.top < TOP_MIN || r.top > TOP_MAX) return;

      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return;
      if (parseFloat(s.opacity ?? '1') === 0) return;

      const score = 2000 - r.left * 10 - r.top * 1.5 - r.width * 0.3;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    });

    if (!best) return null;

    const r = (best as HTMLElement).getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      text: (best as HTMLElement).innerText?.trim() ?? '',
      tag: best.tagName.toLowerCase(),
      top: Math.round(r.top),
      left: Math.round(r.left),
    };
  });

  if (!headerInfo) {
    console.log('[sync] Categories header not found');
    return;
  }

  console.log(
    `[sync] ✓ Found Categories header: <${headerInfo.tag}> "${headerInfo.text}" at (${headerInfo.x},${headerInfo.y}) top=${headerInfo.top} left=${headerInfo.left}`,
  );

  await page.mouse.click(headerInfo.x, headerInfo.y);
  console.log('[sync] Expansion attempt: click');
  await page.waitForTimeout(800);
}

async function discoverSubcategories(page: Page): Promise<Subcategory[]> {
  console.log('[sync] Loading home page for menu discovery:', HOME_URL);

  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    console.log('[sync] ⚠ Home page load timeout — continuing with partial content');
  }

  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? '');
  if (isLoginPage(bodyText, page.url())) {
    console.error('[sync] ✗ Session expired — re-run saveGigaSession.ts');
    process.exit(1);
  }

  await expandCategoryMenu(page);

  console.log('[sync] Discovery mode: scanning left-nav candidates...');
  const navItems = await enumerateLeftNavItems(page);
  console.log(`[sync] Left-nav candidates found: ${navItems.length}`);
  navItems.forEach(item => {
    console.log(
      `[sync]   <${item.tag}> "${item.text}" at (${item.x},${item.y}) ${item.width}×${item.height}`,
    );
  });

  console.log('[sync] Finding "Furniture" node...');
  const furnitureNode = await findFurnitureNode(page);

  if (!furnitureNode) {
    console.log('[sync] ✗ "Furniture" not found with any strategy');
    console.log('[sync]   Try HEADED=1 to inspect the page. Is the session still valid?');
    return [];
  }

  console.log(
    `[sync] ✓ Furniture node found via strategy ${furnitureNode.strategy}: <${furnitureNode.tag}> "${furnitureNode.text}" at (${furnitureNode.x},${furnitureNode.y}) ${furnitureNode.width}×${furnitureNode.height}`,
  );

  const beforeHrefs = await snapshotCategoryHrefs(page);
  console.log(`[sync] Category links visible before hover: ${beforeHrefs.size}`);

  const beforeTexts = await snapshotVisibleTexts(page);
  console.log(`[sync] Text items visible before hover: ${beforeTexts.length}`);

  await page.mouse.move(furnitureNode.x, furnitureNode.y);
  console.log(
    `[sync] ✓ Hover success — mouse at (${furnitureNode.x},${furnitureNode.y}), waiting for flyout...`,
  );
  await page.waitForTimeout(800);

  const allVisible = await extractVisibleCategoryLinks(page);
  const newLinks = allVisible.filter(l => !beforeHrefs.has(l.url));

  console.log(
    `[sync] Phase 1 (href): ${newLinks.length} new link(s), ${allVisible.length} total visible`,
  );

  let raw: CategoryLink[] = [];

  if (newLinks.length > 0) {
    raw = newLinks;
    console.log('[sync] Phase 1: using delta href links:');
    raw.forEach(sc => console.log(`[sync]   • "${sc.name}" → ${sc.url}`));
  } else if (allVisible.length > 0) {
    raw = allVisible;
    console.log('[sync] Phase 1 (Strategy D): using all visible href links:');
    raw.forEach(sc => console.log(`[sync]   • "${sc.name}" → ${sc.url}`));
  } else {
    console.log('[sync] Phase 1 found nothing — trying text-based flyout extraction...');
    const candidates = await extractFlyoutCandidates(page, beforeTexts);

    console.log(`[sync] Flyout text candidates (raw): ${candidates.length}`);
    candidates.forEach(c => {
      console.log(
        `[sync]   <${c.tag}> "${c.text}" href=${c.href ? c.href.slice(0, 70) : 'none'} clickable-ancestor=${c.hasClickableAncestor}`,
      );
    });

    const validCandidates = candidates.filter(c => FURNITURE_L2_RE.test(c.text));
    console.log(
      `[sync] Valid second-level candidates after whitelist filter: ${validCandidates.length}`,
    );
    validCandidates.forEach(c => {
      console.log(`[sync]   ✓ "${c.text}" href=${c.href ? 'present' : 'none'}`);
    });

    for (const c of validCandidates) {
      if (c.href) raw.push({ name: c.text, url: c.href });
    }

    if (raw.length > 0) {
      console.log(`[sync] Phase 2a: ${raw.length} link(s) resolved from ancestor hrefs`);
      raw.forEach(sc => console.log(`[sync]   • "${sc.name}" → ${sc.url}`));
    }

    const resolvedNames = new Set(raw.map(r => r.name));
    const noHrefNames = validCandidates
      .filter(c => !c.href && !EXCLUDE_SUBCATEGORY_RE.test(c.text) && !resolvedNames.has(c.text))
      .map(c => c.text);

    if (noHrefNames.length > 0) {
      console.log(
        `[sync] Phase 2b: resolving ${noHrefNames.length} no-href candidate(s) by click-and-navigate...`,
      );

      for (let i = 0; i < noHrefNames.length; i++) {
        const candidateName = noHrefNames[i];

        try {
          await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        } catch {
          // timeout ok
        }

        await expandCategoryMenu(page);

        const refreshedFurnitureNode = await findFurnitureNode(page);
        if (!refreshedFurnitureNode) {
          console.log(`[sync] ✗ Could not re-find Furniture for "${candidateName}"`);
          continue;
        }

        await page.mouse.move(refreshedFurnitureNode.x, refreshedFurnitureNode.y);
        await page.waitForTimeout(1000);

        const liveCandidate = await page.evaluate((targetText: string) => {
          const els = Array.from(document.querySelectorAll('a, li, div, span, button')) as HTMLElement[];

          let best: HTMLElement | null = null;
          let bestScore = -Infinity;

          for (const el of els) {
            const txt = el.innerText?.trim() ?? '';
            if (txt !== targetText) continue;

            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;

            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            if (parseFloat(s.opacity ?? '1') === 0) continue;

            const score = r.left * 2 - r.top * 0.2 - r.width * 0.05;
            if (score > bestScore) {
              best = el;
              bestScore = score;
            }
          }

          if (!best) return null;

          const r = best.getBoundingClientRect();
          return {
            text: best.innerText?.trim() ?? '',
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
          };
        }, candidateName);

        if (!liveCandidate) {
          console.log(`[sync] ✗ Could not locate visible flyout item for "${candidateName}"`);
          continue;
        }

        console.log(
          `[sync]   [${i + 1}/${noHrefNames.length}] click-resolve: "${liveCandidate.text}" at (${liveCandidate.x},${liveCandidate.y})`,
        );

        const startUrl = page.url();
        let urlChanged = false;
        let usedStrategy = '';

        await page.mouse.click(liveCandidate.x, liveCandidate.y);

        try {
          await page.waitForURL(url => url.href !== startUrl, { timeout: 4000 });
          urlChanged = true;
          usedStrategy = 'mouse-click';
        } catch {
          // no-op
        }

        if (!urlChanged) {
          await page.evaluate((txt: string) => {
            const els = Array.from(document.querySelectorAll('a, li, div, span, button')) as HTMLElement[];
            for (const el of els) {
              if ((el.innerText?.trim() ?? '') !== txt) continue;
              el.click();
              break;
            }
          }, candidateName);

          try {
            await page.waitForURL(url => url.href !== startUrl, { timeout: 4000 });
            urlChanged = true;
            usedStrategy = 'evaluate-click';
          } catch {
            // no-op
          }
        }

        const newUrl = page.url();
        console.log(
          `[sync]   strategy=${usedStrategy || 'all-failed'} urlChanged=${urlChanged} → ${newUrl.slice(0, 100)}`,
        );

        if (urlChanged && /category|product/i.test(newUrl)) {
          raw.push({ name: candidateName, url: newUrl });
          console.log(`[sync]   ✓ Resolved: "${candidateName}"`);
        } else {
          console.log(`[sync]   ✗ Could not resolve: "${candidateName}"`);
        }
      }

      const newlyResolved = raw.filter(r => !resolvedNames.has(r.name));
      console.log(`[sync] Phase 2b resolved: ${newlyResolved.length} new link(s)`);
    }

    console.log(`[sync] Phase 2 total: ${raw.length} link(s)`);
    raw.forEach(sc => console.log(`[sync]   • "${sc.name}" → ${sc.url}`));

    if (raw.length === 0) {
      console.log('[sync] ✗ No category links found after all phases');
      console.log('[sync]   Try HEADED=1 to inspect flyout state after hover');
      return [];
    }
  }

  const filtered = raw.filter(sc => {
    if (EXCLUDE_SUBCATEGORY_RE.test(sc.name)) {
      console.log(`[sync] Excluded: "${sc.name}"`);
      return false;
    }
    return true;
  });

  console.log(`[sync] Final extracted categories: ${filtered.length}`);
  return filtered;
}

async function extractChildCategoryLinks(page: Page): Promise<{ name: string; url: string }[]> {
  return page.evaluate(() => {
    const results: { name: string; url: string }[] = [];
    const seen = new Set<string>();
    const currentUrl = window.location.href;

    const links = Array.from(
      document.querySelectorAll('a[href*="product_category_id="]'),
    ) as HTMLAnchorElement[];

    for (const a of links) {
      const href = a.href ?? '';
      const text = (a.innerText ?? a.textContent ?? '').trim();

      if (!href || !text || seen.has(href)) continue;
      if (href === currentUrl) continue;

      try {
        const url = new URL(href);
        const catId = url.searchParams.get('product_category_id');
        if (!catId) continue;
      } catch {
        continue;
      }

      const r = a.getBoundingClientRect();
      const s = window.getComputedStyle(a);
      const visible =
        r.width > 0 &&
        r.height > 0 &&
        s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        parseFloat(s.opacity ?? '1') > 0;

      if (!visible) continue;

      seen.add(href);
      results.push({ name: text, url: href });
    }

    return results;
  });
}

async function extractProductCards(
  page: Page,
  subCategory: string,
  sourcePage: string,
): Promise<ProductCard[]> {
  const pageInfo = await page.evaluate(() => {
    const hEl = document.querySelector('h1, h2, .page-title, #content h1') as HTMLElement | null;
    return {
      title: document.title ?? '',
      heading: hEl?.innerText?.trim() ?? '',
      bodyPreview: document.body?.innerText?.slice(0, 500) ?? '',
    };
  });

  console.log(
    `[sync]   Page: title="${pageInfo.title.slice(0, 80)}" heading="${pageInfo.heading.slice(0, 80)}"`,
  );

  const result = await page.evaluate(
    ({ subCategory, sourcePage }: { subCategory: string; sourcePage: string }) => {
      const cards: {
        productId: string | null;
        productUrl: string;
        title: string;
        priceText: string;
        imageUrl: string;
        itemCode: string | null;
        subCategory: string;
        sourcePage: string;
      }[] = [];

      const seenProductIds = new Set<string>();
      const allLinks = Array.from(document.querySelectorAll('a[href*="product_id="]')) as HTMLAnchorElement[];

      const debugLinks = allLinks.slice(0, 10).map(a => ({
        text: (a.innerText ?? a.textContent ?? '').trim().slice(0, 80),
        href: a.href,
      }));

      for (const link of allLinks) {
        const href = link.href ?? '';
        if (!href) continue;

        let productId: string | null = null;
        try {
          productId = new URL(href).searchParams.get('product_id');
        } catch {
          productId = null;
        }

        if (!productId || seenProductIds.has(productId)) continue;
        seenProductIds.add(productId);

        let container: HTMLElement | null = link;
        let bestContainer: HTMLElement | null = link;

        while (container && container !== document.body) {
          const txt = container.innerText ?? '';
          const hasImg = container.querySelector('img') !== null;
          const looksRichEnough =
            txt.trim().length > 20 ||
            /\$/.test(txt) ||
            /item|model|sku/i.test(txt);

          if (hasImg && looksRichEnough) {
            bestContainer = container;
          }

          if (container.querySelectorAll('a[href*="product_id="]').length > 1) {
            break;
          }

          container = container.parentElement;
        }

        const cardEl = bestContainer;

        const title =
          (link.innerText ?? link.textContent ?? '').trim() ||
          (cardEl.querySelector('img') as HTMLImageElement | null)?.alt?.trim() ||
          '';

        const cardText = cardEl.innerText ?? '';

        const priceMatch =
          cardText.match(/\$\s?\d[\d,.]*(?:\.\d{2})?/) ??
          cardText.match(/\d[\d,.]*(?:\.\d{2})?\s?USD/i);

        const priceText = priceMatch ? priceMatch[0].replace(/\s+/g, ' ').trim() : '';

        const imgEl = cardEl.querySelector('img') as HTMLImageElement | null;
        const imageUrl =
          imgEl?.src ??
          imgEl?.getAttribute('data-src') ??
          imgEl?.getAttribute('data-original') ??
          '';

        const itemCodeMatch =
          cardText.match(/\bItem\s*#?\s*([A-Z0-9\-]{4,})/i) ??
          cardText.match(/\bModel\s*:\s*([A-Z0-9\-]{4,})/i) ??
          cardText.match(/\bSKU\s*:\s*([A-Z0-9\-]{4,})/i);

        const itemCode = itemCodeMatch ? itemCodeMatch[1].trim() : null;

        cards.push({
          productId,
          productUrl: href,
          title,
          priceText,
          imageUrl,
          itemCode,
          subCategory,
          sourcePage,
        });
      }

      return {
        cards,
        productLinkCount: allLinks.length,
        debugLinks,
      };
    },
    { subCategory, sourcePage },
  );

  console.log(`[sync]   Product ID links found: ${result.productLinkCount}`);
  result.debugLinks.forEach((x, i) => {
    console.log(`[sync]   link[${i}]: "${x.text}" → ${x.href.slice(0, 100)}`);
  });

  const finalCards = dedupeCardsByProductId(
    result.cards.filter((c): c is ProductCard => c.productId !== null) as ProductCard[],
  );

  console.log(`[sync]   Final extracted cards: ${finalCards.length}`);
  finalCards.slice(0, 5).forEach((c, i) => {
    console.log(`[sync]   card[${i}]: [${c.productId}] "${c.title.slice(0, 70)}" | ${c.priceText}`);
  });

  return finalCards;
}

async function getNextPageUrl(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const currentUrl = window.location.href;

    const relNext = document.querySelector('a[rel="next"]') as HTMLAnchorElement | null;
    if (relNext?.href && relNext.href !== currentUrl && !/^javascript:/i.test(relNext.href)) {
      return relNext.href;
    }

    const links = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];

    for (const a of links) {
      const href = a.href ?? '';
      const text = a.innerText?.trim() ?? '';
      if (!href || href === currentUrl || /^javascript:/i.test(href)) continue;
      if (/^(next|>|›|»)$/i.test(text)) return href;
      if (a.getAttribute('aria-label')?.match(/next/i)) return href;
      if (a.className?.match(/next/i)) return href;
    }

    return null;
  });
}

async function scrapeSubcategory(page: Page, subcategory: Subcategory): Promise<ProductCard[]> {
  const allCards: ProductCard[] = [];
  let url: string | null = subcategory.url;
  let pageNum = 0;

  console.log(`\n[sync] ── Subcategory: "${subcategory.name}"`);

  while (url && pageNum < MAX_PAGES) {
    pageNum++;
    console.log(`[sync]   Page ${pageNum}: ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      console.log(`[sync]   ⚠ Page load timeout on page ${pageNum} — skipping`);
      break;
    }

    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '');
    if (isLoginPage(bodyText, page.url())) {
      console.error('[sync] ✗ Session expired mid-sync — re-run saveGigaSession.ts');
      process.exit(1);
    }

    let cards = await extractProductCards(page, subcategory.name, url);
    console.log(`[sync]   Extracted ${cards.length} direct product(s)`);

    if (cards.length === 0) {
      const childCategories = await extractChildCategoryLinks(page);
      console.log(`[sync]   Child category links found: ${childCategories.length}`);

      const filteredChildren = childCategories.filter(c => {
        const lower = c.name.trim().toLowerCase();

        if (/home|new arrivals|help center|buyer central|logout/i.test(lower)) return false;
        if (/popular searches|frequently-used filters|qty available|first arrival date/i.test(lower)) return false;
        if (c.url === url) return false;

        return true;
      });

      filteredChildren.slice(0, 10).forEach((c, i) => {
        console.log(`[sync]   child[${i}]: "${c.name}" → ${c.url}`);
      });

      for (const child of filteredChildren) {
        try {
          await page.goto(child.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        } catch {
          console.log(`[sync]   ⚠ Child page load timeout: ${child.url}`);
          continue;
        }

        const childCards = await extractProductCards(
          page,
          `${subcategory.name} > ${child.name}`,
          child.url,
        );

        console.log(`[sync]   Child "${child.name}" extracted ${childCards.length} product(s)`);

        allCards.push(...childCards);

        await delay(PAGE_DELAY_MS);
      }

      break;
    }

    allCards.push(...cards);

    const nextUrl = await getNextPageUrl(page);
    url = nextUrl;

    if (url && pageNum < MAX_PAGES) {
      await delay(PAGE_DELAY_MS);
    }
  }

  const deduped = dedupeCardsByProductId(allCards);
  console.log(`[sync] Subcategory "${subcategory.name}" total: ${deduped.length} product(s)`);
  return deduped;
}

async function upsertProducts(supabase: SupabaseClient, cards: ProductCard[]): Promise<void> {
  if (cards.length === 0) return;

  const now = new Date().toISOString();
  const rows = dedupeCardsByProductId(cards).map(c => ({
    product_id: c.productId,
    product_url: c.productUrl,
    title: c.title,
    price_text: c.priceText,
    image_url: c.imageUrl,
    item_code: c.itemCode ?? null,
    top_category: 'Furniture',
    sub_category: c.subCategory,
    source_page: c.sourcePage,
    raw_payload: c as unknown as Record<string, unknown>,
    last_synced_at: now,
  }));

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);

    const { error } = await supabase
      .from('giga_products')
      .upsert(chunk, { onConflict: 'product_id', ignoreDuplicates: false });

    if (error) {
      console.log(
        `[Supabase] ✗ Upsert error on batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}: ${error.message}`,
      );
    } else {
      console.log(`[Supabase] ✓ Upserted ${chunk.length} row(s)`);
    }
  }
}

// ── API-based catalog sync ─────────────────────────────────────────────────────
//
// Preferred strategy. Uses GIGA's REST API (same signing as gigaApiClient.ts).
// No browser session required. Pages through the full SKU list, enriches each
// SKU with detailInfo (category, images) and price, then returns ProductCard[].
//
// API behaviour discovered via scripts/debugGigaApi.ts:
//   • pageSize MUST be 100 (smaller values return B20002 "enum range" error)
//   • pagination envelope: data.pageInfo.{ page, totalPage, totalNum } + data.records[]
//   • detailInfo returns: sku, productName, imageUrls[], mainImageUrl, category, categoryCode, skuAvailable
//   • price returns: sku, price (USD number), skuAvailable
//   • No category-filter parameter on SKU list; filter client-side via detailInfo.category
// ─────────────────────────────────────────────────────────────────────────────

type ApiSkuItem = { sku: string; productName: string; updateTime?: string };
type ApiDetailItem = {
  sku: string; mpn?: string; productName: string;
  imageUrls?: string[]; mainImageUrl?: string;
  category?: string; categoryCode?: string; skuAvailable?: boolean;
};
type ApiPriceItem = { sku: string; price?: number; currency?: string; skuAvailable?: boolean };

/** Page through /product/skus/v1 and collect all SKU records. pageSize must be 100. */
async function apiListAllSkus(): Promise<ApiSkuItem[]> {
  const all: ApiSkuItem[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    console.log(`[sync:api] SKU list page ${page}/${totalPages === 1 && page === 1 ? '?' : totalPages}...`);
    const res = await gigaRequest(API_SKU_LIST, { page, pageSize: 100 });
    const pageInfo: Record<string, number> = res?.data?.pageInfo ?? {};
    const records: ApiSkuItem[] = res?.data?.records ?? [];
    if (page === 1) totalPages = pageInfo.totalPage ?? 1;
    all.push(...records);
    console.log(`[sync:api]   → ${records.length} records (running total: ${all.length} / ${pageInfo.totalNum ?? '?'})`);
    page++;
    if (page <= totalPages) await delay(PAGE_DELAY_MS);
  } while (page <= totalPages);

  return all;
}

/** Enrich SKUs with detail info (category, images) — batched to avoid API limits. */
async function apiEnrichDetails(skus: string[]): Promise<Map<string, ApiDetailItem>> {
  const map = new Map<string, ApiDetailItem>();
  for (let i = 0; i < skus.length; i += DETAIL_BATCH) {
    const batch = skus.slice(i, i + DETAIL_BATCH);
    const end = Math.min(i + DETAIL_BATCH, skus.length);
    process.stdout.write(`[sync:api] detailInfo ${i + 1}-${end}/${skus.length}... `);
    try {
      const res = await gigaRequest(API_DETAIL, { skus: batch });
      const items: ApiDetailItem[] = Array.isArray(res?.data) ? res.data : [];
      items.forEach(item => map.set(item.sku, item));
      process.stdout.write(`✓ ${items.length}\n`);
    } catch (e) {
      process.stdout.write(`✗ ${(e as Error).message.slice(0, 80)}\n`);
    }
    if (i + DETAIL_BATCH < skus.length) await delay(PAGE_DELAY_MS);
  }
  return map;
}

/** Fetch price for each SKU — batched. */
async function apiEnrichPrices(skus: string[]): Promise<Map<string, ApiPriceItem>> {
  const map = new Map<string, ApiPriceItem>();
  for (let i = 0; i < skus.length; i += PRICE_BATCH) {
    const batch = skus.slice(i, i + PRICE_BATCH);
    const end = Math.min(i + PRICE_BATCH, skus.length);
    process.stdout.write(`[sync:api] price ${i + 1}-${end}/${skus.length}... `);
    try {
      const res = await gigaRequest(API_PRICE, { skus: batch });
      const items: ApiPriceItem[] = Array.isArray(res?.data) ? res.data : [];
      items.forEach(item => map.set(item.sku, item));
      process.stdout.write(`✓ ${items.length}\n`);
    } catch (e) {
      process.stdout.write(`✗ ${(e as Error).message.slice(0, 80)}\n`);
    }
    if (i + PRICE_BATCH < skus.length) await delay(PAGE_DELAY_MS);
  }
  return map;
}

/** Full API sync → returns ProductCard[] for all accessible SKUs. */
async function syncViaApi(): Promise<{ cards: ProductCard[]; categoryBreakdown: Record<string, number> }> {
  const skuList = await apiListAllSkus();
  if (skuList.length === 0) throw new Error('SKU list returned 0 items — check API credentials');

  const skus = skuList.map(s => s.sku);
  const details = await apiEnrichDetails(skus);
  const prices  = await apiEnrichPrices(skus);

  const cards: ProductCard[] = [];
  const categoryBreakdown: Record<string, number> = {};
  let excluded = 0;

  for (const skuItem of skuList) {
    const { sku } = skuItem;
    const detail  = details.get(sku);
    const price   = prices.get(sku);

    const subCategory = detail?.category ?? 'Furniture';

    if (EXCLUDE_SUBCATEGORY_RE.test(subCategory)) {
      excluded++;
      continue;
    }

    categoryBreakdown[subCategory] = (categoryBreakdown[subCategory] ?? 0) + 1;

    const imageUrl  = detail?.mainImageUrl ?? detail?.imageUrls?.[0] ?? '';
    const priceNum  = price?.price;
    const priceText = priceNum != null
      ? `$${priceNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '';

    cards.push({
      productId:  sku,
      productUrl: `https://www.gigab2b.com/index.php?route=product/product&sku=${encodeURIComponent(sku)}`,
      title:      detail?.productName ?? skuItem.productName,
      priceText,
      imageUrl,
      itemCode:   detail?.mpn ?? null,
      subCategory,
      sourcePage: 'giga-api',
    });
  }

  if (excluded > 0) console.log(`[sync:api] Excluded ${excluded} youth/kids/baby SKU(s)`);
  console.log(`[sync:api] Mapped ${cards.length} ProductCards from ${skuList.length} SKUs`);

  return { cards, categoryBreakdown };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function run() {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  let supabase: SupabaseClient | null = null;

  console.log('\n[sync] ══════════════════════════════════════════════════════════');
  console.log(` GIGA Furniture Catalog Sync${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(` Strategy: ${STRATEGY}`);
  console.log('[sync] ══════════════════════════════════════════════════════════\n');

  if (DRY_RUN) {
    console.log('[sync] DRY_RUN=1 — products will be printed but NOT written to Supabase');
  } else if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('[sync] ⚠ Supabase credentials not set — products will be printed only');
    console.log('       Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to enable writes');
  } else {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    console.log('[sync] Supabase write enabled');
  }

  let allCards: ProductCard[] = [];
  let usedStrategy = '';

  // ── Strategy 1: GIGA REST API ─────────────────────────────────────────────
  if (STRATEGY === 'api' || STRATEGY === 'auto') {
    const hasApiCreds = !!(
      process.env.SUPPLIER_API_BASE_URL &&
      process.env.SUPPLIER_CLIENT_ID &&
      process.env.SUPPLIER_CLIENT_SECRET
    );
    if (!hasApiCreds) {
      console.log('[sync] ⚠ Missing SUPPLIER_API_BASE_URL/CLIENT_ID/CLIENT_SECRET — skipping API strategy');
    } else {
      console.log('[sync] ── API Strategy ──────────────────────────────────────────');
      try {
        const { cards, categoryBreakdown } = await syncViaApi();
        allCards = cards;
        usedStrategy = 'api';

        console.log('\n[sync] Category breakdown:');
        for (const [cat, n] of Object.entries(categoryBreakdown).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${String(n).padStart(4)}  ${cat}`);
        }

        if (supabase && allCards.length > 0) {
          await upsertProducts(supabase, allCards);
        }
      } catch (e) {
        console.log(`[sync] ✗ API strategy failed: ${(e as Error).message.slice(0, 200)}`);
        if (STRATEGY === 'api') {
          console.log('[sync] Set STRATEGY=playwright or STRATEGY=auto to enable browser fallback');
          process.exit(1);
        }
      }
    }
  }

  // ── Strategy 2: Playwright browser fallback ───────────────────────────────
  if (allCards.length === 0 && (STRATEGY === 'playwright' || STRATEGY === 'auto')) {
    console.log('\n[sync] ── Playwright Fallback ───────────────────────────────────');

    if (!fs.existsSync(SESSION_FILE)) {
      console.error(`[sync] ✗ Session file not found: ${SESSION_FILE}`);
      console.error('[sync]   Run: npx tsx scripts/saveGigaSession.ts first');
      process.exit(1);
    }

    console.log('[sync] Session file:', SESSION_FILE);
    console.log('[sync] MAX_PAGES per subcategory:', MAX_PAGES === Infinity ? 'unlimited' : MAX_PAGES);

    const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 50 : 0 });
    const context = await browser.newContext({ storageState: SESSION_FILE });
    const page = await context.newPage();
    page.on('console', () => {});

    try {
      const subcategories = await discoverSubcategories(page);
      if (subcategories.length === 0) {
        console.log('[sync] No subcategories found — check the session or try HEADED=1 to inspect the menu.');
      } else {
        for (const sub of subcategories) {
          const cards = await scrapeSubcategory(page, sub);
          allCards.push(...cards);
          if (supabase && cards.length > 0) await upsertProducts(supabase, cards);
          await delay(PAGE_DELAY_MS);
        }
        usedStrategy = 'playwright';
      }
    } finally {
      await browser.close();
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const deduped = dedupeCardsByProductId(allCards);

  console.log('\n[sync] ══════════════════════════════════════════════════════════');
  console.log(' SYNC COMPLETE');
  console.log('[sync] ══════════════════════════════════════════════════════════');
  console.log(` Strategy used    : ${usedStrategy || 'none'}`);
  console.log(` Total products   : ${deduped.length}`);

  if (deduped.length > 0 && (DRY_RUN || !supabase)) {
    console.log('\n Sample products (first 10):');
    deduped.slice(0, 10).forEach((c, i) =>
      console.log(`  ${i + 1}. [${c.productId}] ${c.title.slice(0, 55)} | ${c.priceText} | ${c.subCategory}`),
    );
  }

  if (deduped.length === 0) {
    console.log('\n[sync] ⚠ No products extracted. Troubleshooting:');
    console.log('  API:        Verify SUPPLIER_API_BASE_URL, SUPPLIER_CLIENT_ID, SUPPLIER_CLIENT_SECRET in .env');
    console.log('  Playwright: Run npx tsx scripts/saveGigaSession.ts, then STRATEGY=playwright');
    console.log('  Debug:      npx tsx scripts/debugGigaApi.ts');
  }

  console.log('');
}

run().catch(err => {
  console.error('[sync] Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
