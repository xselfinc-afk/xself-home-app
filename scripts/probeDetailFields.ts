import 'dotenv/config';
import { gigaRequest } from '../src/services/gigaApiClient';

async function run() {
  const res = await gigaRequest('/b2b-overseas-api/v1/buyer/product/detailInfo/v1', { skus: ['W28209580'] });
  const item = Array.isArray(res?.data) ? res.data[0] : res?.data;
  console.log('\nALL KEYS:', Object.keys(item ?? {}).join(', '));
  console.log('stock:', item?.stock, '| inventory:', item?.inventory, '| skuAvailable:', item?.skuAvailable);
  console.log('warehouseStock:', item?.warehouseStock);
  console.log('warehouseStockList:', item?.warehouseStockList);
  console.log('\nFULL ITEM (first 3000 chars):\n', JSON.stringify(item, null, 2).slice(0, 3000));
}

run().catch(console.error);
