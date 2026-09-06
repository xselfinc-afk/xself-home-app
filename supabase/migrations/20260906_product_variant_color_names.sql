-- ─────────────────────────────────────────────────────────────────────────────
-- product_variant_color_names — 人工指定的对外颜色名（NOT YET APPLIED to production）
--
-- 背景（2026-09-06 W1803）：同一型号的两个蓝色变体，供应商 mainColor 都写 "Blue"，
-- MPN 色码却是 -10BLU / -11BLU。planner 已能识别它们是不同变体（color_name_ambiguous），
-- 但对外色名仍然撞车：前台颜色选择器会出现两个 "Blue"。这张表让运营给它们起不同的名字。
--
-- 设计：
--   * 只存人工命名，不碰 supplier_products / raw_payload —— 供应商原始数据零污染；
--   * 消费点三处：scripts/normalizeProducts.ts（Stage 2，写进 standardized_products.color）、
--     scripts/planGigaAutoPublish.ts（候选色名）、XOne 桥接预览；
--   * 撤销 = 置 revoked_at（软删，保留审计），撤销后回退到标题色名 / mainColor；
--   * 表不存在时，所有消费点 fail-open 为「没有人工色名」并打日志，不阻塞任何链路。
--
-- Idempotent: IF NOT EXISTS / guarded policy，可重复执行。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_variant_color_names (
  supplier_product_id text        PRIMARY KEY,
  -- 对外色名。写入前由桥接净化：≤ 40 字符，只允许字母 / 数字 / 空格 / 连字符 / &。
  color_name          text        NOT NULL CHECK (char_length(color_name) BETWEEN 1 AND 40),
  approved_by         text        NOT NULL,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- 非空即已撤销；消费点只读 revoked_at IS NULL 的行。
  revoked_at          timestamptz
);

CREATE INDEX IF NOT EXISTS product_variant_color_names_active_idx
  ON public.product_variant_color_names (supplier_product_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.product_variant_color_names ENABLE ROW LEVEL SECURITY;

-- 只有 service role 读写（脚本与桥接都用 service key）；App 端不直接读这张表，
-- 它读的是 Stage 2 已经写好的 standardized_products.color。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'product_variant_color_names'
      AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON public.product_variant_color_names
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ROLLBACK
-- DROP POLICY IF EXISTS service_role_all ON public.product_variant_color_names;
-- DROP INDEX IF EXISTS public.product_variant_color_names_active_idx;
-- DROP TABLE IF EXISTS public.product_variant_color_names;
