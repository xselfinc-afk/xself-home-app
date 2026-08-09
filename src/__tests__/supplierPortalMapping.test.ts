/**
 * Supplier portal product_id mapping tests (pure; no network, no database, no browser).
 *
 * The property everything else depends on: the wishlist XHR addresses a numeric website
 * product_id, and getting it wrong silently acts on a different product. So a mapping is evidence
 * that must be proven per SKU and verified in reverse — never guessed, never inherited from
 * inventory_cache, never picked from several candidates.
 *
 * Run: npx tsx src/__tests__/supplierPortalMapping.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  BANNED_MAPPING_SOURCES,
  MAPPING_STALE_AFTER_DAYS,
  PORTAL_MAPPING_CONFIDENCE,
  PORTAL_MAPPING_SOURCE,
  isStale,
  isUsableMapping,
  resolvePortalMapping,
  toUsableMapping,
  matchSavedListing,
  scoreCandidate,
  imageFingerprint,
  savedFactsFromSupplierProduct,
  candidateFromBaseInfos,
  type SavedListingFacts,
  type CandidateListing,
  type StoredPortalMapping,
} from '../services/supplierPortalMapping';
import { buildFavoriteSyncPlan } from '../services/supplierFavoriteSync';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const NOW = '2026-08-06T00:00:00.000Z';

const stored = (over: Partial<StoredPortalMapping> = {}): StoredPortalMapping => ({
  supplier_product_id: 'W409P327406',
  website_product_id: 667968,
  portal_sku: 'W409P327406',
  source: PORTAL_MAPPING_SOURCE,
  confidence: PORTAL_MAPPING_CONFIDENCE,
  resolved_at: NOW,
  last_verified_at: NOW,
  ...over,
});

function main(): void {
  // ── 1–5: 解析规则 ─────────────────────────────────────────────────────────

  it('1. 唯一候选 + 数字 product_id + portal_sku 一致 → 成功', () => {
    const r = resolvePortalMapping({
      supplier_product_id: 'W409P327406',
      candidates: ['667968'],
      portal_sku: 'W409P327406',
    });
    assert.equal(r.status, 'resolved');
    assert.equal(r.website_product_id, 667968);
    assert.equal(r.portal_sku, 'W409P327406');
    assert.equal(r.source, 'supplier_portal');
    assert.equal(r.confidence, 'exact');
  });

  it('2. portal_sku 与目标 SKU 不一致 → 拒绝', () => {
    const r = resolvePortalMapping({
      supplier_product_id: 'W409P327406',
      candidates: [667968],
      portal_sku: 'W409P327407',      // 搜索模糊命中了邻近商品
    });
    assert.equal(r.status, 'portal_sku_mismatch');
    assert.equal(r.website_product_id, null);
    assert.equal(r.confidence, null);
  });

  it('3. product_id 非数字 → 拒绝', () => {
    for (const candidate of ['W409P327406', 'abc123', '12.5', '-7', '0']) {
      const r = resolvePortalMapping({
        supplier_product_id: 'W409P327406',
        candidates: [candidate],
        portal_sku: 'W409P327406',
      });
      assert.equal(r.status, 'product_id_not_numeric', `${candidate} 必须被拒绝`);
      assert.equal(r.website_product_id, null);
    }
  });

  it('4. 多候选 → 拒绝，绝不自动取第一个', () => {
    const r = resolvePortalMapping({
      supplier_product_id: 'W409P327406',
      candidates: ['667968', '667969'],
      portal_sku: 'W409P327406',
    });
    assert.equal(r.status, 'multiple_candidates');
    assert.equal(r.website_product_id, null);
    assert.match(r.detail ?? '', /拒绝自动选取/);
  });

  it('5. 无候选 → exception', () => {
    const r = resolvePortalMapping({ supplier_product_id: 'W409P327406', candidates: [], portal_sku: null });
    assert.equal(r.status, 'no_candidate');
    assert.equal(r.website_product_id, null);

    // 详情读不到时同样不能成立 —— 没有反查就没有映射。
    const noDetail = resolvePortalMapping({
      supplier_product_id: 'W409P327406', candidates: ['667968'], portal_sku: null,
    });
    assert.equal(noDetail.status, 'detail_unavailable');
    assert.equal(noDetail.website_product_id, null);
  });

  // ── 6–7: 被禁来源 ─────────────────────────────────────────────────────────

  it('6. inventory_cache 永远不能作为映射来源', () => {
    assert.equal(isUsableMapping(stored({ source: 'inventory_cache' })), false);
    for (const banned of BANNED_MAPPING_SOURCES) {
      assert.equal(isUsableMapping(stored({ source: banned })), false, `${banned} 必须被拒绝`);
    }
    // 源码层面：解析与同步链都不得再引用 inventory_cache。
    for (const file of [
      'src/services/supplierPortalMapping.ts',
      'src/services/supplierFavoriteSync.ts',
      'scripts/xoneSupplierFavoriteBridge.ts',
    ]) {
      const src = fs.readFileSync(file, 'utf8');
      assert.equal(
        /from\('inventory_cache'\)|readAll[^\n]*inventory_cache/.test(src), false,
        `${file} 不得再读取 inventory_cache`,
      );
    }
  });

  it('7. SKU 自我副本不能被当作 product_id', () => {
    // inventory_cache 的真实形态：product_id 就是 SKU 本身。个别 SKU 全是数字，
    // 只做数字校验会放行，然后作用到毫不相干的商品上。
    assert.equal(isUsableMapping(stored({ supplier_product_id: '1315793', website_product_id: 1315793, portal_sku: '1315793' })), false);
    // 非数字的自我副本本来就过不了数字校验。
    assert.equal(isUsableMapping(stored({ website_product_id: 'W409P327406' })), false);
  });

  // ── 8–9: 存量映射 ─────────────────────────────────────────────────────────

  it('8. 已确认的映射可直接复用', () => {
    const row = stored();
    assert.equal(isUsableMapping(row), true);
    assert.deepEqual(toUsableMapping(row), {
      supplier_product_id: 'W409P327406',
      website_product_id: 667968,
      portal_sku: 'W409P327406',
    });
    assert.equal(isStale(row, NOW), false);

    // 任一门禁不满足都不可复用。
    for (const spoil of [
      { confidence: 'fuzzy' }, { source: 'guess' }, { portal_sku: 'OTHER' },
      { portal_sku: null }, { website_product_id: null },
    ] as Partial<StoredPortalMapping>[]) {
      assert.equal(isUsableMapping(stored(spoil)), false, `${JSON.stringify(spoil)} 必须不可用`);
      assert.equal(toUsableMapping(stored(spoil)), null);
    }
    assert.equal(isUsableMapping(null), false);
  });

  it('9. 过期映射需要重新验证', () => {
    const old = new Date(Date.parse(NOW) - (MAPPING_STALE_AFTER_DAYS + 1) * 86400_000).toISOString();
    assert.equal(isStale(stored({ last_verified_at: old, resolved_at: old }), NOW), true);
    // 仍在有效期内的不算过期。
    const recent = new Date(Date.parse(NOW) - 10 * 86400_000).toISOString();
    assert.equal(isStale(stored({ last_verified_at: recent }), NOW), false);
    // 没有任何时间戳时按过期处理，宁可重验也不盲信。
    assert.equal(isStale(stored({ last_verified_at: null, resolved_at: null }), NOW), true);
    // 过期不等于失效：内容仍然合法，只是需要重验。
    assert.equal(isUsableMapping(stored({ last_verified_at: old, resolved_at: old })), true);
  });

  // ── 10–11: 接入同步计划 ───────────────────────────────────────────────────

  it('10. 同步计划只认 portal mapping', () => {
    const mappings = new Map([['PUB-A', stored({ supplier_product_id: 'PUB-A', portal_sku: 'PUB-A', website_product_id: 1001 })]]);
    const resolve = (sku: string) => {
      const usable = toUsableMapping(mappings.get(sku) ?? ({} as StoredPortalMapping));
      return usable
        ? { product_id: usable.website_product_id, verified_sku: usable.portal_sku, status: 'unique' as const }
        : { product_id: null, verified_sku: null, status: 'not_mapped' as const };
    };
    const plan = buildFavoriteSyncPlan(
      ['PUB-A', 'PUB-B'],
      [{ account: 'pickup', saved: [], authoritative: true }],
      resolve,
    );
    assert.deepEqual(plan.accounts[0].missing.map((i) => i.supplier_product_id), ['PUB-A']);
    assert.equal(plan.accounts[0].missing[0].product_id, 1001);
    assert.deepEqual(plan.accounts[0].exceptions.map((e) => e.supplier_product_id), ['PUB-B']);
  });

  it('11. 映射逻辑变化不影响 missing/extra 的计算', () => {
    const target = ['PUB-A', 'PUB-B'];
    const saved = ['PUB-A', 'OLD-X'];
    // 全部无映射时，集合运算结果不变，只是全部落进 exception。
    const none = buildFavoriteSyncPlan(target, [{ account: 'pickup', saved, authoritative: true }],
      () => ({ product_id: null, verified_sku: null, status: 'not_mapped' as const }));
    assert.equal(none.accounts[0].missing.length + none.accounts[0].exceptions.filter(e => e.intended_operation === 'add').length, 1);
    assert.equal(none.accounts[0].extra.length + none.accounts[0].exceptions.filter(e => e.intended_operation === 'remove').length, 1);

    // 全部有映射时，同样的集合运算，只是变成可执行。
    let n = 5000;
    const all = buildFavoriteSyncPlan(target, [{ account: 'pickup', saved, authoritative: true }],
      (sku) => ({ product_id: ++n, verified_sku: sku, status: 'unique' as const }));
    assert.deepEqual(all.accounts[0].missing.map(i => i.supplier_product_id), ['PUB-B']);
    assert.deepEqual(all.accounts[0].extra.map(i => i.supplier_product_id), ['OLD-X']);
    assert.equal(all.accounts[0].exceptions.length, 0);
  });


  // ── 13–19: 收藏是身份的 Source of Truth ───────────────────────────────────
  //
  // 同一个 Supplier SKU 在 GIGA 上可以有多条 listing，用户只收藏了其中一条。门户全局搜索会把
  // 未被收藏的那条一并返回 —— 它不该参与身份判定，更不该把商品判成「身份不唯一」而拦住上架。
  // 下面的数字全部取自真实案例 W1826P308991（收藏的是 1096253，未收藏的是 1022040）。

  const SAVED_W1826: SavedListingFacts = {
    title: "Fully Assembled 48'' Freestanding Single Bathroom Vanity with 2 Free Handle Sets",
    primary_image: 'https://b2bfiles1.gigab2b.cn/image/wkseller/60613/b896e1a141754a0ac294f9caaac7d3b5.jpg?x-cc=20&x-cu=91992',
    image_count: 23,
    dimensions: '48.00x22.00x35.70',
    first_arrival_date: '2025-08-15',
  };
  const FAVORITED_1096253: CandidateListing = {
    product_id: 1096253,
    portal_sku: 'W1826P308991',
    title: "Fully Assembled 48'' Freestanding Single Bathroom Vanity with 2 Free Handle Sets",
    main_image: 'https://b2bfiles1.gigab2b.cn/image/wkseller/60613/b896e1a141754a0ac294f9caaac7d3b5.jpg?x-cc=10&x-cu=91992&x-oss-process=image',
    image_count: 23,
    dimensions: '48.00x22.00x35.70',
    first_available_date: '2025-08-15',
  };
  const UNFAVORITED_1022040: CandidateListing = {
    product_id: 1022040,
    portal_sku: 'W1826P308991',
    title: "Fully Assembled 48'' Freestanding Single Bathroom Vanity with 2 Handle Sets",
    main_image: 'https://b2bfiles1.gigab2b.cn/image/wkseller/23918/965aa22cb33e0a76d899640bcb99cf23.jpg?x-cc=10',
    image_count: 17,
    dimensions: '48.00x22.00x36.00',
    first_available_date: '2025-10-28',
  };

  it('13. W1826P308991：两条同 SKU listing，只认收藏的那条', () => {
    const r = resolvePortalMapping({
      supplier_product_id: 'W1826P308991',
      candidates: ['1096253', '1022040'],
      portal_sku: null,
      saved: SAVED_W1826,
      candidate_details: [FAVORITED_1096253, UNFAVORITED_1022040],
    });
    assert.equal(r.status, 'resolved');
    assert.equal(r.website_product_id, 1096253);
    assert.equal(r.portal_sku, 'W1826P308991');
    assert.equal(r.confidence, PORTAL_MAPPING_CONFIDENCE);
    // 未收藏的那条必须彻底出局，不能出现在结论里。
    assert.notEqual(Number(r.website_product_id), 1022040);
    // 搜索顺序不该影响结论。
    const reversed = resolvePortalMapping({
      supplier_product_id: 'W1826P308991',
      candidates: ['1022040', '1096253'],
      portal_sku: null,
      saved: SAVED_W1826,
      candidate_details: [UNFAVORITED_1022040, FAVORITED_1096253],
    });
    assert.equal(reversed.website_product_id, 1096253);
  });

  it('14. 主图内容哈希是决定性证据，签名参数与尺寸后缀不影响比对', () => {
    assert.equal(imageFingerprint(SAVED_W1826.primary_image), 'b896e1a141754a0ac294f9caaac7d3b5.jpg');
    assert.equal(imageFingerprint(FAVORITED_1096253.main_image), 'b896e1a141754a0ac294f9caaac7d3b5.jpg');
    assert.notEqual(imageFingerprint(UNFAVORITED_1022040.main_image), imageFingerprint(SAVED_W1826.primary_image));
    assert.equal(imageFingerprint(null), null);
    assert.equal(imageFingerprint(''), null);
    // 光靠主图一致就够认定（10 分 ≥ 门槛），不需要凑齐其它字段。
    const imageOnly: CandidateListing = { ...FAVORITED_1096253, title: null, image_count: null, dimensions: null, first_available_date: null };
    const other: CandidateListing = { ...UNFAVORITED_1022040, title: null, image_count: null, dimensions: null, first_available_date: null };
    assert.equal(matchSavedListing(SAVED_W1826, [imageOnly, other], 'W1826P308991')?.product_id, 1096253);
  });

  it('15. 证据不足或并列时仍然交人工，不猜', () => {
    // 两个候选完全一样 —— 收藏记录区分不了，必须回到人工确认。
    const twin: CandidateListing = { ...FAVORITED_1096253, product_id: 1096254 };
    assert.equal(matchSavedListing(SAVED_W1826, [FAVORITED_1096253, twin], 'W1826P308991'), null);

    // 只有一个弱字段一致（图片数），达不到门槛。
    const weakSaved: SavedListingFacts = { title: null, primary_image: null, image_count: 23, dimensions: null, first_arrival_date: null };
    assert.equal(matchSavedListing(weakSaved, [FAVORITED_1096253, UNFAVORITED_1022040], 'W1826P308991'), null);

    // 走到 resolvePortalMapping 就是 multiple_candidates，绝不自动取第一个。
    const r = resolvePortalMapping({
      supplier_product_id: 'W1826P308991', candidates: ['1096253', '1096254'], portal_sku: null,
      saved: SAVED_W1826, candidate_details: [FAVORITED_1096253, twin],
    });
    assert.equal(r.status, 'multiple_candidates');
    assert.equal(r.website_product_id, null);
  });

  it('16. portal_sku 与目标 SKU 不同的候选直接出局', () => {
    const foreign: CandidateListing = { ...FAVORITED_1096253, product_id: 999999, portal_sku: 'W0000P000000' };
    assert.equal(scoreCandidate(SAVED_W1826, foreign, 'W1826P308991'), -1);
    // 即使它和收藏资料完全一致，也不能被选中。
    assert.equal(matchSavedListing(SAVED_W1826, [foreign], 'W1826P308991'), null);
  });

  it('17. 收藏记录读不到时，回到「拒绝自动选取」，不退化成取第一个', () => {
    const noSaved = resolvePortalMapping({
      supplier_product_id: 'W1826P308991', candidates: ['1096253', '1022040'], portal_sku: null,
      saved: null, candidate_details: [FAVORITED_1096253, UNFAVORITED_1022040],
    });
    assert.equal(noSaved.status, 'multiple_candidates');
    assert.equal(noSaved.website_product_id, null);

    const noDetails = resolvePortalMapping({
      supplier_product_id: 'W1826P308991', candidates: ['1096253', '1022040'], portal_sku: null,
      saved: SAVED_W1826, candidate_details: [],
    });
    assert.equal(noDetails.status, 'multiple_candidates');
    assert.equal(noDetails.website_product_id, null);
  });

  it('18. 适配器按真实字段取数，缺失一律 null，不臆造', () => {
    const saved = savedFactsFromSupplierProduct({
      title: 'T',
      images: ['https://x/a.jpg?sig=1', 'https://x/b.jpg'],
      raw_payload: { mainImageUrl: 'https://x/a.jpg?sig=2', assembledLength: '48.00', assembledWidth: '22.00', assembledHeight: '35.70', firstArrivalDate: '2025-08-15' },
    });
    assert.deepEqual(saved, {
      title: 'T', primary_image: 'https://x/a.jpg?sig=2', image_count: 2,
      dimensions: '48.00x22.00x35.70', first_arrival_date: '2025-08-15',
    });
    // 尺寸缺一维就整体作废 —— 半份尺寸不是证据。
    assert.equal(savedFactsFromSupplierProduct({ raw_payload: { assembledLength: '48.00', assembledWidth: '22.00' } }).dimensions, null);
    assert.equal(savedFactsFromSupplierProduct({}).image_count, null);

    const cand = candidateFromBaseInfos('1096253', {
      data: { product_info: {
        sku: 'W1826P308991', product_name: 'N',
        main_image: { popup: 'https://x/a.jpg?sig=3' },
        image_list: [1, 2, 3],
        first_available_date: '2025-08-15',
        specification: { product_dimensions: { assemble_info: { length_show: '48.00', width_show: '22.00', height_show: '35.70' } } },
      } },
    });
    assert.deepEqual(cand, {
      product_id: 1096253, portal_sku: 'W1826P308991', title: 'N',
      main_image: 'https://x/a.jpg?sig=3', image_count: 3,
      dimensions: '48.00x22.00x35.70', first_available_date: '2025-08-15',
    });
    // 门户对本账号不可见时返回 "**" —— 那不是日期。
    assert.equal(candidateFromBaseInfos('1', { data: { product_info: { first_available_date: '**' } } })?.first_available_date, null);
    assert.equal(candidateFromBaseInfos('abc', {}), null);
  });

  it('19. 库存链优先用已确认的映射，而不是门户全局搜索的第一条', () => {
    const src = fs.readFileSync('scripts/syncGigaInventoryXhr.ts', 'utf8');
    assert.ok(/confirmedIds\.get\(sku\)/.test(src), '必须先查已确认的映射');
    assert.ok(
      /confirmed[\s\S]{0,120}?await resolveProductId\(sku\)/.test(src),
      '只有在没有确认映射时才允许退回全局搜索',
    );
    assert.ok(/supplier_portal_product_mappings/.test(src), '确认映射的来源必须是映射表');
  });

  it('20. 两个解析调用点都会在多候选时带上收藏资料', () => {
    for (const file of ['scripts/syncSupplierFavoritesToPublished.ts', 'scripts/resolveSupplierPortalProductIds.ts']) {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(/candidates\.length > 1/.test(src), `${file} 必须处理多候选分支`);
      assert.ok(/savedFactsFromSupplierProduct/.test(src), `${file} 必须读取收藏记录自身的资料`);
      assert.ok(/candidate_details/.test(src), `${file} 必须把候选详情交给解析器`);
    }
  });


  it('21. 另外三个真实的「同 SKU 多 listing」案例，同样只认收藏的那条（不是单件特判）', () => {
    // 2026-08-09 全库只读扫描：494 件在售 SKU 里有 4 件门户存在多条 listing。四件的区分信号
    // 各不相同 —— 有的靠主图，有的两条共用主图、只能靠图片数或入仓日期。
    const cases: Array<{ sku: string; expect: number; saved: SavedListingFacts; details: CandidateListing[] }> = [
      {
        // 两条共用同一张主图，靠图片数（18 vs 20）与入仓日期区分。
        sku: 'W1445P419756', expect: 1263122,
        saved: { title: '6-Drawer Double Dresser', primary_image: 'https://x/a4fb61d3507842d6efaf7c7f50ac9b7f.jpg', image_count: 18, dimensions: '47.24x17.72x29.92', first_arrival_date: '2026-01-18' },
        details: [
          { product_id: 1366693, portal_sku: 'W1445P419756', title: '6-Drawer Double Dresser', main_image: 'https://x/a4fb61d3507842d6efaf7c7f50ac9b7f.jpg', image_count: 20, dimensions: '47.24x17.72x29.92', first_available_date: '2026-05-01' },
          { product_id: 1263122, portal_sku: 'W1445P419756', title: '6-Drawer Double Dresser', main_image: 'https://x/a4fb61d3507842d6efaf7c7f50ac9b7f.jpg', image_count: 18, dimensions: '47.24x17.72x29.92', first_available_date: '2026-01-18' },
        ],
      },
      {
        // 主图不同 —— 决定性信号直接命中。
        sku: 'W1163P315233', expect: 1038655,
        saved: { title: '55-inch Trampoline', primary_image: 'https://x/4240fafee16c4bd464d27b320eef1c14.png', image_count: 8, dimensions: '55.00x55.00x44.00', first_arrival_date: '2025-06-17' },
        details: [
          { product_id: 1038655, portal_sku: 'W1163P315233', title: '55-inch Trampoline', main_image: 'https://x/4240fafee16c4bd464d27b320eef1c14.png', image_count: 8, dimensions: '55.00x55.00x44.00', first_available_date: '2025-06-17' },
          { product_id: 1091085, portal_sku: 'W1163P315233', title: '55-inch Trampoline', main_image: 'https://x/20250617_XIiF3I0YpSDzXKdAcPogDtDdpSrBrMoC.jpg', image_count: 7, dimensions: '55.00x55.00x44.00', first_available_date: null },
        ],
      },
      {
        // 最窄的一件：主图、标题、图片数、尺寸全同，只有入仓日期不同。
        sku: 'N721S000064K', expect: 1338361,
        saved: { title: 'Farmhouse 4-in-1 Hall Tree', primary_image: 'https://x/19a5e1e0cf40ac4426745e87dbe44ac0.jpg', image_count: 19, dimensions: '56.30x15.70x74.80', first_arrival_date: '2026-03-08' },
        details: [
          { product_id: 1338361, portal_sku: 'N721S000064K', title: 'Farmhouse 4-in-1 Hall Tree', main_image: 'https://x/19a5e1e0cf40ac4426745e87dbe44ac0.jpg', image_count: 19, dimensions: '56.30x15.70x74.80', first_available_date: '2026-03-08' },
          { product_id: 1382037, portal_sku: 'N721S000064K', title: 'Farmhouse 4-in-1 Hall Tree', main_image: 'https://x/19a5e1e0cf40ac4426745e87dbe44ac0.jpg', image_count: 19, dimensions: '56.30x15.70x74.80', first_available_date: '2026-02-27' },
        ],
      },
    ];
    for (const c of cases) {
      const r = resolvePortalMapping({
        supplier_product_id: c.sku,
        candidates: c.details.map((d) => String(d.product_id)),
        portal_sku: null, saved: c.saved, candidate_details: c.details,
      });
      assert.equal(r.status, 'resolved', `${c.sku} 应当被唯一认定`);
      assert.equal(r.website_product_id, c.expect, `${c.sku} 必须认定为收藏的那条`);
    }
  });

  it('22. 拼接出来的假 SKU 搜出一堆无关商品时，仍然交人工，不硬选', () => {
    // 真实存在的脏数据：三个 SKU 用空格拼成一个。门户全局搜索返回 50 个毫不相关的商品，
    // 收藏记录跟谁都对不上 —— 这时必须停在人工确认，而不是挑一个最像的。
    const saved: SavedListingFacts = {
      title: 'Sectional sofa-2seater', primary_image: 'https://x/sofa.jpg',
      image_count: 8, dimensions: '74.00x34.75x33.25', first_arrival_date: '2024-09-20',
    };
    const noise: CandidateListing[] = [803542, 531405, 1398582].map((id, i) => ({
      product_id: id, portal_sku: null, title: `Unrelated ${i}`,
      main_image: `https://x/noise${i}.jpg`, image_count: 12 + i,
      dimensions: '59.00x15.74x25.20', first_available_date: '2024-10-11',
    }));
    const r = resolvePortalMapping({
      supplier_product_id: 'N771P205002M_N771P220377M _N771P205014M',
      candidates: noise.map((n) => String(n.product_id)),
      portal_sku: null, saved, candidate_details: noise,
    });
    assert.equal(r.status, 'multiple_candidates');
    assert.equal(r.website_product_id, null);
  });

  // ── 12: 本轮不得发出任何收藏增删 ──────────────────────────────────────────

  it('12. 解析链不包含任何 wishlist 增删调用', () => {
    for (const file of [
      'src/services/supplierPortalMapping.ts',
      'scripts/resolveSupplierPortalProductIds.ts',
    ]) {
      const src = fs.readFileSync(file, 'utf8');
      for (const forbidden of ['addProductsToWish', 'delProductsFromWish', 'executeSyncOperation', 'executeRemoval']) {
        assert.equal(src.includes(forbidden), false, `${file} 不得引用 ${forbidden}`);
      }
    }
    // 解析脚本只允许写这一张映射表：写入目标常量固定，且没有任何绕过它的写操作。
    const runner = fs.readFileSync('scripts/resolveSupplierPortalProductIds.ts', 'utf8');
    assert.ok(
      /const WRITE_TABLE = 'supplier_portal_product_mappings'/.test(runner),
      '写入目标常量必须固定为映射表',
    );
    const writeTargets = [...runner.matchAll(/\.from\(([^)]+)\)[\s\S]{0,200}?\.(upsert|insert|update|delete)\(/g)]
      .map((m) => m[1].trim());
    assert.deepEqual([...new Set(writeTargets)], ['WRITE_TABLE'], '所有写操作都必须经由 WRITE_TABLE');
  });

  console.log(`\n${passed} passed`);
}

main();
