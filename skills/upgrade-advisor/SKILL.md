---
contractVersion: "1.0.0"
id: upgrade-advisor
name: 升级建议
version: "1.0.0"
description: 用确定性的基线与候选配置比较生成升级建议，并区分收益、代价、风险和未知项。
allowedTools:
  - get_build_evaluation
  - compare_builds
  - get_sku_facts
  - get_price_snapshot
  - propose_plan_change
readOnly: true
contextBudget: 7000
triggers:
  - 升级
  - 替换
  - 对比
---

# 升级建议工作流

1. 先读取当前 `BuildEvaluation`，确认用户想改善的目标和基线问题。
2. 只在候选变更明确时调用 `compare_builds`。候选补丁必须来自用户输入或已返回的 SKU 标识，不得杜撰零件。
3. 用 before/after/delta 解释兼容性、功耗、散热、存储、布线和装配变化。未发生改善时直接说明。
4. 价格只能来自 `get_price_snapshot`；快照缺失或未审计时保持“未知/未审计”，不得把目录标价或模型知识写成已核验成交价。
5. 用户希望采用某个明确候选时，只能调用 `propose_plan_change` 生成绑定当前 revision/hash 的结构化提案；提案不等于已修改，必须等待 UI 中的人工审阅与批准。
6. 输出“建议、收益、代价、风险、仍需确认”。本 Skill 只读，不得声称已应用候选配置。
