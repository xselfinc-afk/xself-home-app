-- 20260711_ads_native_config_rows.sql
-- Phase N1: seed the Native Advanced (Discover) remote-config rows, all OFF.
-- Read by src/services/adsConfigService.ts (screen='ads'). Idempotent:
-- on conflict do nothing, so re-running never flips a later-enabled flag.
--
-- Native ads stay OFF and in TEST mode by default:
--   ads_native_enabled   = false  (requires ads_enabled=true too to show)
--   ads_native_interval  = 21     (one full-width ad row after every 21 products)
--   ads_native_test_mode = true   (request Google TEST native ads, never production)

insert into public.home_content_config (screen, key, value, is_active) values
  ('ads', 'ads_native_enabled',   'false', true),
  ('ads', 'ads_native_interval',  '21',    true),
  ('ads', 'ads_native_test_mode', 'true',  true)
on conflict (screen, key) do nothing;
