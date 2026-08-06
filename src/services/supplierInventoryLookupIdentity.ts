/**
 * Resolve the supplier lookup identity ("Supplier Item Code") for one XSelf SKU.
 *
 * Hard guarantees, all covered by tests:
 *
 * 1. The XSelf SKU is never used to query the supplier. It is only an input key.
 * 2. The legacy `supplier_product_id` is never used as a fallback lookup identity.
 * 3. The identity is never *constructed*. It is only ever *selected* from the
 *    supplier's own `raw_payload.associateProductList`. If the expected sibling
 *    code is absent from that list, resolution fails — it is not synthesized by
 *    rewriting a character.
 * 4. Ambiguity fails closed. Zero candidates and multiple candidates are two
 *    different, separately reported outcomes; neither guesses.
 *
 * The selection rule is a *positional role-marker relation*: within one supplier
 * variant family the same physical item appears under a purchasing code and an
 * inventory code that are identical except for a single role character at a fixed
 * position. Applying it as a filter over supplier-provided siblings is what keeps
 * `N707P186617W` bound to `N707S186617W` instead of its `B`/`E` colour siblings.
 * The rule narrows a supplier-provided set; it does not invent a member of it.
 */

export type InventoryLookupIdentitySource =
  | 'supplier_products.raw_payload.associateProductList';

export type InventoryLookupIdentityConfidence = 'verified_variant_relation';

export type InventoryLookupIdentityErrorCode =
  | 'identity_input_invalid'
  | 'identity_mapping_missing'
  | 'identity_mapping_conflict';

export interface InventoryLookupIdentityError {
  code: InventoryLookupIdentityErrorCode;
  message: string;
  details: {
    xself_sku: string;
    legacy_supplier_product_id: string;
    candidate_count: number;
    candidates: string[];
  };
  retryable: boolean;
}

export interface InventoryLookupIdentityInput {
  xselfSku: string;
  legacySupplierProductId: string;
  associateProductList: unknown;
}

interface InventoryLookupIdentityBase {
  xself_sku: string;
  legacy_supplier_product_id: string;
}

export interface ResolvedInventoryLookupIdentity extends InventoryLookupIdentityBase {
  lookup_identity: string;
  identity_source: InventoryLookupIdentitySource;
  identity_confidence: InventoryLookupIdentityConfidence;
  identity_error: null;
}

export interface UnresolvedInventoryLookupIdentity extends InventoryLookupIdentityBase {
  lookup_identity: null;
  identity_source: null;
  identity_confidence: null;
  identity_error: InventoryLookupIdentityError;
}

export type InventoryLookupIdentityResult =
  | ResolvedInventoryLookupIdentity
  | UnresolvedInventoryLookupIdentity;

/** Kept for callers that still want an exception form. Not thrown by the resolver itself. */
export class InventoryIdentityMappingError extends Error {
  constructor(
    readonly code: InventoryLookupIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InventoryIdentityMappingError';
  }
}

const ROLE_MARKER_FROM = 'P';
const ROLE_MARKER_TO = 'S';

function normalizedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

/**
 * True when `candidate` is the same code as `legacy` except for exactly one
 * position, and that position carries the purchasing→inventory role markers.
 *
 * This is a predicate over a value the supplier already gave us. It is never used
 * to build a string.
 */
function isVariantRoleSubstitution(legacy: string, candidate: string): boolean {
  if (candidate.length !== legacy.length || candidate === legacy) return false;
  const differences: number[] = [];
  for (let index = 0; index < legacy.length; index += 1) {
    if (legacy[index] !== candidate[index]) differences.push(index);
  }
  if (differences.length !== 1) return false;
  const position = differences[0];
  return legacy[position]?.toUpperCase() === ROLE_MARKER_FROM
    && candidate[position]?.toUpperCase() === ROLE_MARKER_TO;
}

function unresolved(
  base: InventoryLookupIdentityBase,
  code: InventoryLookupIdentityErrorCode,
  message: string,
  candidates: string[],
): UnresolvedInventoryLookupIdentity {
  return {
    ...base,
    lookup_identity: null,
    identity_source: null,
    identity_confidence: null,
    identity_error: {
      code,
      message,
      details: {
        xself_sku: base.xself_sku,
        legacy_supplier_product_id: base.legacy_supplier_product_id,
        candidate_count: candidates.length,
        candidates,
      },
      // None of these clear by retrying the same read. They need supplier data to change.
      retryable: false,
    },
  };
}

/**
 * Resolve one XSelf SKU to its supplier lookup identity.
 *
 * Returns a result object for every outcome. It does not throw for expected
 * failures, so callers can report a stable error code instead of parsing a string.
 */
export function resolveInventoryLookupIdentity(
  input: InventoryLookupIdentityInput,
): InventoryLookupIdentityResult {
  const xselfSku = input.xselfSku.trim();
  const legacy = input.legacySupplierProductId.trim();
  const base: InventoryLookupIdentityBase = {
    xself_sku: xselfSku,
    legacy_supplier_product_id: legacy,
  };

  if (!xselfSku || !legacy) {
    return unresolved(
      base,
      'identity_input_invalid',
      '缺少 XSelf SKU 或旧供应商商品身份，无法解析供应商查询身份',
      [],
    );
  }

  const supplierProvided = normalizedStrings(input.associateProductList);
  const candidates = supplierProvided.filter((candidate) => isVariantRoleSubstitution(legacy, candidate));

  if (candidates.length === 0) {
    return unresolved(
      base,
      'identity_mapping_missing',
      '现有商品关系中没有可用的 Supplier Item Code；不会用 XSelf SKU 或旧 P 码代替',
      supplierProvided,
    );
  }
  if (candidates.length > 1) {
    return unresolved(
      base,
      'identity_mapping_conflict',
      '现有商品关系包含多个可能的 Supplier Item Code，已拒绝猜测',
      candidates,
    );
  }

  const lookupIdentity = candidates[0];
  // Guarantee 3, asserted rather than assumed: the resolved value must be a member
  // of the supplier-provided list, never something this function assembled.
  if (!supplierProvided.includes(lookupIdentity)) {
    return unresolved(
      base,
      'identity_mapping_missing',
      '解析结果不在供应商提供的关联商品列表中，已拒绝使用',
      supplierProvided,
    );
  }

  return {
    ...base,
    lookup_identity: lookupIdentity,
    identity_source: 'supplier_products.raw_payload.associateProductList',
    identity_confidence: 'verified_variant_relation',
    identity_error: null,
  };
}

export function isResolvedInventoryLookupIdentity(
  value: InventoryLookupIdentityResult,
): value is ResolvedInventoryLookupIdentity {
  return value.identity_error === null && typeof value.lookup_identity === 'string';
}
