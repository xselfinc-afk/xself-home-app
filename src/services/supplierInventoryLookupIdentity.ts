/**
 * Resolve the supplier lookup identity ("Supplier Item Code") for one XSelf SKU.
 *
 * There are two legitimate identity sources, and neither of them is a guess:
 *
 *   A. Variant relation — the supplier's own `raw_payload.associateProductList` names a sibling
 *      code for the same physical item. Selected, never constructed.
 *
 *   B. Capability verification — some products are synced with a lean payload that has no
 *      `associateProductList` at all. For those, `supplier_product_id` (which equals
 *      `raw_payload.sku`) is offered as a CANDIDATE ONLY. The caller must prove it works against
 *      the live supplier APIs on both accounts before it may be used.
 *
 * Hard guarantees, all covered by tests:
 *
 * 1. The XSelf SKU is never used to query the supplier. It is only an input key.
 * 2. No identity is ever *constructed*. Source A selects from supplier-provided siblings;
 *    source B echoes an identifier the supplier itself stored. Neither rewrites characters.
 * 3. A source-B candidate is never returned as resolved. It comes back as
 *    `pending_capability_verification` and is only usable after the caller verifies it.
 * 4. Ambiguity fails closed. Conflicting identifiers are reported, never picked between.
 *
 * The P/S letters are a supplier coding convention, not a rule. They narrow source A's candidate
 * set; they never decide whether an identity is legitimate. That is what capability proves.
 */

export type InventoryLookupIdentitySource =
  | 'supplier_products.raw_payload.associateProductList'
  | 'capability_verified_supplier_identity';

export type InventoryLookupIdentityConfidence =
  | 'verified_variant_relation'
  | 'verified';

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
  /** `raw_payload.sku`. When present it must agree with legacySupplierProductId. */
  supplierPayloadSku?: unknown;
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

/** Not an answer. A candidate the caller must prove before using. */
export interface PendingInventoryLookupIdentity extends InventoryLookupIdentityBase {
  lookup_identity: null;
  identity_source: null;
  identity_confidence: null;
  identity_error: null;
  pending_capability_verification: true;
  candidate: string;
}

export interface UnresolvedInventoryLookupIdentity extends InventoryLookupIdentityBase {
  lookup_identity: null;
  identity_source: null;
  identity_confidence: null;
  identity_error: InventoryLookupIdentityError;
}

export type InventoryLookupIdentityResult =
  | ResolvedInventoryLookupIdentity
  | PendingInventoryLookupIdentity
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
 * True when `candidate` is the same code as `legacy` except for exactly one position, and that
 * position carries the purchasing→inventory role markers.
 *
 * This is a predicate over a value the supplier already gave us. It never builds a string.
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
 * Resolve one XSelf SKU to its supplier lookup identity, or to a candidate that still needs
 * capability verification. Returns a result object for every outcome; it does not throw for
 * expected failures, so callers can report a stable code instead of parsing a string.
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
      '缺少 XSelf SKU 或供应商商品身份，无法解析供应商查询身份',
      [],
    );
  }

  // The supplier stored two different identifiers for the same row. Never pick between them.
  const payloadSku = input.supplierPayloadSku === undefined || input.supplierPayloadSku === null
    ? ''
    : String(input.supplierPayloadSku).trim();
  if (payloadSku && payloadSku !== legacy) {
    return unresolved(
      base,
      'identity_mapping_conflict',
      'supplier_product_id 与 raw_payload.sku 不一致，已拒绝在两者之间猜测',
      [legacy, payloadSku],
    );
  }

  // ── Source A: the supplier's own variant relation ──────────────────────────────────────────
  const supplierProvided = normalizedStrings(input.associateProductList);
  const candidates = supplierProvided.filter((candidate) => isVariantRoleSubstitution(legacy, candidate));

  if (candidates.length > 1) {
    return unresolved(
      base,
      'identity_mapping_conflict',
      '现有商品关系包含多个可能的 Supplier Item Code，已拒绝猜测',
      candidates,
    );
  }

  if (candidates.length === 1) {
    const lookupIdentity = candidates[0];
    // Guarantee 2, asserted rather than assumed.
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

  // ── Source B: no usable variant relation, so offer the supplier's own identifier ───────────
  // This is NOT an answer. The caller must prove it against the live APIs on both accounts.
  return {
    ...base,
    lookup_identity: null,
    identity_source: null,
    identity_confidence: null,
    identity_error: null,
    pending_capability_verification: true,
    candidate: legacy,
  };
}

export function isResolvedInventoryLookupIdentity(
  value: InventoryLookupIdentityResult,
): value is ResolvedInventoryLookupIdentity {
  return value.identity_error === null
    && !('pending_capability_verification' in value)
    && typeof value.lookup_identity === 'string';
}

export function isPendingCapabilityVerification(
  value: InventoryLookupIdentityResult,
): value is PendingInventoryLookupIdentity {
  return 'pending_capability_verification' in value;
}

/**
 * Promote a proven candidate to a resolved identity. Call this ONLY after every capability in the
 * chain has succeeded on both accounts and reported the same identity back.
 */
export function acceptCapabilityVerifiedIdentity(
  pending: PendingInventoryLookupIdentity,
): ResolvedInventoryLookupIdentity {
  return {
    xself_sku: pending.xself_sku,
    legacy_supplier_product_id: pending.legacy_supplier_product_id,
    lookup_identity: pending.candidate,
    identity_source: 'capability_verified_supplier_identity',
    identity_confidence: 'verified',
    identity_error: null,
  };
}
