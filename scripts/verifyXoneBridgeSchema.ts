/**
 * XOne 桥接的 select 列名契约校验 —— 只读，不写任何数据。
 *
 * 起因是一个不会报错的错误：`loadFacts` 的 select 里写了 standardized_products.product_type_id，
 * 而那不是这张表的列（是 planGigaSavedItems 算出来的中间值）。PostgREST 拒绝整条查询、只返回
 * error，调用处又从不看 error —— 于是每一件商品都被读成「不在 standardized_products、未发布」。
 * 已经上线的商品因此重新回到待上新，被写成「暂时无法上架」。
 *
 * 单元测试抓不到这一类：列名对不对，只有真实 schema 说了算。所以这里把每一条
 * `.from(表).select(列)` 拿去问一次数据库，limit(1)，看它成不成立。
 *
 * 没有数据库凭据时跳过并以 0 退出 —— 它是契约校验，不是必须联网才能提交代码的门槛。
 *
 * 运行：npm run verify:xone-bridge-schema
 */
import { config as loadEnv } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.local' });
loadEnv();

const SCRIPT_DIR = 'scripts';
const EXIT_OK = 0;
const EXIT_FAIL = 1;

/** 一条 select 语句：哪个文件、哪张表、要哪些列。 */
interface SelectSite {
  file: string;
  table: string;
  columns: string;
}

/** 从源码里抽出 `.from('表')` 之后最近的一个 `.select('列')`。 */
export function extractSelectSites(file: string, source: string): SelectSite[] {
  const pattern = /\.from\('([a-z_]+)'\)[\s\S]{0,200}?\.select\('([^']+)'\)/g;
  const seen = new Set<string>();
  const sites: SelectSite[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const [, table, columns] = match;
    // count/head 这类聚合写法列名只有一个，照样问一次，成本可以忽略。
    const key = `${table}|${columns}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sites.push({ file, table, columns });
  }
  return sites;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('skip=1 reason=no_supabase_credentials');
    process.exit(EXIT_OK);
  }

  const files = fs.readdirSync(SCRIPT_DIR)
    .filter((name) => name.startsWith('xone') && name.endsWith('.ts'))
    .map((name) => path.join(SCRIPT_DIR, name));

  const sites = files.flatMap((file) => extractSelectSites(file, fs.readFileSync(file, 'utf8')));
  const client = createClient(url, key);
  const failures: Array<SelectSite & { message: string }> = [];

  for (const site of sites) {
    const { error } = await client.from(site.table).select(site.columns).limit(1);
    if (error) failures.push({ ...site, message: error.message });
  }

  for (const failure of failures) {
    console.log(`fail file=${failure.file} table=${failure.table} error=${failure.message}`);
  }
  console.log(`files=${files.length} selects=${sites.length} failures=${failures.length}`);
  process.exit(failures.length === 0 ? EXIT_OK : EXIT_FAIL);
}

void main();
