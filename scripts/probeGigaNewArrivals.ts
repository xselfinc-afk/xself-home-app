/**
 * Probe: check if GIGA API supports any new_arrival filter or returns date fields.
 * Run: npx tsx scripts/probeGigaNewArrivals.ts
 */

import 'dotenv/config';
import { gigaRequest } from '../src/services/gigaApiClient';

const DATE_FIELDS = ['listedAt','publishTime','publishDate','onshelfTime','addedAt','createdAt','isNewArrival','channel','source','collection','tag','categoryTag','newArrival','new_arrival'];

async function probeNewArrivalsParam() {
  console.log('\n=== PROBE 1: SKU list with isNewArrival:true param ===');
  try {
    const res = await gigaRequest('/b2b-overseas-api/v1/buyer/product/skus/v1', {
      page: 1, pageSize: 100, isNewArrival: true,
    });
    const items = res?.data?.records ?? res?.data?.list ?? res?.data ?? [];
    console.log('  result count:', Array.isArray(items) ? items.length : 'non-array');
    console.log('  raw response keys:', Object.keys(res ?? {}));
  } catch (e: any) {
    console.log('  error:', e.message?.slice(0, 200));
  }
}

async function probeChannelParam() {
  console.log('\n=== PROBE 2: SKU list with channel:"new_arrival" param ===');
  try {
    const res = await gigaRequest('/b2b-overseas-api/v1/buyer/product/skus/v1', {
      page: 1, pageSize: 100, channel: 'new_arrival',
    });
    const items = res?.data?.records ?? res?.data?.list ?? res?.data ?? [];
    console.log('  result count:', Array.isArray(items) ? items.length : 'non-array');
  } catch (e: any) {
    console.log('  error:', e.message?.slice(0, 200));
  }
}

async function inspectRawPayloadFields() {
  console.log('\n=== PROBE 3: Check raw detail payload for any date/arrival fields ===');
  try {
    const listRes = await gigaRequest('/b2b-overseas-api/v1/buyer/product/skus/v1', {
      page: 1, pageSize: 5,
    });
    const items = listRes?.data?.records ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      console.log('  no items returned');
      return;
    }
    const skus = items.map((r: any) => r.sku).filter(Boolean).slice(0, 5);
    console.log('  probing detail for SKUs:', skus);

    const detailRes = await gigaRequest('/b2b-overseas-api/v1/buyer/product/detailInfo/v1', { skus });
    const details = detailRes?.data?.records ?? detailRes?.data?.list ?? detailRes?.data ?? [];
    const arr = Array.isArray(details) ? details : [];

    arr.slice(0, 3).forEach((item: any, i: number) => {
      const allKeys = Object.keys(item);
      const found = DATE_FIELDS.filter(f => allKeys.includes(f));
      console.log(`\n  item[${i}] sku=${item.sku}`);
      console.log('    all keys:', allKeys.join(', '));
      if (found.length > 0) {
        console.log('    *** DATE/ARRIVAL FIELDS FOUND:', found);
        found.forEach(f => console.log(`    ${f}:`, item[f]));
      } else {
        console.log('    no date/arrival fields in response');
      }
    });
  } catch (e: any) {
    console.log('  error:', e.message?.slice(0, 200));
  }
}

async function run() {
  await probeNewArrivalsParam();
  await probeChannelParam();
  await inspectRawPayloadFields();
}

run().catch(console.error);
