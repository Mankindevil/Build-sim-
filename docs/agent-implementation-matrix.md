# Agent 实现与验证矩阵

更新时间：2026-08-24（Asia/Tokyo）

本文件只把已经落到代码且通过对应门禁的能力列为“已实现”。fixture、计划和接口边界不等于真实第三方 Provider 可用性。

## 阶段交付

| 阶段 | 状态 | 独立提交 | 主要证据 |
|---|---|---|---|
| A0 契约与架构 | 已实现 | `bb88da7f66cd2782548fb8f199257183ea1be199` | Provider/Tool/Skill/事件契约、设计边界、契约测试 |
| A1 权威评估服务 | 已实现 | `104e56498f8fe45434da13041f430dc0f8d456c0` | 服务端重算完整 `BuildEvaluation`、浏览器/服务端 hash 一致 |
| A2 DeepSeek Runtime | 已实现（fixture） | `a805d669052f14d54775f2d28ba3c08b9e244902` | Provider-neutral 多轮会话、DeepSeek SSE、usage、取消、超时、持久化 |
| A3 只读 Tools | 已实现 | `940507ce961ca79cc5cb3f952954b9c3e2a986d4` | 7 个 Tool、严格 schema、受限循环、固定本地 external-read 服务 |
| A4 Skills | 已实现 | `b6a9f3fef52db87394a1d3b9685f98c91566b0b0` | 4 个 Skill、元数据目录、按需正文、definition hash、`allowedTools` 双重限制 |
| A5 聊天 UI | 已实现（fixture E2E） | `6f4b022db60768d62065d9a94e27828cce9a3f13` | 模型/Skill 选择、当前配置、多轮/SSE/Tool/usage/取消、桌面与 390px 浏览器 QA |
| A6 审计与审批边界 | 已实现 | `d035e895f289ce3304007e015086dcbed2a99997` | `0600` 原子审计、内容 hash、脱敏、完整性校验、只读审计接口、写 Tool 硬禁用 |
| A7 Claude 与最终交付 | 已实现（fixture） | 本文件所在最终阶段提交 | Claude Messages SSE/Tool/usage 适配、Provider 专属预算、最终回归与边界说明 |
| C0-C6 官网发现与治理补齐 | 已实现 | `25cbaa6`…`e7124a7` | Registry、provider-neutral discovery、SearXNG fixture、动态页安全、proposal、可回滚补齐、Agent approval |
| C7 完整交付门禁 | 已实现（live 边界见下） | 本文件所在最终阶段提交 | 全量/legacy/browser/secret/diff 门禁、4 类官网只读样本、执行报告 |

## 当前能力

| 能力 | 已实现 | 当前限制 |
|---|---|---|
| DeepSeek API 多轮聊天 | 是 | 代码和本地协议 fixture 已验证；本次交付未使用真实 key 发起 live 请求 |
| Claude API 适配 | 是，显式启用后注册 | 只完成官方协议映射与 fixture 测试；未做 live Claude 请求 |
| Provider 扩展 | 是 | 新 Provider 必须实现同一个 `ProviderAdapter`，不得把 wire format 泄漏进 Runtime/UI |
| 权威装机事实 | 是 | 仅服务端 `BuildEvaluation` 可给出确定性结论；模型不能覆盖 bad/unknown |
| read/external-read Tool | 是，8 个 | 4 个 external-read Tool 要求本机 Price/Catalog 服务运行；SearXNG 可选且本机 live 未验证 |
| Skill | 是，4 个 | 当前按用户选择激活一个 Skill；未做模型自动路由 |
| 流式 UI | 是 | Agent 服务不可用时聊天禁用，确定性模拟器继续工作 |
| 会话持久化 | 是 | 会话为恢复聊天而保存正文；只在本地 Git-ignore 目录，权限 `0600` |
| 运行审计 | 是 | 审计只保存 hash/usage/ids/终态，不保存 prompt 和原始 Tool/模型正文 |
| 写 Tool | 是，1 个 | 仅 `enrich_official_catalog`；candidate id + expected hash；必须精确审批，且仍受 catalog policy/backup/rollback 约束 |
| 自动采购/修改配置 | 否 | 没有下单、接受候选、记录价格或修改配置的 Agent 写入口 |
| 自动信任新域名 | 否 | 只能生成/列出 proposal；expected-hash 人工治理后才能更新 registry |
| trusted exact-MPN 自动补齐 | 是，默认关闭 | draft 与正式写入由独立服务端 flags 控制；正式 catalog 在本次验收中写入 0 |

## Provider 注册与密钥边界

- DeepSeek：`BUILD_SIM_AGENT_ENABLED=true`、`DEEPSEEK_ENABLED=true`、`DEEPSEEK_API_KEY`。
- Claude：额外设置 `CLAUDE_ENABLED=true`、`CLAUDE_API_KEY`；否则 Claude adapter 不进入 Runtime 模型目录。
- 两者的 URL、模型、超时、token 上限和温度均为服务端环境变量；禁止 `VITE_` 前缀。
- Provider key 不进入会话、运行事件、审计、浏览器 bundle 或错误正文。

## Claude 协议依据

A7 于 2026-08-24 核对 Anthropic 官方文档：Messages stream 按 `message_start`、content block start/delta/stop、`message_delta`、`message_stop` 流动；文本使用 `text_delta`，Tool 参数使用增量 `input_json_delta`，客户端 Tool 用 `tool_use`/`tool_result` 内容块。实现固定发送 `anthropic-version: 2023-06-01`，但正式启用前仍应重新核对官方兼容性。

- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- https://platform.claude.com/docs/en/api/messages

## 完成门禁

2026-08-24 的 A7 提交前结果：

- Agent 聚焦测试：9 个文件、40 项通过。
- 完整 Vitest：32 个文件、279 项通过。
- TypeScript、浏览器生产构建、Agent SSR 构建通过。
- legacy model：24 个场景、85 个断言通过，其中 P0 12 项；legacy static：23 个断言通过。
- `git diff --check` 通过；密钥扫描 201 个受控/未跟踪交付文件，0 findings。
- 真实本地浏览器 fixture E2E：页面同时发现 DeepSeek 与 Claude，切换 Claude 后完成 Skill 激活、`get_build_evaluation`、流式文本、usage、持久化审计 hash；控制台 0 error。fixture 文案明确声明不代表 live Provider。
- 浏览器生成的单个 session/audit 测试文件已按精确路径清理，未删除其他本地数据。
- A7 独立提交、推送和远端 SHA 一致性仍以最终交付回复为准。

2026-08-24 的 C7 提交前结果：

- 完整 Vitest：42 个文件、315 项通过；其中 C7 单测证明 exact-MPN discovery/inspect/enrich/`BuildEvaluation`/rollback 闭环。
- TypeScript、浏览器 production build、Agent SSR build、legacy model 85 assertions、legacy static 23 assertions 通过。
- G1、G7 和 governed catalog Agent 三个真实 Chromium smoke 通过；catalog smoke 使用明确标记的本地事件 fixture，不代表 live Provider/SearXNG。
- 真实只读样本覆盖 Thermalright 静态页、ASUS 动态页、Seagate 文本 PDF、Intel 日本地区域名；四者当次均 HTTP 200，但字段结果均为 `partial`，正式 catalog 写入 0。
- 本机 SearXNG 连接失败；live DeepSeek/Claude、验证码/登录墙、扫描 PDF 和 Crawl4AI 未验证。
- secret scan 0 findings、`git diff --check` 通过；C0-C7 本地完成，未获 push 授权。
