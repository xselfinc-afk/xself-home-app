/**
 * 人工确认 Website Product ID —— 纯单元测试，不碰网络、数据库、浏览器。
 *
 * 核心立场：人工只提供「查哪一个 product_id」，不提供「答案」。反查仍是同一条铁律：
 * 详情页回报的 SKU 必须与目标 SKU 完全相同（只 trim，不做任何模糊化）。
 *
 * 运行：npx tsx src/__tests__/supplierManualIdentity.test.ts
 */
import assert from 'node:assert/strict';
import {
  verifyManualIdentity,
  PORTAL_MAPPING_SOURCE,
  PORTAL_MAPPING_CONFIDENCE,
  type StoredPortalMapping,
} from '../services/supplierPortalMapping';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

/** 真实案例：门户页面上 Item Code 56481.00 对应 URL product_id 654876。 */
const SKU = '56481.00';
const PID = 654876;

function storedRow(over: Partial<StoredPortalMapping> = {}): StoredPortalMapping {
  return {
    supplier_product_id: SKU,
    website_product_id: PID,
    portal_sku: SKU,
    source: PORTAL_MAPPING_SOURCE,
    confidence: PORTAL_MAPPING_CONFIDENCE,
    resolved_at: '2026-08-07T00:00:00.000Z',
    last_verified_at: '2026-08-07T00:00:00.000Z',
    ...over,
  };
}

function main(): void {
  it('15. 真实 fixture：56481.00 + 654876 且详情页回报 56481.00 → 验证通过', () => {
    const v = verifyManualIdentity({
      supplier_product_id: SKU,
      website_product_id: PID,
      portal_sku: SKU,
      product_title: 'Wood 24" SADDLE STOOL',
    });
    assert.equal(v.status, 'verified');
    assert.equal(v.can_save, true);
    assert.equal(v.website_product_id, PID);
    assert.equal(v.portal_sku, SKU);
    assert.equal(v.product_title, 'Wood 24" SADDLE STOOL');
  });

  it('6. portal_sku 不一致 → 禁止保存', () => {
    const v = verifyManualIdentity({ supplier_product_id: SKU, website_product_id: PID, portal_sku: '99999.00' });
    assert.equal(v.status, 'sku_mismatch');
    assert.equal(v.can_save, false, '不一致时绝不允许保存');
    assert.equal(v.portal_sku, '99999.00', '必须把门户实际返回的 SKU 显示出来');
  });

  it('归一化只允许 trim —— 任何模糊匹配都不得通过', () => {
    // 大小写、去 .00、去 -1、去空格、相似标题：全部必须判为不一致。
    const fuzzy: Array<[string, string]> = [
      ['56481.00', '56481'],
      ['56481.00', '56481.0'],
      ['N721S000044K-1', 'N721S000044K'],
      ['AA20690708G', 'aa20690708g'],
      ['67062.00MEDBRN-Q-FULL BED', '67062.00MEDBRN-Q-FULLBED'],
    ];
    for (const [sku, portal] of fuzzy) {
      const v = verifyManualIdentity({ supplier_product_id: sku, website_product_id: 111, portal_sku: portal });
      assert.equal(v.status, 'sku_mismatch', `${sku} vs ${portal} 必须判为不一致`);
      assert.equal(v.can_save, false);
    }
    // 只有首尾空白允许被忽略。
    const trimmed = verifyManualIdentity({ supplier_product_id: ' 56481.00 ', website_product_id: PID, portal_sku: '56481.00 ' });
    assert.equal(trimmed.status, 'verified');
  });

  it('7. product_id 读不到详情 → 未找到，禁止保存', () => {
    const v = verifyManualIdentity({ supplier_product_id: SKU, website_product_id: 999999999, portal_sku: null });
    assert.equal(v.status, 'not_found');
    assert.equal(v.can_save, false);
  });

  it('4. product_id 必须是正整数', () => {
    for (const bad of ['', 'abc', '-5', '0', '12.5', '654876x', null, undefined]) {
      const v = verifyManualIdentity({ supplier_product_id: SKU, website_product_id: bad, portal_sku: SKU });
      assert.equal(v.status, 'invalid_product_id', `${String(bad)} 必须被拒绝`);
      assert.equal(v.can_save, false);
    }
  });

  it('12. 已存在完全相同的映射 → 幂等，不重复制造记录', () => {
    const v = verifyManualIdentity({
      supplier_product_id: SKU, website_product_id: PID, portal_sku: SKU, existing: storedRow(),
    });
    assert.equal(v.status, 'already_mapped');
    assert.equal(v.can_save, false, '幂等状态不需要再写一次');
  });

  it('13. 该 SKU 已映射到别的 product_id → 禁止静默覆盖', () => {
    const v = verifyManualIdentity({
      supplier_product_id: SKU, website_product_id: PID, portal_sku: SKU,
      existing: storedRow({ website_product_id: 111111 }),
    });
    assert.equal(v.status, 'conflict_existing_mapping');
    assert.equal(v.can_save, false);
    assert.match(v.detail ?? '', /需要人工确认覆盖/);
  });

  it('14. 同一 product_id 被别的 SKU 使用 → 警告但不自动判错、不猜 alias', () => {
    const v = verifyManualIdentity({
      supplier_product_id: SKU, website_product_id: PID, portal_sku: SKU,
      otherSkusUsingId: ['57875.00', '58907.00'],
    });
    // 仍然可以保存 —— 供应商可能存在 alias，我们不替它下结论。
    assert.equal(v.status, 'verified');
    assert.equal(v.can_save, true);
    assert.deepEqual(v.also_used_by, ['57875.00', '58907.00']);
    assert.match(v.detail ?? '', /已关联其他 Supplier SKU/);
    // 但反查依旧是硬门槛：同样这批 alias，SKU 对不上就不许存。
    const mismatched = verifyManualIdentity({
      supplier_product_id: SKU, website_product_id: PID, portal_sku: '57875.00',
      otherSkusUsingId: ['57875.00'],
    });
    assert.equal(mismatched.can_save, false, 'alias 不得成为绕过反查的理由');
  });

  it('自身 SKU 不算「被别人使用」', () => {
    const v = verifyManualIdentity({
      supplier_product_id: SKU, website_product_id: PID, portal_sku: SKU, otherSkusUsingId: [SKU],
    });
    assert.deepEqual(v.also_used_by, []);
    assert.equal(v.detail, null);
  });

  it('只有 verified 一种状态允许保存', () => {
    const statuses = new Set<string>();
    const cases = [
      { website_product_id: PID, portal_sku: SKU },                                   // verified
      { website_product_id: PID, portal_sku: 'X' },                                   // mismatch
      { website_product_id: PID, portal_sku: null },                                  // not_found
      { website_product_id: 'nope', portal_sku: SKU },                                // invalid
      { website_product_id: PID, portal_sku: SKU, existing: storedRow() },            // already
      { website_product_id: PID, portal_sku: SKU, existing: storedRow({ website_product_id: 1 }) }, // conflict
    ];
    for (const c of cases) {
      const v = verifyManualIdentity({ supplier_product_id: SKU, ...c } as never);
      statuses.add(v.status);
      assert.equal(v.can_save, v.status === 'verified', `${v.status} 的 can_save 必须与 verified 一致`);
    }
    assert.equal(statuses.size, 6, '六种状态都要被覆盖到');
  });

  console.log(`\n${passed} passed`);
}

main();
