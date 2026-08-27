-- PDP rich content — stop discarding supplier facts at normalization.
--
-- The normalization pipeline reduces every product to a two-sentence
-- `short_description` and 4–6 short bullets, and drops the rest of what the
-- supplier sent. Measured across the 400 published supplier rows:
--
--   • supplier_products.description is clean prose (0% HTML), median 1,017
--     chars; short_description keeps a median of 290. ~71% is discarded.
--   • raw_payload.characteristics holds 2,205 curated bullets, median 225
--     chars. `isUsableBullet` rejects anything over 180, so 65% are thrown
--     away; for 76% of products fewer than 4 survive, and the generator then
--     re-splits the description into bullets instead. That is why 44% of
--     products have a first "feature" that merely restates the description.
--   • raw_payload carries structured attributes, assembled dimensions and an
--     MPN on 100% of products, a median of 18 images (we keep 7), a place of
--     origin on 66%, and certifications on 15%. None of it is stored.
--
-- These columns preserve the supplier's own content alongside the derived
-- summaries rather than in place of them. Every existing column keeps its
-- current meaning and value, so the app — which reads the derived fields —
-- is unaffected; this is purely additive.
--
-- Nothing here changes what a customer is charged or what is in stock.

alter table public.standardized_products
  add column if not exists description_full     text,
  add column if not exists features_full        jsonb,
  add column if not exists attributes_json      jsonb,
  add column if not exists assembled_dimensions jsonb,
  add column if not exists media_json           jsonb,
  add column if not exists mpn                  text,
  add column if not exists upc                  text,
  add column if not exists origin                text,
  add column if not exists certifications_json  jsonb;

comment on column public.standardized_products.description_full is
  'The supplier''s complete prose description, unabridged. `short_description` remains the 1–2 sentence summary for cards and meta descriptions; this is the PDP body copy.';
comment on column public.standardized_products.features_full is
  'The supplier''s complete `characteristics` array — full paragraphs, not the length-capped bullets in key_features_json. Each entry typically opens with its own heading.';
comment on column public.standardized_products.attributes_json is
  'Structured supplier attributes as key/value pairs (e.g. {"Seats":"1 Seat","Main Material":"Corduroy"}). Distinct from specifications_json, which is XSELF-derived.';
comment on column public.standardized_products.assembled_dimensions is
  'Assembled size as separate numbers plus units: {length,width,height,weight,lengthUnit,weightUnit}. `dimensions` stays the human-readable string; this is the machine-readable form for schema.org width/height/depth.';
comment on column public.standardized_products.media_json is
  'Every supplier image plus video URLs: {images:[],video:null,videos:[]}. gallery_images_json keeps the curated subset the grid renders; this is the full set for a PDP lightbox.';
comment on column public.standardized_products.mpn is
  'Manufacturer part number. Present on 100% of supplier rows and required for Google Merchant identifier_exists and schema.org Product.mpn.';
comment on column public.standardized_products.upc is
  'UPC where the supplier provides one (~8% of rows). Maps to schema.org gtin12.';
comment on column public.standardized_products.origin is
  'Place of origin (~66% of rows).';
comment on column public.standardized_products.certifications_json is
  'Supplier certification list (~15% of rows).';

-- Re-declare the view with the nine columns appended.
--
-- Everything above `description_full` is reproduced verbatim from the live
-- definition (pg_get_viewdef, 2026-08-27, post-taxonomy). CREATE OR REPLACE
-- requires the existing columns keep their exact order, names and types, so
-- this block must not be tidied — appending at the end is the only safe edit.
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
    sp.commerce_classified_at,
    sp.description_full,
    sp.features_full,
    sp.attributes_json,
    sp.assembled_dimensions,
    sp.media_json,
    sp.mpn,
    sp.upc,
    sp.origin,
    sp.certifications_json
   FROM standardized_products sp
     JOIN latest_product_availability la ON la.supplier_product_id = sp.supplier_product_id
  WHERE sp.normalization_status = 'done'::text AND sp.published = true AND sp.inventory_status = 'in_stock'::text AND sp.total_available_qty > 0 AND sp.product_title IS NOT NULL AND sp.primary_image IS NOT NULL AND sp.primary_image <> ''::text AND sp.price > 0::numeric AND sp.selling_price IS NOT NULL AND sp.selling_price > 0::numeric AND la.available IS TRUE AND la.within_grace IS TRUE;
