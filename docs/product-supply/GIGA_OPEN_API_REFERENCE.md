# GIGA Open API 2.0 — 买家侧接口参考

来源：<https://www.gigab2b.com/index.php?route=information/open_api/index&doc_id=5&api_lang=en-gb>
本文写于 2026-08-08，基于当日文档与**真实只读调用**的返回。签名与调用方式见
`src/services/gigaApiClient.ts` 与 `scripts/refreshGigaDeliveryFeesHybrid.ts` 的 `signOfficial`。

写这份文档的原因：运费问题被反复误诊过两次。第一次以为是账号权限过期，第二次以为是
缺 product mapping —— 真正的答案写在官方错误码表里，只是没人查过。

---

## 1. 接口目录（买家侧）

Base：`https://openapi.gigab2b.com`　全部为 POST，签名走 `client-id / timestamp / nonce / sign` 请求头。

| 模块 | 接口 | 路径 | 用途 | 读/写 |
|---|---|---|---|---|
| Product | Product List Query | `/b2b-overseas-api/v1/buyer/product/skus/v1` | 商品列表 | 读 |
| Product | Product Details Query | `/b2b-overseas-api/v1/buyer/product/detailInfo/v1` | 商品详情 | 读 |
| **Product** | **Product Price Query** | `/b2b-overseas-api/v1/buyer/product/price/v1` | **售价 + 履约费（运费）** | 读 |
| Inventory | Inventory Query | `/b2b-overseas-api/v1/buyer/inventory/quantity/v2` | 可用库存、备货库存、仓储费 | 读 |
| Shipping | Shipping Info Query | `/b2b-overseas-api/v1/buyer/order/track-no/v1` | **已发货订单的运单号与承运商** | 读 |
| Warehouse | Warehouse Address Query | `/b2b-overseas-api/v1/buyer/warehouse/query-address/v1` | 仓库地址 | 读 |
| Shipment | Order Status Query | `/b2b-overseas-api/v1/buyer/order/status/v1` | 按 Shipment ID 查订单状态 | 读 |
| Shipment | Sync Drop Shipping Orders | `/b2b-overseas-api/v1/buyer/order/dropShip-sync/v1` | 创建一件代发订单 | **写 · 禁止调用** |
| Shipment | Sync Self-arranged Shipping Orders（两个变体） | `…/order/…` | 创建自寄订单 | **写 · 禁止调用** |

**关键结论：Shipping 模块不是报价接口。** `Shipping Info Query` 返回的是**发货之后**的
运单号、承运商、发货仓，输入是 orderNo。它无法在 Checkout 之前给出运费。
整套 Open API 里**没有**「按地址询价」的 rate-quote 接口 —— 运费只能来自 Product Price Query。

---

## 2. Delivery Fee 的权威来源：`product/price/v1`

我们现在用的就是这个接口，**接口本身没有用错**。它的费用字段：

| 字段 | 含义 |
|---|---|
| `shippingFee` | 标准区域的 **Fulfillment Fee，含运输与包装费** ← Checkout 要的就是它 |
| `remoteShippingFee` | 偏远地区履约费 |
| `shippingFeeRange.minAmount / maxAmount` | 履约费区间。含 LTL、Amazon 优惠运费或偏远附加费时 min≠max |
| `internationalFulfillmentFees[]` | 跨国履约费（UK/DE 泛欧） |
| `price` / `exclusivePrice` / `discountedPrice` | 采购价三档 |

---

## 3. 访问范围：只能查「该账号 Saved Items 里的商品」

文档在 Product List / Details / Price 三处都写了同一句：

> Only the products in Buyer's **Saved Items List** or products with stockpiled inventory can be accessed.

Price 接口的更新日志（2026-01-08）：「Query is restricted to the products in Buyer's Saved Items List
or products with stockpiled inventory.」

### B20003 到底是什么

官方错误码表对 `product/price/v1` 的定义：

> **B20003** — Invalid business access: Account or service permission invalid/Region restriction
> **Error Description: Request failed. The SKU is not added to Saved Items List or has no stockpiled inventory.**

**它主要是「这个 SKU 不在该账号的收藏夹里」，不是账号权限到期。** 错误标题里的
"Account or service permission invalid" 具有误导性，真正的诊断在 Error Description 一列。

### 批量语义：一件不合格会拖垮整批

实测：`{"skus":["W2530P521402","W5870P523983"]}` 整批返回 B20003；而单独查
`W2530P521401` 正常返回。**只要批次里有一个 SKU 不在收藏夹，整批都拿不到价格。**
按 SKU 拆分或先过滤才安全。

---

## 4. 账号差异（2026-08-08 实测）

仓库里有三套 OpenAPI 凭据，分属不同用途：

| 凭据 | 来源文件 | 用途 | 实测结果 |
|---|---|---|---|
| `35db…` | `.env.giga-delivery.local` | **Dropship / 一件代发**（`SUPPLIER_DELIVERY_ACCOUNT=dropship_82482447`） | 收藏内商品正常返回 |
| `b746…` | `.env.giga-alt.local` | Pickup / 自提（库存扫描用） | 收藏内商品正常返回 |
| `8ebf…` | `.env.local` | 遗留默认 | **400004 Invalid sign（凭据已失效）** |

### 同一个 SKU，两个账号返回的 shippingFee 完全不同

| SKU | Dropship 账号 | Pickup 账号 |
|---|---|---|
| W2530P521401 | **27.16**（区间 25.53–27.16） | 3.68 |
| W2530P521400 | **27.16** | 3.68 |
| W5870P523986 | **24.14**（区间 22.52–24.14） | 3.15 |

Pickup 账号返回的是**自提模式**的履约费（只含打包/操作，货由你自己去仓库取）。
把它当成 Checkout 运费会严重少收 —— 27.16 与 3.68 差 7 倍以上。

**因此：Checkout 的 Delivery Fee 必须取 Dropship 账号的 `shippingFee`。**
`refreshGigaDeliveryFeesHybrid.ts` 用 `SUPPLIER_DELIVERY_*` 凭据是**正确的设计**。

---

## 5. 运营含义

一件商品要能在 Xself Checkout 报出运费，必须**同时**满足：

1. 在 **Pickup 账号**收藏 → 进入上架流水线（候选发现、库存证据都走这个账号）；
2. 在 **Dropship 账号**收藏 → `price/v1` 才会为它返回 `shippingFee`。

只收藏 Pickup 的商品，上架、库存、App 可见都正常，唯独 Checkout 报不出运费。
这不是 bug，是 GIGA 的账号数据边界。

---

## 6. 门户兜底的定位

`scripts/refreshGigaDeliveryFees.ts` 的门户路径
（`www.gigab2b.com/index.php?route=/product/info/price/list&product_id=…`，解析
`data.fulfillment_options.drop_ship`）与官方接口取的是同一笔费用，但：

- 需要 portal 数字 `product_id`，而 `pickProductId` 只从 CLI、手工 CSV、或运费缓存自己那一行取，
  **不查 `supplier_portal_product_mappings`**（那张表有 1803 行，id 空间与缓存一致：
  62 件两处都有 id 的商品里 61 件完全相同）；
- 依赖 Playwright 会话，会过期、会遇到验证码。

官方接口在商品已收藏到 Dropship 时更稳定、无会话依赖、可批量。**门户应退居兜底。**

---

## 7. 禁止调用

`Sync Drop Shipping Orders` 与两个 `Sync Self-arranged Shipping Orders` 会**真实创建订单/运单**，
产生费用与生产副作用。任何排查都不得调用它们。查运费只需要 `product/price/v1`。
