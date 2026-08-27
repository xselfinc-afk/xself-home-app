-- Commerce taxonomy — persist the four-level classification.
--
-- The Department → Category → Product Type → Rooms[] hierarchy has, until now,
-- existed only as a pure function recomputed in App memory on every launch
-- (src/utils/commerceTaxonomy.ts). Nothing was stored, so no second surface
-- could read it — which is exactly why the Website independently invented a
-- flat 13-slug taxonomy off `category_label` and the two drifted apart.
--
-- These columns make the classification a fact both surfaces read instead of a
-- computation each re-derives. The classifier itself does not move: it stays the
-- single reference implementation, and a sync job writes its output here.
--
-- All four columns are nullable with no default and are appended to the view,
-- so every existing reader is unaffected until it opts in. `needs-review` is a
-- legitimate stored value, not an absence — a null means "never classified",
-- which is a different thing and worth being able to tell apart.

alter table public.standardized_products
  add column if not exists commerce_department   text,
  add column if not exists commerce_category     text,
  add column if not exists commerce_product_type text,
  add column if not exists commerce_rooms        text[],
  add column if not exists commerce_classified_at timestamptz;

comment on column public.standardized_products.commerce_department is
  'Commerce taxonomy Department slug. Written by scripts/syncCommerceTaxonomy.ts from classifyCommerce(). ''needs-review'' is a real value; null means never classified.';
comment on column public.standardized_products.commerce_category is
  'Commerce taxonomy Category slug (child of commerce_department).';
comment on column public.standardized_products.commerce_product_type is
  'Commerce taxonomy Product Type slug (leaf). The value browse and the storefront route on.';
comment on column public.standardized_products.commerce_rooms is
  'Room slugs this product type belongs to. Empty array is meaningful (type has no room), null means never classified.';
comment on column public.standardized_products.commerce_classified_at is
  'When the classification was last written, so a stale-classification sweep can find rows the sync missed.';

-- Browse filters on product_type and category; department is the coarsest cut.
-- Partial indexes skip the unclassified rows, which are the ones no page reads.
create index if not exists standardized_products_commerce_type_idx
  on public.standardized_products (commerce_product_type)
  where commerce_product_type is not null;

create index if not exists standardized_products_commerce_category_idx
  on public.standardized_products (commerce_category)
  where commerce_category is not null;

create index if not exists standardized_products_commerce_department_idx
  on public.standardized_products (commerce_department)
  where commerce_department is not null;

-- Rooms is an array and is filtered by containment, so it needs GIN rather than btree.
create index if not exists standardized_products_commerce_rooms_idx
  on public.standardized_products using gin (commerce_rooms)
  where commerce_rooms is not null;

-- Re-declare the view with the four columns appended.
--
-- Everything above `commerce_department` is reproduced verbatim from the live
-- definition (pg_get_viewdef, 2026-08-27). CREATE OR REPLACE requires the
-- existing columns keep their exact order, names, and types, so this block must
-- not be "tidied" — appending at the end is the only safe edit.
create or replace view public.sellable_products as
 SELECT sp.id,
    sp.supplier_product_id,
    sp.product_title,
    sp.short_description,
    sp.price,
    sp.key_features_json,
    sp.specifications_json,
    sp.sku_custom,
    sp.supplier_sku,
    sp.category_display,
    sp.category_code,
    sp.scene_code,
    sp.color,
    sp.color_options_json,
    sp.has_multiple_colors,
    sp.show_color_selector,
    sp.material,
    sp.dimensions,
    sp.weight,
    sp.primary_image,
    sp.gallery_images_json,
    sp.published,
    sp.normalization_status,
    sp.normalization_notes,
    sp.source_payload,
    sp.created_at,
    sp.updated_at,
    sp.product_family_key,
    sp.product_title_display,
    sp.original_price,
    sp.sku_search,
    sp.category_label,
    sp.category_priority,
    sp.is_new_arrival,
    sp.new_arrival_source,
    sp.new_arrival_detected_at,
    sp.view_count,
    sp.click_count,
    sp.add_to_cart_count,
    sp.order_count,
    sp.selling_price,
    sp.last_priced_at,
    sp.base_retail_price,
    sp.pricing_markup,
    sp.fulfillment_buffer,
    sp.estimated_payment_fee,
    sp.estimated_net_profit,
    sp.estimated_net_margin,
    sp.optimized_title,
    sp.inventory_status,
    sp.total_available_qty,
    sp.available_warehouse_count,
    sp.has_ca_pickup,
    sp.has_valid_inventory,
    sp.inventory_last_synced_at,
    sp.primary_image_blurhash,
    sp.primary_image_w,
    sp.primary_image_h,
    sp.primary_image_aspect,
    sp.primary_image_mirror_path,
    sp.primary_image_mirror_sha,
    sp.primary_image_mirror_at,
    sp.primary_image_mirror_status,
    sp.delist_reason,
        CASE
            WHEN sp.inventory_last_synced_at IS NULL THEN 'missing'::text
            WHEN sp.inventory_last_synced_at > (now() - '24:00:00'::interval) THEN 'fresh'::text
            WHEN sp.inventory_last_synced_at > (now() - '7 days'::interval) THEN 'stale'::text
            ELSE 'expired'::text
        END AS inventory_freshness,
    sp.commerce_department,
    sp.commerce_category,
    sp.commerce_product_type,
    sp.commerce_rooms,
    sp.commerce_classified_at
   FROM standardized_products sp
     JOIN latest_product_availability la ON la.supplier_product_id = sp.supplier_product_id
  WHERE sp.normalization_status = 'done'::text AND sp.published = true AND sp.inventory_status = 'in_stock'::text AND sp.total_available_qty > 0 AND sp.product_title IS NOT NULL AND sp.primary_image IS NOT NULL AND sp.primary_image <> ''::text AND sp.price > 0::numeric AND sp.selling_price IS NOT NULL AND sp.selling_price > 0::numeric AND la.available IS TRUE AND la.within_grace IS TRUE;
