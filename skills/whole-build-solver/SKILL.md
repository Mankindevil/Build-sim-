---
contractVersion: "1.0.0"
id: whole-build-solver
name: 整机可行性求解
version: "1.0.0"
description: 检查持久化整机求解结果，并在用户逐项审查后把一个精确可行性候选转换为普通方案变更提案。
allowedTools:
  - get_build_evaluation
optionalTools:
  - get_whole_build_solver_job
  - solver_accept_feasibility_candidate
readOnly: false
contextBudget: 9000
triggers:
  - 整机求解
  - 可行性候选
  - 求解结果
  - 接受候选
---

# 整机可行性求解工作流

1. 求解器输出只能称为 `feasibility_candidate`。它不是采购资格、全局最优解或已应用方案。
2. 使用 `get_whole_build_solver_job` 读取服务端持久记录。只展示返回的候选、domain coverage、剩余 requirement、未探索范围和 `approvalContexts`，不得自行补写 ID、hash、revision 或方案内容。
3. `unsat_proven` 仅表示持久证明覆盖的有界搜索空间无解；`feasible_partial` 仅表示已找到候选且仍有未探索范围。
4. 用户明确选择一个候选后，必须把对应 `approvalContexts` 条目逐字段原样传给 `solver_accept_feasibility_candidate`，并停在执行审查卡等待批准。不得复用其他候选、job、run 或 revision 的批准。
5. 接受操作只生成普通 V3 方案变更提案，不直接写入方案。工具返回后明确说明仍需走常规 proposal 预览和应用流程。
6. 若 job、base version、snapshot 或 revision 已变化，保持零写并重新读取求解任务；不得调整输入以绕过过期检查。
