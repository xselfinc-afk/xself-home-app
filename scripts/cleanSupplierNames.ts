/**
 * Audit and clean supplier / manufacturer / vendor branding from
 * customer-facing fields in standardized_products.
 *
 * Dry-run by default — prints an audit report.
 * Pass --apply to actually update product_title and product_title_display
 * for rows where the sanitizer detected a known-bad supplier prefix.
 *
 * Usage:
 *   npx tsx scripts/cleanSupplierNames.ts            # dry run (audit only)
 *   npx tsx scripts/cleanSupplierNames.ts --apply    # apply title updates
 *
 * Required env (in .env at project root):
 *   SUPABASE_URL              — https://<id>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (bypasses RLS)
 *
 * What this script does NOT do:
 *   - It does NOT auto-modify short_description, key_features_json, or
 *     specifications_json. Those fields are flagged in the report for
 *     human review because mid-sentence supplier names can't be removed
 *     safely without rephrasing.
 *   - It does NOT auto-strip "suspicious" unknown brand prefixes. Those
 *     rows are surfaced for review so you can decide whether to add the
 *     supplier to src/utils/supplierNameSanitizer.ts.
 */

import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  sanitizeSupplierName,
  detectSuspiciousBrandPrefix,
  containsKnownSupplier,
} from '../src/utils/supplierNameSanitizer';

// Load .env.local first (canonical home for service-role keys, per
// scripts/runGigaInventorySync.sh), then fall back to .env. dotenv does not
// overwrite already-set vars, so the .env.local values win.
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL) {
  console.error(
    '[cleanSupplierNames] Missing SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL).\n' +
    '  Add it to .env.local or .env at the project root.',
  );
  process.exit(1);
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '[cleanSupplierNames] Missing SUPABASE_SERVICE_ROLE_KEY.\n' +
    '  This script needs the service-role key to read every row and to write\n' +
    '  cleaned titles. Add SUPABASE_SERVICE_ROLE_KEY=<key> to .env.local.\n' +
    '  Find the key in Supabase dashboard → Settings → API → service_role.',
  );
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface Row {
  supplier_product_id: string;
  sku_custom: string | null;
  product_title: string | null;
  product_title_display: string | null;
  optimized_title: string | null;
  short_description: string | null;
  key_features_json: unknown;
  specifications_json: unknown;
}

interface PlannedUpdate {
  supplier_product_id: string;
  sku_custom: string | null;
  supplier: string;
  titleUpdate:          { old: string; new: string } | null;
  displayUpdate:        { old: string; new: string } | null;
  optimizedUpdate:      { old: string; new: string } | null;
  flaggedFields:        string[];
}

interface SuspiciousRow {
  supplier_product_id: string;
  sku_custom: string | null;
  product_title: string;
  suspicious: string;
}

async function fetchAll(): Promise<Row[]> {
  const PAGE = 1000;
  const all: Row[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('standardized_products')
      .select('supplier_product_id, sku_custom, product_title, product_title_display, optimized_title, short_description, key_features_json, specifications_json')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...(data as Row[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function fieldContainsSupplier(value: unknown): boolean {
  if (typeof value === 'string') {
    return !!containsKnownSupplier(value);
  }
  if (Array.isArray(value)) {
    return value.some(item => fieldContainsSupplier(item));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(v => fieldContainsSupplier(v));
  }
  return false;
}

async function run() {
  console.log(`[cleanSupplierNames] mode: ${APPLY ? 'APPLY' : 'dry-run'}${APPLY ? '' : ' (pass --apply to write)'}`);

  const rows = await fetchAll();
  console.log(`[cleanSupplierNames] fetched ${rows.length} rows from standardized_products\n`);

  const planned: PlannedUpdate[] = [];
  const suspicious: SuspiciousRow[] = [];

  for (const row of rows) {
    const titleResult     = sanitizeSupplierName(row.product_title);
    const displayResult   = sanitizeSupplierName(row.product_title_display);
    const optimizedResult = sanitizeSupplierName(row.optimized_title);

    const flagged: string[] = [];
    if (containsKnownSupplier(row.short_description)) flagged.push('short_description');
    if (fieldContainsSupplier(row.key_features_json)) flagged.push('key_features_json');
    if (fieldContainsSupplier(row.specifications_json)) flagged.push('specifications_json');

    const supplier =
      titleResult.supplier ?? displayResult.supplier ?? optimizedResult.supplier;
    if (supplier || flagged.length) {
      planned.push({
        supplier_product_id: row.supplier_product_id,
        sku_custom: row.sku_custom,
        supplier: supplier ?? '(flagged-only)',
        titleUpdate:     titleResult.changed
          ? { old: row.product_title ?? '', new: titleResult.cleaned }
          : null,
        displayUpdate:   displayResult.changed
          ? { old: row.product_title_display ?? '', new: displayResult.cleaned }
          : null,
        optimizedUpdate: optimizedResult.changed
          ? { old: row.optimized_title ?? '', new: optimizedResult.cleaned }
          : null,
        flaggedFields:   flagged,
      });
    } else {
      const sus = detectSuspiciousBrandPrefix(row.product_title);
      if (sus) {
        suspicious.push({
          supplier_product_id: row.supplier_product_id,
          sku_custom: row.sku_custom,
          product_title: row.product_title ?? '',
          suspicious: sus,
        });
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`=== KNOWN-SUPPLIER MATCHES (${planned.length}) ===\n`);
  for (const p of planned) {
    console.log(`• supplier=${p.supplier} | sku=${p.sku_custom ?? '(n/a)'} | spid=${p.supplier_product_id}`);
    if (p.titleUpdate) {
      console.log(`    product_title:`);
      console.log(`        old: "${p.titleUpdate.old}"`);
      console.log(`        new: "${p.titleUpdate.new}"`);
    }
    if (p.displayUpdate) {
      console.log(`    product_title_display:`);
      console.log(`        old: "${p.displayUpdate.old}"`);
      console.log(`        new: "${p.displayUpdate.new}"`);
    }
    if (p.optimizedUpdate) {
      console.log(`    optimized_title:`);
      console.log(`        old: "${p.optimizedUpdate.old}"`);
      console.log(`        new: "${p.optimizedUpdate.new}"`);
    }
    if (p.flaggedFields.length) {
      console.log(`    flagged for human review (NOT auto-cleaned): ${p.flaggedFields.join(', ')}`);
    }
    console.log('');
  }

  console.log(`=== SUSPICIOUS UNKNOWN BRAND PREFIXES (${suspicious.length}) — review manually ===\n`);
  for (const s of suspicious) {
    console.log(`? prefix="${s.suspicious}" | sku=${s.sku_custom ?? '(n/a)'} | spid=${s.supplier_product_id}`);
    console.log(`    title: "${s.product_title}"`);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Rows scanned:                    ${rows.length}`);
  console.log(`Known-supplier matches:          ${planned.length}`);
  console.log(`  with title update:             ${planned.filter(p => p.titleUpdate || p.displayUpdate).length}`);
  console.log(`  with flagged description/etc:  ${planned.filter(p => p.flaggedFields.length).length}`);
  console.log(`Suspicious unknown-brand rows:   ${suspicious.length}`);

  if (!APPLY) {
    console.log(`\nDry run — no DB changes made.`);
    console.log(`Re-run with --apply to write the title / display updates above.`);
    console.log(`Flagged description / feature / spec fields are NEVER auto-modified.`);
    return;
  }

  const toUpdate = planned.filter(p => p.titleUpdate || p.displayUpdate || p.optimizedUpdate);
  if (toUpdate.length === 0) {
    console.log(`\nNothing to apply.`);
    return;
  }

  console.log(`\nApplying ${toUpdate.length} row(s)...`);
  let ok = 0;
  let fail = 0;
  for (const p of toUpdate) {
    const patch: Record<string, string> = {};
    if (p.titleUpdate)     patch.product_title         = p.titleUpdate.new;
    if (p.displayUpdate)   patch.product_title_display = p.displayUpdate.new;
    if (p.optimizedUpdate) patch.optimized_title       = p.optimizedUpdate.new;
    const { error } = await supabase
      .from('standardized_products')
      .update(patch)
      .eq('supplier_product_id', p.supplier_product_id);
    if (error) {
      console.warn(`  ${p.supplier_product_id}: ${error.message}`);
      fail++;
    } else {
      ok++;
    }
  }
  console.log(`Applied: ${ok}, failed: ${fail}`);
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[cleanSupplierNames] Unexpected error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
