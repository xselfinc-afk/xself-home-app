/**
 * Inventory-automation remote config (Phase 1). Reuses the EXISTING home_content_config
 * key/value table + is_active RLS pattern (screen='inventory_automation'), mirroring
 * adsConfigService. Code DEFAULTS keep ALL automation and catalog mutation DISABLED, and
 * fall back to defaults on any error, so nothing activates until server rows are
 * explicitly created (which this phase does NOT do).
 */
// NOTE: supabase is imported LAZILY inside loadInventoryAutomationConfig() so this
// module's pure exports (defaults, parser, safety evaluators) stay importable in node/tsx
// unit tests without pulling the React Native runtime.

export type InventoryAutomationConfig = {
  automationEnabled: boolean;          // global kill switch (master)
  pickupScanEnabled: boolean;          // per-source: Pickup
  dropshipScanEnabled: boolean;        // per-source: Dropship
  autoDelistEnabled: boolean;          // live delist apply (Phase 1: stays false)
  autoRelistEnabled: boolean;          // live relist apply (Phase 1: stays false)
  outOfStockConfirmations: number;     // zeros required before delist-eligible
  relistConfirmations: number;         // in-stocks required before relist-eligible
  maxScanPerRun: number;
  maxDelistPerRun: number;             // absolute cap
  maxDelistPercent: number;            // percentage cap
  bulkChangeRequiresApproval: boolean;
  caPriorityEnabled: boolean;          // browse CA-priority consumption (default off)
  checkoutRevalidationEnabled: boolean;// checkout stale/unknown gate (default off)
};

export const INVENTORY_AUTOMATION_DEFAULTS: InventoryAutomationConfig = {
  automationEnabled: false,
  pickupScanEnabled: false,
  dropshipScanEnabled: false,
  autoDelistEnabled: false,
  autoRelistEnabled: false,
  outOfStockConfirmations: 2,
  relistConfirmations: 2,
  maxScanPerRun: 100,
  maxDelistPerRun: 5,
  maxDelistPercent: 5,
  bulkChangeRequiresApproval: true,
  caPriorityEnabled: false,
  checkoutRevalidationEnabled: false,
};

const KEY_MAP: Record<string, keyof InventoryAutomationConfig> = {
  inventory_automation_enabled: 'automationEnabled',
  inventory_pickup_scan_enabled: 'pickupScanEnabled',
  inventory_dropship_scan_enabled: 'dropshipScanEnabled',
  inventory_auto_delist_enabled: 'autoDelistEnabled',
  inventory_auto_relist_enabled: 'autoRelistEnabled',
  inventory_out_of_stock_confirmations: 'outOfStockConfirmations',
  inventory_relist_confirmations: 'relistConfirmations',
  inventory_max_scan_per_run: 'maxScanPerRun',
  inventory_max_delist_per_run: 'maxDelistPerRun',
  inventory_max_delist_percent: 'maxDelistPercent',
  inventory_bulk_change_requires_approval: 'bulkChangeRequiresApproval',
  inventory_ca_priority_enabled: 'caPriorityEnabled',
  inventory_checkout_revalidation_enabled: 'checkoutRevalidationEnabled',
};

const BOOL_FIELDS: ReadonlySet<keyof InventoryAutomationConfig> = new Set([
  'automationEnabled', 'pickupScanEnabled', 'dropshipScanEnabled', 'autoDelistEnabled',
  'autoRelistEnabled', 'bulkChangeRequiresApproval', 'caPriorityEnabled', 'checkoutRevalidationEnabled',
]);

/** Parse one config row onto the typed config. Exported for tests. Numeric values must be >= 0. */
export function applyInventoryConfigRow(cfg: InventoryAutomationConfig, key: string, value: string | null | undefined): InventoryAutomationConfig {
  const field = KEY_MAP[key];
  if (!field || value == null || value === '') return cfg;
  if (BOOL_FIELDS.has(field)) return { ...cfg, [field]: value === 'true' || value === '1' };
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) return cfg;
  return { ...cfg, [field]: n };
}

export async function loadInventoryAutomationConfig(): Promise<InventoryAutomationConfig> {
  try {
    const { supabase } = await import('../lib/supabase');
    const { data, error } = await supabase
      .from('home_content_config')
      .select('key, value')
      .eq('screen', 'inventory_automation')
      .eq('is_active', true);
    if (error || !data) return { ...INVENTORY_AUTOMATION_DEFAULTS };
    let cfg: InventoryAutomationConfig = { ...INVENTORY_AUTOMATION_DEFAULTS };
    for (const row of data) cfg = applyInventoryConfigRow(cfg, row.key, row.value);
    return cfg;
  } catch {
    return { ...INVENTORY_AUTOMATION_DEFAULTS };
  }
}

// ── Pure safety-limit policy (Scope D) ──────────────────────────────────────────
export type SafetyBlock =
  | 'automation_disabled'
  | 'source_disabled'
  | 'auto_delist_disabled'
  | 'exceeds_max_delist_per_run'
  | 'exceeds_max_delist_percent'
  | 'requires_human_approval';

export interface SafetyDecision { allowed: boolean; blocks: SafetyBlock[]; }

/** Would a per-source SCAN be allowed to run live? (Dry-run always runs; this gates the future apply.) */
export function evaluateSourceScanAllowed(cfg: InventoryAutomationConfig, source: 'pickup' | 'dropship'): SafetyDecision {
  const blocks: SafetyBlock[] = [];
  if (!cfg.automationEnabled) blocks.push('automation_disabled');
  if (source === 'pickup' && !cfg.pickupScanEnabled) blocks.push('source_disabled');
  if (source === 'dropship' && !cfg.dropshipScanEnabled) blocks.push('source_disabled');
  return { allowed: blocks.length === 0, blocks };
}

/**
 * Would a proposed batch of automatic DELISTS be allowed to APPLY? Pure — evaluates every
 * guard so the dry-run report can show exactly what would block. In Phase 1 this always
 * gates to NOT-allowed for the live path (auto_delist_enabled defaults false).
 */
export function evaluateDelistBatchAllowed(
  cfg: InventoryAutomationConfig,
  input: { proposedDelistCount: number; totalPublished: number },
): SafetyDecision {
  const blocks: SafetyBlock[] = [];
  if (!cfg.automationEnabled) blocks.push('automation_disabled');
  if (!cfg.autoDelistEnabled) blocks.push('auto_delist_disabled');
  if (input.proposedDelistCount > cfg.maxDelistPerRun) blocks.push('exceeds_max_delist_per_run');
  const pct = input.totalPublished > 0 ? (input.proposedDelistCount / input.totalPublished) * 100 : 0;
  if (pct > cfg.maxDelistPercent) blocks.push('exceeds_max_delist_percent');
  const overCap = input.proposedDelistCount > cfg.maxDelistPerRun || pct > cfg.maxDelistPercent;
  if (cfg.bulkChangeRequiresApproval && overCap) blocks.push('requires_human_approval');
  return { allowed: blocks.length === 0, blocks };
}
