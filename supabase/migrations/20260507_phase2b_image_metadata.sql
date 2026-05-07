-- Phase 2b: image metadata for blurhash placeholders + layout hints.
-- Additive only. All columns nullable; existing rows tolerate NULL forever.
-- Backfilled by scripts/backfillBlurhash.ts; future rows by the
-- normalization pipeline (to be wired in a follow-up).

alter table public.standardized_products
  add column if not exists primary_image_blurhash text,
  add column if not exists primary_image_w        int,
  add column if not exists primary_image_h        int,
  add column if not exists primary_image_aspect   numeric(5, 3);
