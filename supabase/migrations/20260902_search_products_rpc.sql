-- ─────────────────────────────────────────────────────────────────────────────
-- search_products RPC — server-side product search (text + SKU + image keywords).
--
-- Replaces the client-side "download the whole sellable_products view and
-- filter in memory" search. One RPC serves Home Search, Discover's search
-- state, and the image-keyword path. Discover's no-query browse state is NOT
-- part of this (it keeps its own catalogue load).
--
-- Recall boundary (fixed, public, deterministic):
--   normalization_status = 'done'
--   AND selling_price > 0
--   AND primary_image present
--   AND ( published = true
--         OR (published = false AND delist_reason = 'inventory_unavailable') )
--   Products delisted via 'manual' or 'quality_gate', and never-published
--   products, are NEVER searchable — by SKU or otherwise.
--
-- Availability: is_available = EXISTS in sellable_products. Unavailable rows
-- (inventory-delisted) stay searchable but their score is multiplied by 0.85
-- and the UI labels them; a full exact-SKU hit still outranks every name
-- match even after the penalty (1000×0.85 = 850 > max name score).
--
-- Ranking (deterministic; ties broken by supplier_product_id):
--   1000  SKU exact      (sku_search = norm OR supplier_product_id = norm)
--    900  SKU prefix     (norm length ≥ 3)
--    800  SKU partial    (norm length ≥ 3)
--    400 + 40·avg_sim    title: ALL query tokens hit (word_similarity ≥ 0.35,
--                        tokens < 3 chars fall back to ILIKE substring)
--    200·hit_ratio + 40·avg_sim   title: some tokens hit
--    + 20·similarity(query, title) as an in-tier tie-break component
--
-- pg_trgm is used for word_similarity()/similarity() (typo + word-order
-- tolerance). At the current ~400-row catalogue the planner will seq-scan —
-- that is expected and fine; the GIN index below is growth insurance, not a
-- present-day performance claim.
--
-- Security: SECURITY DEFINER with pinned search_path; no dynamic SQL; query
-- length capped at 100 chars; limit capped at 100, offset at 1000; returns
-- only the canonical LIST_SELECT public columns (+ is_available/score/count);
-- EXECUTE granted to anon + authenticated only.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- SKU exact/prefix hot path (semantic correctness; tiny table today).
CREATE INDEX IF NOT EXISTS standardized_products_sku_search_idx
  ON public.standardized_products (sku_search);

-- Growth insurance for title trigram matching (unused by the planner at
-- current row counts — do not treat "index used" as an acceptance criterion).
CREATE INDEX IF NOT EXISTS standardized_products_title_trgm_idx
  ON public.standardized_products USING gin (product_title gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.search_products(
  p_query  text,
  p_limit  integer DEFAULT 30,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id                         uuid,
  supplier_product_id        text,
  product_title              text,
  product_title_display      text,
  optimized_title            text,
  specifications_json        jsonb,
  sku_custom                 text,
  sku_search                 text,
  category_code              text,
  color                      text,
  material                   text,
  primary_image              text,
  primary_image_blurhash     text,
  primary_image_w            integer,
  primary_image_h            integer,
  primary_image_aspect       numeric,
  primary_image_mirror_path  text,
  product_family_key         text,
  price                      numeric,
  selling_price              numeric,
  original_price             numeric,
  normalization_status       text,
  created_at                 timestamptz,
  category_label             text,
  category_priority          integer,
  is_new_arrival             boolean,
  new_arrival_source         text,
  total_available_qty        integer,
  commerce_department        text,
  commerce_category          text,
  commerce_product_type      text,
  commerce_rooms             text[],
  is_available               boolean,
  score                      numeric,
  total_count                bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH params AS (
  SELECT
    left(btrim(coalesce(p_query, '')), 100)                                   AS q,
    upper(regexp_replace(left(btrim(coalesce(p_query, '')), 100),
                         '[^a-zA-Z0-9]', '', 'g'))                            AS qnorm,
    least(greatest(coalesce(p_limit, 30), 1), 100)                            AS lim,
    least(greatest(coalesce(p_offset, 0), 0), 1000)                           AS off
),
tokens AS (
  SELECT t.tok
  FROM params,
       LATERAL unnest(regexp_split_to_array(lower(params.q), '\s+')) AS t(tok)
  WHERE length(t.tok) > 0
),
tokstats AS (
  SELECT count(*)::int AS n_tokens FROM tokens
),
base AS (
  SELECT sp.*
  FROM standardized_products sp
  WHERE sp.normalization_status = 'done'
    AND coalesce(sp.selling_price, 0) > 0
    AND coalesce(sp.primary_image, '') <> ''
    AND ( sp.published = true
          OR (sp.published = false AND sp.delist_reason = 'inventory_unavailable') )
),
scored AS (
  SELECT
    b.*,
    EXISTS (
      SELECT 1 FROM sellable_products v
      WHERE v.supplier_product_id = b.supplier_product_id
    ) AS avail,
    -- SKU tier score
    (SELECT CASE
       WHEN params.qnorm = '' THEN 0
       WHEN coalesce(b.sku_search, '') = params.qnorm
         OR upper(regexp_replace(b.supplier_product_id, '[^a-zA-Z0-9]', '', 'g')) = params.qnorm
         THEN 1000
       WHEN length(params.qnorm) >= 3
         AND coalesce(b.sku_search, '') LIKE params.qnorm || '%'
         THEN 900
       WHEN length(params.qnorm) >= 3
         AND coalesce(b.sku_search, '') LIKE '%' || params.qnorm || '%'
         THEN 800
       ELSE 0
     END FROM params) AS sku_score,
    -- Title token stats (word_similarity for tokens ≥3 chars, ILIKE for shorter)
    ts.hits,
    ts.avg_sim
  FROM base b
  CROSS JOIN LATERAL (
    SELECT
      count(*) FILTER (
        WHERE (length(t.tok) >= 3 AND word_similarity(t.tok, lower(b.product_title)) >= 0.35)
           OR (length(t.tok) <  3 AND lower(b.product_title) LIKE '%' || t.tok || '%')
      )::int AS hits,
      coalesce(avg(word_similarity(t.tok, lower(b.product_title))) FILTER (
        WHERE length(t.tok) >= 3
          AND word_similarity(t.tok, lower(b.product_title)) >= 0.35
      ), 0) AS avg_sim
    FROM tokens t
  ) ts
),
ranked AS (
  SELECT
    s.*,
    (
      greatest(
        s.sku_score,
        CASE
          WHEN (SELECT n_tokens FROM tokstats) = 0 THEN 0
          WHEN s.hits = (SELECT n_tokens FROM tokstats) AND s.hits > 0
            THEN 400 + 40 * s.avg_sim
          WHEN s.hits > 0
            THEN 200 * (s.hits::numeric / (SELECT n_tokens FROM tokstats)) + 40 * s.avg_sim
          ELSE 0
        END
      )
      + 20 * similarity((SELECT lower(q) FROM params), lower(s.product_title))
    ) * (CASE WHEN s.avail THEN 1.0 ELSE 0.85 END) AS final_score
  FROM scored s
)
SELECT
  r.id,
  r.supplier_product_id,
  r.product_title,
  r.product_title_display,
  r.optimized_title,
  r.specifications_json,
  r.sku_custom,
  r.sku_search,
  r.category_code,
  r.color,
  r.material,
  r.primary_image,
  r.primary_image_blurhash,
  r.primary_image_w,
  r.primary_image_h,
  r.primary_image_aspect,
  r.primary_image_mirror_path,
  r.product_family_key,
  r.price,
  r.selling_price,
  r.original_price,
  r.normalization_status,
  r.created_at,
  r.category_label,
  r.category_priority,
  r.is_new_arrival,
  r.new_arrival_source,
  r.total_available_qty,
  r.commerce_department,
  r.commerce_category,
  r.commerce_product_type,
  r.commerce_rooms,
  r.avail        AS is_available,
  r.final_score  AS score,
  count(*) OVER () AS total_count
FROM ranked r
WHERE r.final_score > 0
  AND (SELECT q FROM params) <> ''
ORDER BY r.final_score DESC, r.supplier_product_id ASC
LIMIT  (SELECT lim FROM params)
OFFSET (SELECT off FROM params);
$$;

REVOKE ALL ON FUNCTION public.search_products(text, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.search_products(text, integer, integer)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.search_products(text, integer, integer) IS
  'Unified product search (text/SKU/image-keywords). Fixed public recall '
  'boundary: done + priced + imaged + (published OR inventory-delisted). '
  'manual/quality_gate delists are never searchable. Deterministic ranking: '
  'SKU exact 1000 > prefix 900 > partial 800 > all-token title 400+ > partial '
  'title 200+; unavailable rows ×0.85 and flagged is_available=false.';
