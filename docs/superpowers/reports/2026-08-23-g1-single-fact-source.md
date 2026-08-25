# G1 单一 BuildEvaluation 事实源门禁报告

日期：2026-08-23
分支：`codex-build-sim-upgrade`

## 变更

- `BuildEvaluation` 现在携带 `power`、`price`、`noise`，功耗显式拆分 primary/secondary PSU 的 DC load、wall load、废热、效率和上下腔室。
- N6 planning profile 提供板卡、CPU、风扇和同步模块的来源标记；缺失字段保持 `unknown`，不使用旧 runtime 的固定价格或功耗结论。
- `boot.ts` 每次渲染只生成一次评估并把快照交给 legacy renderer；runtime 只做渲染、交互状态和投影，不再调用独立 power/FIT/price/acoustic/gpu 结论函数。
- 温度、接线、BOM、价格表、墙上功耗和 FIT 读取同一份快照；未知温度输入不会回填默认数值。
- 增加 fan group count、dual PSU、unknown secondary PSU 和跨层评估一致性测试，以及 `scripts/g1-browser-smoke.mjs`。

## 验证

```text
npm test                                      16 files / 191 tests passed
npm run typecheck                             passed
npm run build                                 passed
npm run test:g1:browser                       passed
node tests/legacy-run-static-tests.js         23 assertions passed
node tests/legacy-run-model-tests.js          24 scenarios / 85 assertions passed
git diff --check                              passed
```

浏览器 smoke 检查关键面板、dual PSU 重算、240 radiator 重算，以及价格表没有 `¥4,500` / `4500×` 旧旁路。

## 风险与 unknown

- 噪音总值仍为结构化 `unknown`，因为当前 catalog 没有风扇 SKU 声学 profile 和机箱实测。
- PSU 线束、效率、未确认 SKU 和冷排共存尺寸继续由 engine findings 标为 warning/unknown；G1 不把它们升级为购买结论。

## 回滚

回滚本阶段单独提交即可；保持 G0 的 feature flags 与审计回滚约定不变。
