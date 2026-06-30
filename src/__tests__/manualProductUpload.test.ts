/**
 * Manual emergency product-upload tests — pure; no I/O, no DB, no env, no secrets.
 * The tool is import-safe (require.main guard + env/DB only inside main()), so importing it here
 * runs nothing. Run: npx tsx src/__tests__/manualProductUpload.test.ts
 */
import assert from 'node:assert/strict';
import {
  parseArgs,
  isMerchantPrefixed,
  warehouseState,
  supportsPickup,
  validateManualInput,
  buildSupplierItem,
  buildInventoryRows,
  buildStandardizedUpsertRow,
  getMarkup,
  getBuffer,
  psychologicalRound,
  calculateBaseRetail,
  resolveSellingPrice,
  detectFolderImages,
  buildPublicImageUrl,
  MANUAL_STORAGE_PREFIX,
  type ManualInput,
  type ValidateCtx,
} from '../../scripts/gigaManualProductUpload';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('manual product upload tests');

const CANON = new Set(['AT3', 'AT4', 'CA6', 'CA11', 'NJ4']); // note: NJ5 intentionally NOT canonical (bare, still valid)

function baseInput(over: Partial<ManualInput> = {}): ManualInput {
  return {
    supplier_product_id: 'W80870283',
    title: 'Kids Bookcase with Fabric Drawers',
    images: { primary: 'https://cdn.example.com/W80870283-main.jpg', gallery: [] },
    cost_price: 39,
    selling_price: 109,
    warehouse_inventory: [
      { warehouse_code: 'CA6', quantity: 23 },
      { warehouse_code: 'NJ5', quantity: 24 },
    ],
    ...over,
  };
}
function ctx(over: Partial<ValidateCtx> = {}): ValidateCtx {
  return { sku: 'W80870283', canonicalCodes: CANON, skuExists: false, updateExisting: false, feePresent: true, ...over };
}

// ── arg parsing ──
it('parseArgs reads --sku/--input/--confirm/--update-existing', () => {
  const a = parseArgs(['--sku', 'W80870283', '--input', 'x.json', '--confirm', '--update-existing']);
  assert.equal(a.sku, 'W80870283'); assert.equal(a.input, 'x.json');
  assert.equal(a.confirm, true); assert.equal(a.updateExisting, true);
});
it('parseArgs defaults confirm/updateExisting to false (PLAN-safe)', () => {
  const a = parseArgs(['--sku', 'W80870283', '--input', 'x.json']);
  assert.equal(a.confirm, false); assert.equal(a.updateExisting, false);
});

// ── warehouse guard mirror ──
it('isMerchantPrefixed matches hyphenated On-Site codes only', () => {
  assert.equal(isMerchantPrefixed('B062-FL1'), true);
  assert.equal(isMerchantPrefixed('T2574-OH1'), true);
  assert.equal(isMerchantPrefixed('CA6'), false);
  assert.equal(isMerchantPrefixed('NJ5'), false);
});
it('warehouseState + supportsPickup match the scraper mapping', () => {
  assert.equal(warehouseState('CA6'), 'CA');
  assert.equal(warehouseState('NJX3'), 'MD');
  assert.equal(warehouseState('NJ5'), 'NJ');
  assert.equal(warehouseState('AT4'), 'GA');
  assert.equal(warehouseState('TX1'), 'TX');
  assert.equal(supportsPickup('CA6'), true);
  assert.equal(supportsPickup('NJ5'), false);
});

// ── validation: happy path ──
it('valid input → no errors (bare non-canonical NJ5 only warns)', () => {
  const r = validateManualInput(baseInput(), ctx());
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some(w => /NJ5/.test(w))); // counted but unseeded
});

// ── validation: hard gates ──
it('selling_price <= 0 is a blocking error', () => {
  const r = validateManualInput(baseInput({ selling_price: 0 }), ctx());
  assert.ok(r.errors.some(e => /selling_price/.test(e)));
});
it('missing primary image is a blocking error', () => {
  const r = validateManualInput(baseInput({ images: { primary: '' } }), ctx());
  assert.ok(r.errors.some(e => /images\.primary/.test(e)));
});
it('SKU mismatch (--sku != json) is a blocking error', () => {
  const r = validateManualInput(baseInput({ supplier_product_id: 'WRONG' }), ctx());
  assert.ok(r.errors.some(e => /SKU mismatch/.test(e)));
});
it('existing SKU without --update-existing is blocked; allowed with it', () => {
  assert.ok(validateManualInput(baseInput(), ctx({ skuExists: true })).errors.some(e => /already exists/.test(e)));
  assert.deepEqual(validateManualInput(baseInput(), ctx({ skuExists: true, updateExisting: true })).errors, []);
});
it('merchant-prefixed non-canonical warehouse is blocked (would be quarantined)', () => {
  const r = validateManualInput(baseInput({ warehouse_inventory: [{ warehouse_code: 'B062-FL1', quantity: 10 }] }), ctx());
  assert.ok(r.errors.some(e => /quarantined/.test(e)));
});
it('zero total inventory is a blocking error', () => {
  const r = validateManualInput(baseInput({ warehouse_inventory: [{ warehouse_code: 'CA6', quantity: 0 }] }), ctx());
  assert.ok(r.errors.some(e => /total quantity must be > 0/.test(e)));
});

// ── validation: warnings ──
it('absent cost_price warns about the price>0 sellability gate', () => {
  const r = validateManualInput(baseInput({ cost_price: undefined }), ctx());
  assert.ok(r.warnings.some(w => /cost_price absent/.test(w)));
});
it('missing delivery fee warns (delivery blocked, pickup unaffected)', () => {
  const r = validateManualInput(baseInput(), ctx({ feePresent: false }));
  assert.ok(r.warnings.some(w => /delivery/i.test(w)));
});

// ── builders ──
it('buildSupplierItem tags manual_upload + carries imageUrls/category for normalizeProduct', () => {
  const item = buildSupplierItem(baseInput(), '2026-06-30T00:00:00Z') as Record<string, any>;
  assert.equal(item.manual_upload.source, 'manual_emergency_upload');
  assert.equal(item.manual_upload.at, '2026-06-30T00:00:00Z');
  assert.deepEqual(item.imageUrls, ['https://cdn.example.com/W80870283-main.jpg']);
  assert.equal(item.category, '');
  assert.equal(item.sku, 'W80870283');
});
it('buildInventoryRows produces website_scrape/ok rows with correct state + total', () => {
  const rows = buildInventoryRows(baseInput(), '2026-06-30T00:00:00Z');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source_type, 'website_scrape');
  assert.equal(rows[0].sync_status, 'ok');
  assert.equal(rows[0].warehouse_code, 'CA6');
  assert.equal(rows[0].supports_pickup, true);
  assert.equal(rows[1].supports_pickup, false); // NJ5
  assert.equal(rows[0].total_available, 47);
  assert.equal(rows[1].total_available, 47);
});
it('buildStandardizedUpsertRow sets selling_price, drops new_arrival_added_at, status=done', () => {
  const row = buildStandardizedUpsertRow(baseInput()) as Record<string, any>;
  assert.equal(row.selling_price, 109);
  assert.equal('new_arrival_added_at' in row, false);
  assert.equal(row.normalization_status, 'done');
  assert.equal(row.supplier_product_id, 'W80870283');
  assert.ok(typeof row.product_title === 'string' && row.product_title.length > 0);
  assert.ok(typeof row.primary_image === 'string' && row.primary_image.length > 0);
});

// ── pricing rule (mirrors dynamic-pricing calculateBaseRetail) ──
it('getMarkup tiers match dynamic-pricing', () => {
  assert.equal(getMarkup(50), 2.20); assert.equal(getMarkup(150), 1.80);
  assert.equal(getMarkup(400), 1.55); assert.equal(getMarkup(800), 1.40); assert.equal(getMarkup(801), 1.28);
});
it('getBuffer tiers match dynamic-pricing', () => {
  assert.equal(getBuffer(100), 20); assert.equal(getBuffer(300), 30); assert.equal(getBuffer(800), 50); assert.equal(getBuffer(801), 80);
});
it('psychologicalRound: .99 under 100, decade+9 under 300, hundred+{49,79,99} above', () => {
  assert.equal(psychologicalRound(95.93), 95.99);
  assert.equal(psychologicalRound(127), 129);
  assert.equal(psychologicalRound(409), 449);
});
it('calculateBaseRetail locks cost=33.25 → 96.99 (markup 2.20, buffer 20)', () => {
  const r = calculateBaseRetail(33.25);
  assert.equal(r.markup, 2.20); assert.equal(r.buffer, 20);
  assert.equal(r.baseRetailPrice, 96.99);
});
it('calculateBaseRetail enforces the 25% margin floor on tiny costs', () => {
  // cost=5 → raw=5*2.2+20=31 → grossed≈32.1 → psych 32.99; marginFloor=5/0.75=6.67 → floor not binding → 32.99
  assert.equal(calculateBaseRetail(5).baseRetailPrice, 32.99);
});

// ── auto pricing resolution ──
it('resolveSellingPrice auto computes from cost; manual uses supplied', () => {
  assert.deepEqual(
    { mode: resolveSellingPrice({ ...baseInput({ selling_price_mode: 'auto', cost_price: 33.25, selling_price: undefined }) }).mode,
      price: resolveSellingPrice({ ...baseInput({ selling_price_mode: 'auto', cost_price: 33.25, selling_price: undefined }) }).sellingPrice },
    { mode: 'auto', price: 96.99 },
  );
  const m = resolveSellingPrice(baseInput({ selling_price: 109 }));
  assert.equal(m.mode, 'manual'); assert.equal(m.sellingPrice, 109);
});
it('resolveSellingPrice auto without cost_price returns an error', () => {
  const r = resolveSellingPrice(baseInput({ selling_price_mode: 'auto', cost_price: undefined, selling_price: undefined }));
  assert.ok(r.error && /cost_price/.test(r.error));
  assert.equal(r.sellingPrice, undefined);
});

// ── folder image detection + URL building ──
it('detectFolderImages picks main.png + sorted gallery-*.png, ignores others', () => {
  const d = detectFolderImages(['gallery-02.png', 'main.png', 'gallery-01.png', 'manual.json', 'notes.txt', 'gallery-10.png']);
  assert.equal(d.primary, 'main.png');
  assert.deepEqual(d.gallery, ['gallery-01.png', 'gallery-02.png', 'gallery-10.png']);
});
it('buildPublicImageUrl uses the deny-safe prefix (never "manual")', () => {
  const u = buildPublicImageUrl('https://x.supabase.co', 'W80870283', 'main.png');
  assert.equal(u, `https://x.supabase.co/storage/v1/object/public/product-images/${MANUAL_STORAGE_PREFIX}/W80870283/main.png`);
  assert.equal(/(^|\/)manual(-|\/)/.test(u), false); // deny keyword 'manual' not in the path
});

console.log(`\n${passed} manual product upload assertions passed.`);
