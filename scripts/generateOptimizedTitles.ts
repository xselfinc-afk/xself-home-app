/**
 * generateOptimizedTitles.ts
 *
 * Reads standardized_products rows, strips brand names, formats a clean title,
 * and writes it back to the optimized_title column.
 *
 * Usage:
 *   npx ts-node -e "require('./scripts/generateOptimizedTitles.ts')"
 *   # or with tsx:
 *   npx tsx scripts/generateOptimizedTitles.ts
 *   npx tsx scripts/generateOptimizedTitles.ts --dry-run      # preview only
 *   npx tsx scripts/generateOptimizedTitles.ts --limit 20     # small batch
 *   npx tsx scripts/generateOptimizedTitles.ts --overwrite     # re-generate already-set titles
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { sanitizeSupplierName } from '../src/utils/supplierNameSanitizer';

dotenv.config();

// ── Supabase client ───────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ??        // service-role key preferred for writes
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[generateOptimizedTitles] Missing SUPABASE_URL / key — check .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Brand/supplier name list ──────────────────────────────────────────────────

/**
 * Third-party brand names that must never appear in optimized_title.
 * Add supplier brands here as you discover them.
 */
const BRAND_PATTERNS: RegExp[] = [
  /\bHOMCOM\b/gi,
  /\bTOPMAX\b/gi,
  /\bTREXM\b/gi,
  /\bCOSTWAY\b/gi,
  /\bAosom\b/gi,
  /\bMERETA\b/gi,
  /\bFLAMELUXE\b/gi,
  /\bHARPER\s*&\s*BRIGHT\b/gi,
  /\bHarper\s*&\s*Bright\b/gi,
  /\bFURAMAX\b/gi,
  /\bKRINNA\b/gi,
  /\bBEST\s*CHOICE\s*PRODUCTS\b/gi,
  /\bBCP\b/g,
  /\bMODWAY\b/gi,
  /\bBaxton\s*Studio\b/gi,
  /\bNALTO\b/gi,
  /\bCOSMOLIVING\b/gi,
  /\bFLAMINGO\s*P\b/gi,
  /\bUfficio\b/gi,
  /\bRoxby\b/gi,
  /\bLucid\b/gi,
  /\bZinus\b/gi,
  /\bWayfair\b/gi,
  /\bAmber\s*Home\b/gi,
];

/** Cheap marketing filler to strip. */
const MARKETING_JUNK: RegExp[] = [
  /\bBest\b/gi,
  /\bHot\b(?!\s+(?:tub|spring|pot))/gi,  // keep "Hot Tub" etc.
  /\bPremium\b/gi,
  /\bTop-?Rated\b/gi,
  /\bSuper\b/gi,
  /\bAmazing\b/gi,
  /\bGreat\b/gi,
  /\bEasy\s*Assembly\b/gi,
];

// ── Core title builder ────────────────────────────────────────────────────────

/**
 * Cleans a raw product title:
 * 1. Remove brand names
 * 2. Remove marketing junk
 * 3. Collapse extra whitespace
 * 4. Title-case result
 * 5. Truncate to 110 chars
 */
function buildOptimizedTitle(
  rawTitle: string,
  displayTitle?: string | null,
  shortDesc?: string | null,
  categoryLabel?: string | null,
): string {
  // Prefer display title as starting point — it's already cleaner
  let title = (displayTitle || rawTitle || '').trim();

  // Centralised supplier-prefix removal (K&K, etc.). Mirrors the
  // normalization pipeline so optimized_title stays in lockstep with
  // product_title. Add new supplier names in src/utils/supplierNameSanitizer.ts.
  title = sanitizeSupplierName(title).cleaned;

  // Strip brands
  for (const re of BRAND_PATTERNS) {
    title = title.replace(re, '');
  }

  // Strip marketing junk
  for (const re of MARKETING_JUNK) {
    title = title.replace(re, '');
  }

  // Collapse multiple spaces / leading-trailing dashes or commas left by removal
  title = title
    .replace(/[-,;|–—]+\s*$/, '')       // trailing separators
    .replace(/^\s*[-,;|–—]+/, '')        // leading separators
    .replace(/\s{2,}/g, ' ')             // multiple spaces
    .replace(/\(\s*\)/g, '')             // empty parens
    .trim();

  // Fallback: if we stripped everything, use category label + "Furniture"
  if (title.length < 8 && categoryLabel) {
    title = `${categoryLabel} Furniture`;
  }

  // Truncate to 110 chars at a word boundary
  if (title.length > 110) {
    title = title.slice(0, 107).replace(/\s+\S*$/, '') + '...';
  }

  // Ensure consistent sentence-ish case (don't force title-case on all-caps tokens)
  // We leave case as-is for readability; the data is already mixed-case from the pipeline.

  return title;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun   = args.includes('--dry-run');
  const overwrite = args.includes('--overwrite');
  const limitArg = args.find(a => a.startsWith('--limit=') || a === '--limit');
  const limit = limitArg
    ? parseInt(limitArg.includes('=') ? limitArg.split('=')[1] : args[args.indexOf(limitArg) + 1], 10)
    : 500;

  console.log(`[generateOptimizedTitles] mode=${dryRun ? 'DRY-RUN' : 'WRITE'} | limit=${limit} | overwrite=${overwrite}`);

  // Fetch rows
  let query = supabase
    .from('standardized_products')
    .select('supplier_product_id, product_title, product_title_display, short_description, category_label, optimized_title')
    .eq('normalization_status', 'done')
    .limit(limit);

  if (!overwrite) {
    query = query.is('optimized_title', null);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[generateOptimizedTitles] fetch error:', error.message);
    process.exit(1);
  }

  console.log(`[generateOptimizedTitles] ${data?.length ?? 0} rows to process`);

  let updated = 0;
  let skipped = 0;

  const BATCH = 50;
  const rows = data ?? [];

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const updates: { supplier_product_id: string; optimized_title: string }[] = [];

    for (const row of batch) {
      const optimized = buildOptimizedTitle(
        row.product_title,
        row.product_title_display,
        row.short_description,
        row.category_label,
      );

      // Skip if nothing changed
      if (optimized === row.product_title && !row.product_title_display) {
        skipped++;
        continue;
      }

      updates.push({ supplier_product_id: row.supplier_product_id, optimized_title: optimized });

      if (dryRun || i + updates.length <= 10) {
        console.log(
          `  [${i + updates.length}] ${row.supplier_product_id}\n` +
          `       RAW:  ${(row.product_title_display || row.product_title).slice(0, 90)}\n` +
          `       OPT:  ${optimized.slice(0, 90)}`,
        );
      }
    }

    if (!dryRun && updates.length > 0) {
      for (const u of updates) {
        const { error: upErr } = await supabase
          .from('standardized_products')
          .update({ optimized_title: u.optimized_title })
          .eq('supplier_product_id', u.supplier_product_id);

        if (upErr) {
          console.warn(`  [WARN] Failed to update ${u.supplier_product_id}: ${upErr.message}`);
        } else {
          updated++;
        }
      }
    } else {
      updated += updates.length;
    }
  }

  console.log(
    `[generateOptimizedTitles] done — updated: ${updated}, skipped: ${skipped}${dryRun ? ' (dry-run, no writes)' : ''}`,
  );
}

main().catch(err => {
  console.error('[generateOptimizedTitles] fatal:', err);
  process.exit(1);
});
