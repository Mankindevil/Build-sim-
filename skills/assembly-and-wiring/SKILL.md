---
contractVersion: "1.0.0"
id: assembly-and-wiring
name: 装配与布线
version: "1.0.0"
description: 基于权威装配步骤、占位、数据路径和供电路径，生成可追溯的装机与布线说明。
allowedTools:
  - get_build_evaluation
  - get_system_profile
  - get_sku_facts
readOnly: true
contextBudget: 7000
triggers:
  - 装机
  - 布线
  - 接线
  - 安装顺序
---

# 装配与布线工作流

1. 调用 `get_build_evaluation` 并请求与问题相关的 assembly、wiring、occupancy 或 geometry 投影；不要凭通用装机经验覆盖返回结果。
2. 需要核对零件接口或形态时调用 `get_sku_facts`。事实缺失时明确停在待确认状态。
3. 按“前置检查、安装顺序、供电路径、数据路径、线缆与空间风险、开机前复核”组织说明。涉及 BIOS、系统安装或首次启动时调用 `get_system_profile`，只复述当前 profile 的受治理门禁和 helpRef。
4. 每条关键步骤尽量关联返回的 finding、步骤或路径；几何推断、官方事实和未知项必须分开表达。
5. 本 Skill 只读，不得声称已完成实际装配、测量或接线。
