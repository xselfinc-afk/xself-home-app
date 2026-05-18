-- Phase 3.0: own-storage mirror for primary product images.
-- Additive only. Original primary_image and gallery_images_json are NEVER mutated.
-- App reads mirror_path when EXPO_PUBLIC_PREFER_MIRROR=1 AND mirror_path is set,
-- otherwise falls back to the supplier URL transparently.

alter table public.standardized_products
  add column if not exists primary_image_mirror_path  text,
  add column if not exists primary_image_mirror_sha   text,
  add column if not exists primary_image_mirror_at    timestamptz,
  add column if not exists primary_image_mirror_status text not null default 'pending'
    check (primary_image_mirror_status in ('pending','mirrored','oversize','fetch_failed','skip'));

create index if not exists std_products_mirror_status_idx
  on public.standardized_products(primary_image_mirror_status);
