import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  XONE_INVENTORY_LIFECYCLE_SCHEMA_VERSION,
  parseInventoryLifecycleBridgeRequest,
  readSchedulerFact,
} from '../../scripts/xoneInventoryLifecycleBridge';

const summary = parseInventoryLifecycleBridgeRequest(JSON.stringify({
  schema_version: XONE_INVENTORY_LIFECYCLE_SCHEMA_VERSION,
  operation: 'summary',
}));
assert.equal(summary.operation, 'summary');

const items = parseInventoryLifecycleBridgeRequest(JSON.stringify({
  schema_version: '1.0',
  operation: 'items',
  bucket: 'eligible',
  limit: 100,
  cursor: 0,
  sku: 'XH-TEST_1',
}));
assert.equal(items.operation, 'items');

const targetedRecheck = parseInventoryLifecycleBridgeRequest(JSON.stringify({
  schema_version: '1.0',
  operation: 'recheck-item',
  sku: 'XH-GH-HM-86617W',
  operator: '你',
}));
assert.equal(targetedRecheck.operation, 'recheck-item');

for (const request of [
  { schema_version: '1.0', operation: 'items', bucket: 'unknown' },
  { schema_version: '1.0', operation: 'items', bucket: 'errors', limit: 101 },
  { schema_version: '1.0', operation: 'runs', command: 'rm -rf' },
  { schema_version: '1.0', operation: 'summary', path: '/tmp/anything' },
  { schema_version: '1.0', operation: 'summary', sql: 'select * from secrets' },
  { schema_version: '1.0', operation: 'summary', table: 'standardized_products' },
  { schema_version: '1.0', operation: 'recheck-item', sku: 'XH-GH-HM-86617W', operator: '你', script_path: '/tmp/unsafe.ts' },
  { schema_version: '1.0', operation: 'recheck-item', sku: 'XH-GH-HM-86617W', operator: '\nunsafe' },
  { schema_version: '1.0', operation: 'recheck-item', sku: '../unsafe', operator: '你' },
]) {
  assert.throws(() => parseInventoryLifecycleBridgeRequest(JSON.stringify(request)));
}

const scheduler = readSchedulerFact();
assert.equal(scheduler.label, 'com.xselfhome.inventory-availability-scan');
assert.equal(scheduler.interval_seconds, 172_800);
assert.equal(scheduler.cadence_label, '每 48 小时');
assert.equal(typeof scheduler.installed, 'boolean');
assert.equal(typeof scheduler.loaded, 'boolean');

const serialized = JSON.stringify(scheduler);
assert.equal(serialized.includes('SUPABASE_SERVICE_ROLE_KEY'), false);
assert.equal(serialized.includes('Authorization'), false);
assert.equal(serialized.includes('Cookie'), false);

const cli = spawnSync(
  path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
  [path.join(process.cwd(), 'scripts', 'xoneInventoryLifecycleBridge.ts')],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: JSON.stringify({ schema_version: '1.0', operation: 'summary', sql: 'select secret' }),
    env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
  },
);
assert.equal(cli.status, 0);
const stdoutLines = cli.stdout.trim().split('\n');
assert.equal(stdoutLines.length, 1, 'stdout must contain exactly one JSON envelope');
const invalidResponse = JSON.parse(stdoutLines[0]) as Record<string, any>;
assert.equal(invalidResponse.schema_version, '1.0');
assert.equal(invalidResponse.ok, false);
assert.equal(invalidResponse.error.code, 'INVALID_REQUEST');
assert.equal(invalidResponse.data_source, 'unavailable');
assert.equal(invalidResponse.is_stale, true);
assert.equal(invalidResponse.production_write_attempted, false);
assert.equal(cli.stdout.includes('service_role'), false);
assert.equal(cli.stdout.includes('SUPABASE'), false);

const scannerSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'scanPublishedAvailability.ts'), 'utf8');
assert.equal(scannerSource.includes("val('xone-targeted')"), true);
assert.equal(scannerSource.includes("`xone-targeted-${XONE_TARGETED_TOKEN}.json`"), true);
assert.equal(scannerSource.includes(".in('supplier_product_id', ONLY_SKUS)"), true);

console.log('xoneInventoryLifecycleBridge tests passed');
