# 新品首次上架主链 —— 封版

**状态：已封版（2026-08-09）。这条链已经真实跑通，不要重新设计它。**

想改这条链之前，先读完本文。它记录的不是设想，是一次真实成功执行的形状，以及三次翻车换来的约束。

---

## 1. 封版基线

2026-08-09 01:24–01:26，三件仅收藏在 Pickup 的全新商品，**一次点击**走完全链：

| SKU | published | 售价 | 库存 | 证据 | sellable | Dropship 收藏 | Delivery Fee |
|---|---|---|---|---|---|---|---|
| W5977P521301 | ✅ | $129 | in_stock 50 | 有效 | ✅ | verified_added (1504790) | **$17.00** |
| W5977P521316 | ✅ | $129 | in_stock 50 | 有效 | ✅ | verified_added (1504829) | **$17.00** |
| W5977P521302 | ✅ | $129 | in_stock 50 | 有效 | ✅ | verified_added (1504792) | **$17.00** |

结果 `verified_visible: 3, published_but_not_sellable: 0, pipeline_failed: 0`。
运费来源 `giga_openapi_price_v1`、账号 `dropship_82482447`，供应商履约费 $14.87 + 8% buffer。
每件 5 条冷启动评价。执行前这三件在 Dropship 一条记录都没有。

**链路形状：**

```
Pickup 收藏
  → 检查新收藏（实时读 Pickup → 筛候选 → 导入草稿 published=false）
  → 最终预览（既有 planner 出 proposed_batch）
  → 批量上架（runGigaAutoPublish 八阶段）
      → 读取库存证据    scanPublishedAvailability --skus=<本批> --live
      → 加入 Dropship 收藏  syncSupplierFavoritesToPublished --add --account=dropship --skus=<本批>
      → 获取配送费用    refreshGigaDeliveryFeesHybrid --skus=<本批>
      → 回读事实        readProgressFacts + deriveRecoveryState
  → 已上架 · App 可见 · Checkout 可报价
```

---

## 2. 锁定的不变量

改动触碰到下面任何一条，先停下来问人。每条后面都是它当初是怎么被违反的。

### 2.1 收尾四步的顺序是依赖，不是风格

证据必须在发布之后（否则扫不到刚发布的商品）；**收藏必须在运费之前**（否则 `price/v1`
必然 B20003）；回读事实必须在最后（否则读到收尾前的旧状态）。

> 翻车史：批量上架跑完就直接回读 sellable，那时证据还没生成，于是每次都停在
> 「已发布 · App 暂不可见」，用户被迫再点一次「继续完成」。

### 2.2 范围只能收窄，不能放大

- 预览按 `request.skus` 收窄候选；
- 批量上架只执行快照里的 `proposed_batch.skus`，数量对不上直接 `PLAN_CHANGED` 拒绝；
- **收藏新增永远走显式名单**（`planFavoriteAdditions(account, skus, …)`），
  它没有能力从 TARGET 推导 —— TARGET − Dropship 收藏当前是 322 件历史欠账。

### 2.3 Delivery Fee 只能取 Dropship 账号的值

同一个 SKU，Dropship 账号返回 27.16，Pickup 账号返回 3.68（自提履约费）。差七倍。
拿错账号会严重少收。详见 [GIGA_OPEN_API_REFERENCE.md](./GIGA_OPEN_API_REFERENCE.md)。

`product/price/v1` 只返回**该账号 Saved Items 里**的商品，否则 B20003
（Error Description: *The SKU is not added to Saved Items List*）——
这正是自动补 Dropship 收藏存在的唯一理由。

> 翻车史：B20003 的标题写着 "Account or service permission invalid"，据此误判成
> 账号权限过期，绕了一整轮。真正的诊断在 Error Description 那一列。

### 2.4 收藏写入的安全门不得放宽

`SUPPLIER_FAVORITE_REMOVAL_ENABLED=true` **且** `--execute`，两者缺一不发请求。
默认关闭，且**不得写进任何 .env 文件** —— 真实执行时以命令前缀临时开启，用完即失效。

其余同删除方向：单件发送（批量参数直接拒绝）、身份反查一致才发、逐件断点、
已验证的绝不重发、**HTTP 200 不算成功**（必须回读官方收藏确认状态才记 `verified_added`）。

### 2.5 收尾失败不得推翻已上架

补收藏或运费失败都是**软失败**：商品仍然「App 可见」，只标注
「App 可见，但 Checkout 暂无法报价：<真实原因>」，落到「需要处理」。
原因取自运费脚本自己写下的 `last_error_code`，不猜。

### 2.6 Terminal Golden Path 不可改

13 个文件按 sha256 冻结，`test:golden-path-freeze` 守着 CLI 契约。
`npm run giga:saved-to-live:plan` / `:apply` 必须始终能独立跑通，作为保底方案。
XOne 只能**新增薄层**调用它们，不得反向依赖。

### 2.7 事实读不出来必须报错

任何 `.select()` 失败一律抛 `READ_FAILED`，不得静默当成「未发布」「没库存」「不满足条件」。

> 翻车史：`loadFacts` 里写了一个不存在的列，PostgREST 拒绝整条查询、错误没人看，
> 于是每件商品都被读成「未发布」，已上线的商品重新回到待上新。
> `npm run verify:xone-bridge-schema` 现在会把每条 select 拿去问一次真实 schema。

---

## 3. 回归测试在哪

| 套件 | 守什么 |
|---|---|
| `test:inventory-operations` | 封版基线（收尾四步顺序、范围只收窄）、口径一致性、原因文案齐全 |
| `test:supplier-wishlist-protocol` | 收藏新增方向：显式名单、身份门、addProductsToWish、`verified_added`、断点幂等、关闸只出计划 |
| `npx tsx src/__tests__/commerceTaxonomyExpansion.test.ts` | Home Décor / Indoor Décor 类目，以及既有分类零回归（这一套没有 npm 脚本，直接跑文件） |
| `test:onboarding-recovery` | 上架未完成的判定与续跑，运费缺失属于未完成 |
| `test:golden-path-freeze` | Terminal 链的 CLI 契约与独立性 |
| `verify:xone-bridge-schema` | 桥接里每条 select 的列名对不对（单测抓不到，只有数据库说了算） |

---

## 4. 已知的、不要顺手去修的

1. **续跑清单的取数范围**绑在 `xone-onboarding-plan.json`，而它每次预览都会被覆盖 ——
   历史半成品会从「上架未完成」里消失。按事实取数会扫进 48+33 件，需要单独设计，不要草率改。
2. **`category_label` 仍是遗留标签**（花瓶显示为 Other），与 commerce taxonomy 的
   `vases-vessels` 不一致。它在 `normalizationPipeline.ts`，属 Golden Path 冻结文件。
3. **`.env.local` 里的 OpenAPI 凭据已失效**（400004 Invalid sign），当前生效的是
   `.env.giga-alt.local`（Pickup）与 `.env.giga-delivery.local`（Dropship）。
4. **`package.json` 的 `test:manual-product-command`** 指向一个从未存在的文件，跑必失败。
5. **门户兜底拿不到 product_id**：`pickProductId` 不查 `supplier_portal_product_mappings`。
   官方接口通的时候用不上它，但这是个真实接线缺口。
