---
contractVersion: "1.0.0"
id: build-diagnosis
name: 装机诊断
version: "1.0.0"
description: 使用权威装机评估解释阻断、风险和未知项，并保持事实来源与推断边界清晰。
allowedTools:
  - get_build_evaluation
  - get_sku_facts
readOnly: true
contextBudget: 6000
triggers:
  - 诊断
  - 为什么
  - 兼容性
---

# 装机诊断工作流

1. 先调用 `get_build_evaluation`；只把返回的 `BuildEvaluation` 当作兼容性、供电、散热、布线与装配结论的权威来源。
2. 需要解释某个零件的确定性规格时，再调用 `get_sku_facts`。不要用模型记忆补齐缺失字段。
3. 按“阻断问题、风险提示、未知项、可执行下一步”组织回答。保留原始严重级别，不得弱化 bad finding。
4. 如果评估缺少配置或某项仍为 unknown，明确说明缺少什么；不要猜测测量、槽位、接口或兼容性。
5. 本 Skill 只读，不得声称已经修改配置、接受候选、保存结果或完成采购。
