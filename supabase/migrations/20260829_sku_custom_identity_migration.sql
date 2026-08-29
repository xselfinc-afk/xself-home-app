-- 20260829_sku_custom_identity_migration.sql
--
-- SKU Identity Foundation (applied to production 2026-08-29 via `supabase db query
-- --linked`; this file is the committed record). GIGA reuses S000xx sequence tails
-- across sellers, so 6 groups / 12 rows shared a sku_custom. Canonical owner rule:
-- published wins; both published → earlier created_at wins. Re-minted codes append a
-- deterministic identity suffix from the FULL supplier_product_id
-- (specFormatter.skuIdentitySuffixCandidates). supplier_product_id never changes.
-- Old→new mapping (also in reports/sku-migration/2026-08-29.jsonl):
--
--   T6026S00005   XH-CB-HM-S00005 → XH-CB-HM-S00005-1E  (keeper W5107S00005, published)
--   W3871S00002   XH-DR-BD-S00002 → XH-DR-BD-S00002-1T  (keeper W1445S00002, published)
--   N707P186617W  XH-GH-HM-86617W → XH-GH-HM-86617W-00  (keeper N707S186617W, published)
--   W3244S00003   XH-SF-LR-S00003 → XH-SF-LR-S00003-10  (keeper W5872S00003, published)
--   W1767S00004   XH-SF-LR-S00004 → XH-SF-LR-S00004-1T  (keeper W3244S00004, published)
--   W5656S00039   XH-SF-LR-S00039 → XH-SF-LR-S00039-06  (keeper W2339S00039, published earlier;
--                                    both were published and both PDPs 404'd as ambiguous — this
--                                    migration makes both resolvable)
--
-- External impact: the 5 re-minted unpublished rows had no Web/Meta footprint; the
-- one published re-mint (W5656S00039) was already a Web 404 via the ambiguity guard,
-- so no live URL or Meta retailer_item_id was broken. sku_search was recomputed for
-- all six rows in the same transaction.

begin;
update standardized_products set sku_custom='XH-CB-HM-S00005-1E', sku_search='XHCBHMS000051E', updated_at=now() where supplier_product_id='T6026S00005';
update standardized_products set sku_custom='XH-DR-BD-S00002-1T', sku_search='XHDRBDS000021T', updated_at=now() where supplier_product_id='W3871S00002';
update standardized_products set sku_custom='XH-GH-HM-86617W-00', sku_search='XHGHHM86617W00', updated_at=now() where supplier_product_id='N707P186617W';
update standardized_products set sku_custom='XH-SF-LR-S00003-10', sku_search='XHSFLRS0000310', updated_at=now() where supplier_product_id='W3244S00003';
update standardized_products set sku_custom='XH-SF-LR-S00004-1T', sku_search='XHSFLRS000041T', updated_at=now() where supplier_product_id='W1767S00004';
update standardized_products set sku_custom='XH-SF-LR-S00039-06', sku_search='XHSFLRS0003906', updated_at=now() where supplier_product_id='W5656S00039';

-- Fail loudly (rollback) if any duplicate remains, then lock uniqueness forever.
do $$
declare dup int;
begin
  select count(*) into dup from (select sku_custom from standardized_products group by sku_custom having count(*)>1) d;
  if dup > 0 then raise exception 'still % duplicate sku_custom groups — rolling back', dup; end if;
end $$;
alter table standardized_products add constraint standardized_products_sku_custom_key unique (sku_custom);
commit;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- alter table standardized_products drop constraint standardized_products_sku_custom_key;
-- (then restore the six old sku_custom/sku_search values from the mapping above)
