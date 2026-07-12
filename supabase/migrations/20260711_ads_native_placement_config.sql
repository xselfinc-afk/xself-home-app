-- 20260711_ads_native_placement_config.sql
-- Native Ads V1 — seed the Discover-max / Search / Detail placement config rows,
-- all OFF and safe. Read by src/services/adsConfigService.ts (screen='ads').
-- Idempotent (on conflict do nothing) so it never overwrites later dashboard edits.
--
-- ads_discover_interval (24) already exists from the table's initial seed.
insert into public.home_content_config (screen, key, value, is_active) values
  ('ads', 'ads_discover_interval', '24',  true),   -- Discover: first ad after product 24
  ('ads', 'ads_discover_max',    '2',     true),   -- Discover: max 2 Native ads
  ('ads', 'ads_search_enabled',  'false', true),   -- Search placement OFF
  ('ads', 'ads_search_interval', '24',    true),   -- Search: first ad after result 24
  ('ads', 'ads_search_max',      '1',     true),   -- Search: max 1 Native ad
  ('ads', 'ads_detail_enabled',  'false', true)    -- Product Detail placement OFF
on conflict (screen, key) do nothing;
