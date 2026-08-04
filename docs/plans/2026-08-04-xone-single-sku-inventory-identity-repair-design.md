# XOne 单商品库存身份修复设计

## 范围

仅修复 `XH-GH-HM-86617W` 的 XOne 定向库存复核。不会扫描其他商品、改变调度、创建新身份平台或修改通用商品发布流程。

## 根因

现有 XOne bridge 直接把 `standardized_products.supplier_product_id`（`N707P186617W`）传给通用 availability scanner。scanner 使用继承的默认供应商账号调用 `price/v1`，该组合返回 `code=0`，最终只暴露为模糊的 `api_failed`。

## 身份解析

新增纯函数 `resolveInventoryLookupIdentity`：

1. 接收 XSelf SKU、旧 `supplier_product_id` 与 `supplier_products.raw_payload.associateProductList`。
2. 从真实关联列表中选择与旧变体唯一对应的已验证 S 型关联身份。
3. 返回 XSelf SKU、lookup identity、来源、置信度与旧 supplier product id。
4. 无唯一结果时返回 `identity_mapping_error`；绝不回退到 P 码或 XSelf SKU。

本案例预期：

- `xself_sku=XH-GH-HM-86617W`
- `lookup_identity=N707S186617W`
- `source=supplier_products.raw_payload.associateProductList`
- `legacy_supplier_product_id=N707P186617W`

## 显式账号读取

增加固定、只读、账号隔离的供应商读取器：

- Pickup：`.env.giga-alt.local`
- Dropship：`.env.giga-delivery.local`

读取器只允许 Favorites、商品详情、价格/可售和库存数量四类既有 GET 接口。它不接受任意 URL、脚本路径或账号参数，不记录凭据。

两边均使用解析出的 lookup identity。任一网络、鉴权、数据结构或商品不存在错误都返回明确错误，不能解释为缺货。

## 定向复核与恢复

XOne bridge 的单 SKU 入口执行：

1. 仅按 XSelf SKU 读取标准商品。
2. 从生产供应商关系解析 lookup identity。
3. 核验 Pickup 与 Dropship Favorites。
4. 两账号分别读取详情、价格/可售和库存。
5. 所有读取门禁成功后才开始生产写入。
6. 使用现有 availability persistence、inventory state machine 与 confirmation interval 记录 `confirmed_in_stock`，清零当前错误 strike；历史扫描证据不删除。
7. 恢复原因记录为 `corrected_lookup_identity`。
8. 复用现有 restore gate；若商品本来已发布，则不重复执行 publication 写入。
9. 回读验证 standardized product、availability current、workflow state 与 `sellable_products`。

## XOne 展示

主卡继续显示 XSelf SKU。技术详情附加：四类 lookup identity、旧 P 码、website search 尚未验证、两个 Favorites 状态、账号读取结果、检查时间和来源。所有结果继续绑定原 XSelf SKU。

## 安全与验证

- 只允许目标 XSelf SKU；其他 SKU 直接拒绝。
- 读取完成前 `production_write_attempted=false`。
- 供应商 API 失败不写 availability、不改变 strike。
- 不修改其他 38 件商品。
- 单元测试覆盖身份解析、无回退、账号隔离、错误分类、状态恢复与 XOne 显示。
- 最后仅执行一次真实目标 SKU 复核，并进行前后快照与回读核对。

