/**
 * Script-side automation-config loader.
 *
 * Lives under scripts/ deliberately: it names SUPABASE_SERVICE_ROLE_KEY, which must never appear in
 * anything bundled into the app. `src/services/inventoryAutomationConfig.ts` therefore takes an
 * injected reader instead of constructing a privileged client itself, and the production guardrails
 * enforce that separation.
 */
import {
  INVENTORY_AUTOMATION_DEFAULTS,
  loadInventoryAutomationConfig,
  type InventoryAutomationConfig,
} from '../../src/services/inventoryAutomationConfig';

/**
 * Load the effective config using the service-role key. Falls back to code defaults (all automation
 * OFF) when the key is absent or the read fails, so a misconfigured environment can never
 * accidentally enable automation.
 */
export async function loadInventoryConfigForScript(): Promise<InventoryAutomationConfig> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ...INVENTORY_AUTOMATION_DEFAULTS };
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(url, key, { auth: { persistSession: false } });
    return await loadInventoryAutomationConfig(sb as never);
  } catch {
    return { ...INVENTORY_AUTOMATION_DEFAULTS };
  }
}
