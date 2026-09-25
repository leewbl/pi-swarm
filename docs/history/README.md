# History — Pi Swarm 1.0 初始设计文档

本目录保存 1.0.0-alpha.1 发布时的开发过程文档，仅作历史参考：

| 文件 | 内容 |
| --- | --- |
| `pi-swarm-1.0-prd.md` | 产品需求（FR 编号来源） |
| `pi-swarm-1.0-architecture.md` | 初始架构设计 |
| `pi-swarm-1.0-test-plan.md` | 测试计划 |
| `pi-swarm-1.0-acceptance-report.md` | 验收报告 |

## ⚠️ 已被结构化修复取代

这些文档描述的是 **1.0 初始模型**，与当前代码存在已知偏差（Issue #1 暴露的结构性活性缺陷源于此）。当前实现以 `fix/structural-liveness` 引入的模型为准，主要差异：

- ~~`eligibleRoles` 静态角色门控~~ → `workDomain` + Boundary Gate（Primary / Secondary / Fallback / 显式 UNSERVICEABLE）
- ~~coordinator 从不认领任务~~ → coordinator 为可选角色，可认领 planning/coordination/decision，专家缺席时可回退
- 任务生命周期新增 `blocked`（`blockedOn` 持久义务，完成自动恢复）
- 期望他人行动必须落为持久任务（`swarm_request_create`），事件只做加速，不承载活性
- `availableAt` 持久调度门；direct 事件默认 actionable；liveness watchdog 兜底

现行行为的权威说明见仓库根目录 `README.md`；实现见 `src/domain/topology.ts`、`src/domain/candidate-resolver.ts` 及相关模块的源码注释。
