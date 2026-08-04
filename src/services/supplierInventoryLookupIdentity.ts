export type InventoryLookupIdentitySource =
  | 'supplier_products.raw_payload.associateProductList';

export interface InventoryLookupIdentityInput {
  xselfSku: string;
  legacySupplierProductId: string;
  associateProductList: unknown;
}

export interface ResolvedInventoryLookupIdentity {
  xself_sku: string;
  lookup_identity: string;
  source: InventoryLookupIdentitySource;
  confidence: 'verified_variant_relation';
  legacy_supplier_product_id: string;
}

export class InventoryIdentityMappingError extends Error {
  readonly code = 'identity_mapping_error';

  constructor(message: string) {
    super(message);
    this.name = 'InventoryIdentityMappingError';
  }
}

function normalizedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

/**
 * Resolve the supplier lookup identity from the supplier's own variant relationship.
 *
 * This deliberately does not infer from the XSelf SKU and never falls back to the legacy P code.
 * A safe P→S relation must be unique and must preserve every other character, including the
 * variant suffix. That makes `N707P186617W` match only `N707S186617W`, not the B/E siblings.
 */
export function resolveInventoryLookupIdentity(
  input: InventoryLookupIdentityInput,
): ResolvedInventoryLookupIdentity {
  const xselfSku = input.xselfSku.trim();
  const legacy = input.legacySupplierProductId.trim();
  if (!xselfSku || !legacy) {
    throw new InventoryIdentityMappingError('缺少 XSelf SKU 或旧供应商商品身份');
  }

  const candidates = normalizedStrings(input.associateProductList).filter((candidate) => {
    if (candidate.length !== legacy.length || candidate === legacy) return false;
    const differences: number[] = [];
    for (let index = 0; index < legacy.length; index += 1) {
      if (legacy[index] !== candidate[index]) differences.push(index);
    }
    return differences.length === 1
      && legacy[differences[0]]?.toUpperCase() === 'P'
      && candidate[differences[0]]?.toUpperCase() === 'S';
  });

  if (candidates.length !== 1) {
    throw new InventoryIdentityMappingError(
      candidates.length === 0
        ? '现有商品关系中缺少唯一 Supplier Item Code'
        : '现有商品关系包含多个可能的 Supplier Item Code',
    );
  }

  return {
    xself_sku: xselfSku,
    lookup_identity: candidates[0],
    source: 'supplier_products.raw_payload.associateProductList',
    confidence: 'verified_variant_relation',
    legacy_supplier_product_id: legacy,
  };
}

