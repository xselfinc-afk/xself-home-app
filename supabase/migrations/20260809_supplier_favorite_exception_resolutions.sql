-- 20260809_supplier_favorite_exception_resolutions.sql
--
-- PURPOSE: 让用户在 XOne 里对「收藏同步异常」做人工裁决，并让下一次同步遵守该裁决。
--
-- WHY A NEW TABLE (既有模型为什么不够):
--   * supplier_favorite_memberships 在 20260801 的合同里写死是 FACTS ONLY —— "No decisions,
--     no business state, no task fields"，且事实刷新是 authoritative 全量覆盖：把人工裁决写进去
--     下一次刷新就会被抹掉。事实与意图必须分开存。
--   * saved_assets 是上架/移除审批状态机（9 个状态 + founder 确认 + verification，跃迁受 CHECK
--     约束）。它表达的是"这个商品该不该继续上架"，不是"同步收藏夹时这一条该怎么办"。没有任何
--     现有状态表示「保留此收藏」，新增一个就等于扩张那台状态机 —— 本轮明确不做。
--
-- SAFETY / SCOPE:
--   * ADDITIVE ONLY。新建 1 张表，不 ALTER 任何既有表，无触发器，无回填，无种子数据。
--   * 绝不写 standardized_products / published / inventory_* / sellable_products。
--   * 这张表只表达"同步收藏夹时怎么处理这一条"，永远不是发布或下架决策。
--   * service-role only（启用 RLS，不授予任何 policy），与既有控制模型一致。
--
-- 语义（由 planning 层强制，不是由本表强制）:
--   keep_favorite   保留收藏 —— 不进入取消流程
--   remove_favorite 允许下次同步取消该收藏，但仍必须通过唯一 website product_id 安全门
--   no_action       已人工确认无需操作，不再作为未处理异常出现，也不发送任何请求
--
-- 关键不变量：published=true 的商品永远保留。人工裁决不能把它变成删除。该规则在 planning 层
-- 实现（见 supplierFavoriteCleanupExecutor.ts::applyManualResolutions），数据库不承担业务判断。

CREATE TABLE IF NOT EXISTS public.supplier_favorite_exception_resolutions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  supplier_product_id text        NOT NULL,
  supplier_account    text        NOT NULL,

  resolution          text        NOT NULL,

  resolved_at         timestamptz NOT NULL DEFAULT now(),
  resolved_by         text        NOT NULL,
  note                text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- 一个账号下一个 SKU 只有一条现行裁决；改主意就是 upsert 覆盖。
  CONSTRAINT sfer_identity_uniq UNIQUE (supplier_product_id, supplier_account),

  -- 账号隔离：同一个 SKU 在两个账号可以有不同裁决，互不影响。
  CONSTRAINT sfer_account_chk CHECK (supplier_account IN ('pickup','dropship')),

  CONSTRAINT sfer_resolution_chk CHECK (resolution IN ('keep_favorite','remove_favorite','no_action')),

  CONSTRAINT sfer_resolved_by_chk CHECK (length(btrim(resolved_by)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_sfer_account_resolution
  ON public.supplier_favorite_exception_resolutions (supplier_account, resolution);

ALTER TABLE public.supplier_favorite_exception_resolutions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.supplier_favorite_exception_resolutions IS
  '收藏同步异常的人工裁决。只影响"同步收藏夹"如何处理该条，绝不影响 published 或库存。';
COMMENT ON COLUMN public.supplier_favorite_exception_resolutions.resolution IS
  'keep_favorite=保留收藏；remove_favorite=允许下次同步取消（仍需唯一 product_id）；no_action=已确认无需操作';
