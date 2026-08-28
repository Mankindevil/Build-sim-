---
contractVersion: "1.0.0"
id: plan-initializer
name: 渐进式装机档案
version: "2.0.0"
description: 从真空白档案开始，每轮只记录用户明确表达的需求、角色或硬件节点，并生成可逐项人工批准的增量提案。
allowedTools:
  - search_catalog_skus
  - get_sku_facts
  - get_price_snapshot
  - compare_builds
  - get_build_evaluation
  - search_official_catalog
  - get_catalog_search_job
  - inspect_catalog_candidate
  - propose_catalog_review
  - search_price_candidates
  - propose_plan_change
readOnly: true
contextBudget: 10000
triggers:
  - 初始化
  - 新方案
  - 配一台
  - 游戏主机
---

# 渐进式装机档案工作流

1. 当前档案可能完全空白，也可能只有需求或少量部件。空白不是错误，不含隐藏 N6、Windows、GPU none、980 PRO、HBA、线材、pool、BIOS 或附件默认值。
2. 每轮只提取用户本轮明确表达的内容。可以只记录用途、预算、噪音、体积、容量、吞吐或周期，也可以只加入一个 unresolved 硬件节点；不得为了“完整”补造其余部件。
3. 未回答的信息保持缺失，用户明确暂不回答时记录 deferred，明确不需要某个角色时才提议 `RoleDecision(not_needed)`。Agent 不能自行写入 `source:user`、`confirmedByUser:true`、`confirmedAt` 或 `lockedByUser:true`。
4. 每轮最多提出三个会实质改变方案的高价值问题。已经保存的前轮节点和需求必须保留；只能通过 stable selector 增量 add/replace/remove，不能提交数组索引，也不能整份覆盖未在本轮讨论的集合。
5. 型号未确认时保存 unresolved identity，保留用户原话和候选 ID。只有 `search_catalog_skus` 返回的正式精确 SKU ID 才可作为 resolved identity；模型记忆、网页标题、搜索 snippet 或 catalog candidate ID 均不可直接写入。
6. 官网搜索只用于核验候选身份和缺失字段。`same-family`、`conflict`、`insufficient-evidence` 或未治理域名继续保持 unresolved；目录补充必须走独立人审流程。
7. `get_build_evaluation` 对 V3 可能只返回 topology projection 和明确 unknown。不得把缺少通用 evaluator 的 partial 状态描述成兼容、安全、供电、空间、散热或采购 pass；也不得调用 V2/N6 比较来代替。
8. 价格优先使用带日期与审计状态的 `get_price_snapshot`。价格候选不是确认价格，未知预算不得被自然语言弱化。
9. 调用 `propose_plan_change` 时，V3 必须使用 `{collection,id,parentId?,field?}` stable selector。提案只包含本轮明确识别的操作，并逐项给出理由；用户可以只批准其中一部分。
10. Tool 只生成非写入提案。只有 UI 中的明确人工批准才可修改草稿；需求确认必须列出本次审核的稳定字段 ID，普通提案批准不能顺带把既有 Agent/defaulted 需求升级为用户权威。
