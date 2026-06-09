/**
 * READ-ONLY simulation of the Phase 1 supplier-derived product_family_key
 * (resolveVariantGroupKey). Performs NO writes — only .select() reads plus the
 * pure, in-memory normalizeProduct() to compute the exact proposed key.
 *
 *   npx tsx scripts/simulateVariantGrouping.ts
 *
 * Env (read from .env.local then .env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const TARGET = 'W1321S00027';
const PREFIX_MIN = 8;

function sharedPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

async function main() {
  const { createClient } = await import('@supabase/supabase-js');
  const pipe = await import('../src/services/normalizationPipeline');
  const normalizeProduct = (pipe as any).normalizeProduct ?? (pipe as any).default?.normalizeProduct;

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Current keys (only normalized rows have one) ────────────────────────────
  const { data: stdRows, error: stdErr } = await sb
    .from('standardized_products')
    .select('supplier_product_id, product_family_key');
  if (stdErr) { console.error('standardized_products read failed:', stdErr.message); process.exit(1); }
  const currentKey = new Map<string, string>();
  (stdRows ?? []).forEach((r: any) => currentKey.set(r.supplier_product_id, r.product_family_key));

  // ── Staged source rows (published=false) + the target ───────────────────────
  const { data: staged, error: stErr } = await sb
    .from('supplier_products')
    .select('supplier_product_id, title, description, price, raw_payload, published')
    .eq('published', false);
  if (stErr) { console.error('supplier_products read failed:', stErr.message); process.exit(1); }

  let rows = (staged ?? []) as any[];
  // Ensure the target is present even if its published flag differs.
  if (!rows.some(r => r.supplier_product_id === TARGET)) {
    const { data: tRow } = await sb
      .from('supplier_products')
      .select('supplier_product_id, title, description, price, raw_payload, published')
      .eq('supplier_product_id', TARGET)
      .maybeSingle();
    if (tRow) rows = [...rows, tRow];
  }

  // ── Compute proposed key via the REAL pipeline (pure, in-memory) ────────────
  const origLog = console.log;
  console.log = () => {}; // silence pipeline's per-row logging
  const sim = rows.map(r => {
    const id = r.supplier_product_id;
    const raw = (r.raw_payload ?? {}) as Record<string, unknown>;
    const associates = Array.isArray(raw.associateProductList)
      ? (raw.associateProductList as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const keptSiblings = associates.filter(a => a !== id && sharedPrefixLen(id, a) >= PREFIX_MIN);
    const crossSell = associates.filter(a => a !== id && sharedPrefixLen(id, a) < PREFIX_MIN);
    let proposed = '(error)';
    try {
      proposed = normalizeProduct({ ...r, id }).product_family_key;
    } catch (e) {
      proposed = `(error: ${(e as Error).message})`;
    }
    return { id, raw, associates, keptSiblings, crossSell, proposed, published: r.published };
  });
  console.log = origLog;

  const byId = new Map(sim.map(s => [s.id, s]));

  // ── 1. Target report ────────────────────────────────────────────────────────
  const t = byId.get(TARGET);
  console.log('═══ TARGET:', TARGET, '═══');
  if (!t) {
    console.log('  NOT FOUND in supplier_products.');
  } else {
    console.log('  published                 :', t.published);
    console.log('  current product_family_key:', currentKey.get(TARGET) ?? '(none — not yet normalized)');
    console.log('  proposed product_family_key:', t.proposed);
    console.log('  associateProductList       :', t.associates.length ? t.associates.join(', ') : '(none)');
    console.log('    kept variant siblings (≥8 prefix):', t.keptSiblings.length ? t.keptSiblings.join(', ') : '(none)');
    console.log('    cross-sell (ignored, <8 prefix)  :', t.crossSell.length ? t.crossSell.join(', ') : '(none)');
    const cur = currentKey.get(TARGET);
    const isLive = cur != null;
    const wouldChange = cur != null && cur !== t.proposed;
    console.log('    siblings present in staged set   :',
      t.keptSiblings.filter(s => byId.has(s)).join(', ') || '(none staged)');
    console.log('    siblings missing from staged set :',
      t.keptSiblings.filter(s => !byId.has(s)).join(', ') || '(none)');
    console.log('  re-normalization needed later?     :',
      !isLive
        ? `NO — not yet normalized/live; it will receive "${t.proposed}" directly on import. Import its siblings in the SAME batch to group them.`
        : wouldChange
          ? `YES — already live with "${cur}"; importing siblings would require a scoped re-normalize to adopt "${t.proposed}".`
          : 'NO — already live and proposed key matches current.');
  }

  // ── 2. Staged cluster report (group by proposed key, exclude target-only) ────
  const staged0 = sim.filter(s => s.published === false);
  const groups = new Map<string, string[]>();
  for (const s of staged0) {
    if (!groups.has(s.proposed)) groups.set(s.proposed, []);
    groups.get(s.proposed)!.push(s.id);
  }
  const vgGroups = [...groups.entries()]
    .filter(([k, ids]) => k.includes('-vg-') && ids.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  const supplierDerivedCount = staged0.filter(s => s.proposed.includes('-vg-')).length;
  const cardsReduced = vgGroups.reduce((acc, [, ids]) => acc + (ids.length - 1), 0);

  console.log('\n═══ STAGED (published=false) SUMMARY ═══');
  console.log('  staged rows scanned                    :', staged0.length);
  console.log('  rows getting supplier-derived (-vg-) key:', supplierDerivedCount);
  console.log('  rows keeping title-derived key          :', staged0.length - supplierDerivedCount);
  console.log('  realized variant clusters (≥2 in batch) :', vgGroups.length);
  console.log('  duplicate cards eliminated if all imported together:', cardsReduced,
    `(${staged0.length} cards → ${staged0.length - cardsReduced})`);

  console.log('\n═══ TOP REALIZED VARIANT CLUSTERS (proposed -vg- key, size ≥2) ═══');
  vgGroups.slice(0, 25).forEach(([key, ids], i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${key}  (${ids.length})  ${ids.sort().join(', ')}`);
  });
  if (vgGroups.length > 25) console.log(`  …and ${vgGroups.length - 25} more clusters`);

  // ── 3. False-grouping / split risk flags ────────────────────────────────────
  console.log('\n═══ FALSE-GROUPING / SPLIT RISK FLAGS ═══');

  // (a) Rows with kept siblings that did NOT land in a -vg- group of size>1
  //     (siblings absent from staged set, or computed a different key → split).
  const orphans = staged0.filter(s =>
    s.keptSiblings.length > 0 && (groups.get(s.proposed)?.length ?? 0) === 1);
  console.log(`  (a) SPLIT — rows with variant siblings but landing alone: ${orphans.length}`);
  orphans.slice(0, 15).forEach(s => {
    const present = s.keptSiblings.filter(x => byId.has(x));
    const absent = s.keptSiblings.filter(x => !byId.has(x));
    console.log(`        ${s.id} → ${s.proposed} | siblings present:[${present.join(',') || '-'}] absent:[${absent.join(',') || '-'}]`);
  });
  if (orphans.length > 15) console.log(`        …and ${orphans.length - 15} more`);

  // (b) Mixed-category split: ≥8-prefix sibling pairs that landed in different keys.
  const mixed: string[] = [];
  for (const s of staged0) {
    for (const sib of s.keptSiblings) {
      const o = byId.get(sib);
      if (o && o.published === false && o.proposed !== s.proposed && s.id < sib) {
        mixed.push(`${s.id}(${s.proposed})  ≠  ${sib}(${o.proposed})`);
      }
    }
  }
  console.log(`  (b) MIXED-KEY — ≥8-prefix sibling pairs that did NOT merge: ${mixed.length}`);
  mixed.slice(0, 15).forEach(m => console.log(`        ${m}`));
  if (mixed.length > 15) console.log(`        …and ${mixed.length - 15} more`);

  // (c) Suspiciously large clusters (manual eyeball).
  const large = vgGroups.filter(([, ids]) => ids.length >= 8);
  console.log(`  (c) LARGE clusters (≥8 members, eyeball for over-merge): ${large.length}`);
  large.forEach(([key, ids]) => console.log(`        ${key} (${ids.length})`));

  // ── 4. Would the 20 live pilot products change if re-normalized? ────────────
  console.log('\n═══ 20 LIVE PILOT PRODUCTS — would re-normalize change their key? ═══');
  const { data: seedRows } = await sb
    .from('inventory_cache')
    .select('product_id, raw_payload')
    .eq('source_type', 'website_scrape');
  const pilotIds = Array.from(new Set((seedRows ?? [])
    .filter((r: any) => r?.raw_payload?.source_note === 'official_api_pilot_seed')
    .map((r: any) => r.product_id)));
  console.log('  pilot SKUs identified (seed-tagged):', pilotIds.length);

  if (pilotIds.length) {
    const { data: pilotSrc } = await sb
      .from('supplier_products')
      .select('supplier_product_id, title, description, price, raw_payload')
      .in('supplier_product_id', pilotIds as string[]);
    const silence = console.log; console.log = () => {};
    const pilotSim = (pilotSrc ?? []).map((r: any) => {
      let proposed = '(error)';
      try { proposed = normalizeProduct({ ...r, id: r.supplier_product_id }).product_family_key; } catch {}
      return { id: r.supplier_product_id, proposed };
    });
    console.log = silence;
    const changed = pilotSim.filter(p => (currentKey.get(p.id) ?? null) !== p.proposed);
    console.log('  pilot rows checked                 :', pilotSim.length);
    console.log('  pilot keys that WOULD change       :', changed.length);
    changed.forEach(p => console.log(`        ${p.id}: ${currentKey.get(p.id)}  →  ${p.proposed}`));
    if (!changed.length) console.log('        (none — all 20 pilot proposed keys equal their current keys)');
  }

  console.log('\n[sim] READ-ONLY: no writes performed. (only .select() + in-memory normalizeProduct)');
}

main().catch(e => { console.error(e); process.exit(1); });
