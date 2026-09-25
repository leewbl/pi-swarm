# Pi Swarm 1.0 — 终极验收报告（Acceptance Report）

- 验收人：测试专家（独立于开发）
- 日期：2026-09-12
- 被验收物：`~/aiworld/pi-swarm`（pi-swarm@1.0.0-alpha.1，提交状态：工作区）
- 依据：`pi-swarm-1.0-prd.md`、`pi-swarm-1.0-architecture.md`、`pi-swarm-1.0-test-plan.md`（§6 DoD）
- 环境：macOS 24.6.0 / arm64 / Node v24.15.0 / omp v18.1.10

---

## 1. 总裁定

| 门禁 | 裁定 | 说明 |
|---|---|---|
| G0 单元 | ✅ 通过 | 全绿 |
> **2026-09-12 复检更新（用户交互测试触发 + PTY 实证）**：原"附条件通过"中待交互确认的命令面经真实 TUI 验证 **失败**，发现两项宿主契约漂移缺陷 D-5（P0 阻断）/D-6（P1）。**总裁定改为：不通过（发布阻断）**，详见 §7 与 §11。

---

## 2. 步骤 1 — 静态检查（全部通过）

| 检查 | 结果 | 证据 |
|---|---|---|
| 源码布局符合 PRD §9 | ✅ | extension/runtime/domain/storage/protocol/templates + tests/{unit,integration,multiprocess} |
| 分层依赖方向（Inv-6 静态） | ✅ | grep 全量：domain/storage/protocol/runtime 零 OMP/extension import（仅注释提及） |
| 13 个 domain tools 齐全 | ✅ | `src/extension/tools.ts`：task_list/get/create/claim/start/complete/fail/abandon/reopen + event_emit + blackboard_read/write + artifact_publish |
| `/swarm` 命令注册 | ✅ | `commands.ts:456`，7 个子命令 init\|role\|status\|tasks\|agents\|recover\|doctor |
| 原子 claim 原语（架构 §9.3） | ✅ | `util/atomic-file.ts:47` `fsp.open(path, "wx")` = O_CREAT\|O_EXCL；EEXIST 归一为 already_claimed |
| 无进程调用原语（Y-07/§15） | ✅ | src 零 child_process/spawn/exec（仅正则 `.exec` 误命中） |
| TypeScript 严格类型 | ✅ | `tsc --noEmit` 零错误 |
| 工具描述携带不变量 | ✅ | 如 swarm_task_claim："Events are notifications — they never grant task ownership" |

## 3. 步骤 2 — G0–G2 自动化测试

**结果：264 用例 / 34 文件，最终 3 次全量连跑全绿（vitest, forks pool）。**

- 首跑 1 失败（runtime-loop 定时器用例），隔离复跑 3/3 绿、热全量 3/3 绿 → 判定偶发 flake，根因见 D-1，非产品缺陷
- 多进程套件：`concurrent-claim.test.ts` 真实子进程 ×4 竞争，恰一胜者 ✓
- 无头域级 e2e：`scripts/smoke-headless.ts` 17/17 PASS（init→创建→发现→竞争 claim→生命周期→广播扇出→cursor 重放→claim/markdown 漂移和解）

## 4. 步骤 3 — G3 真实 OMP 验收（部分通过）

实测环境：真实 `omp -p` 无头会话 + `-e <扩展目录>`。

| 项 | 结果 | 证据 |
|---|---|---|
| Y-01 扩展在真实 omp 加载 | ✅ | `-e ~/aiworld/pi-swarm`（经 package.json omp.extensions 清单解析）加载无错误，会话正常运行 |
| 真实宿主 13 工具注册 | ✅ | 会话内模型可调用全部 swarm 工具（工具面挂载确认） |
| 未绑定防护路径 | ✅ | 真实会话调 swarm_task_list → "No swarm role bound. Run /swarm role <role> first."（优雅拒绝，无异常） |
| `/swarm` 命令面 / 角色绑定生命周期 / sendMessage 唤醒 / before_agent_start 契约注入 / context hook / 会话重绑 | ⚠️ 未在真实宿主验证 | print 模式斜杠命令不路由（omp 行为：命令为 TUI-only）；adapter 行为由扩展单测覆盖（绑定阻塞/陈旧接管/init 幂等/唤醒策略映射/契约十条/上下文过滤全绿），但缺真实宿主确认 |
| Y-02~Y-05 四角色交互剧本 | ⚠️ 待交互式执行 | 见 §5 |

环境注记：尝试以 crafted 会话文件驱动无头重绑未成功（omp 会话文件内部结构依赖），不构成产品缺陷证据，判"未验证"而非"失败"。

## 5. 步骤 4 — G4 性能与规模（实测）

| 指标 | 实测 | 阈值（☆评测约定） | 判定 |
|---|---|---|---|
| 创建 2000 任务 | 13.5s（≈148 任务/s，含每任务事件） | — | ✅ 无病理 |
| 热态 task_list（2000 任务） | p50=275ms / p95=345ms / max=345ms | p95<300ms☆ | ❌ D-2 |
| 追加 10k 事件 | 0.71s | — | ✅ |
| cursor 消费 12k 事件（含 2k 历史） | 0.06s 全量无丢失 | <5s | ✅ 极优 |
| 空闲退避（W-04） | 未实现 | PRD §12 MAY | ⚠️ D-3 非阻断 |
| burst 聚合窗口 | wakeBatchWindowMs=250（配置存在，inbox 聚合有单测） | — | ✅ 机制在位 |

## 6. 步骤 5 — 对抗性不变量抽检（黑盒，全部通过）

| 检查 | 结果 |
|---|---|
| X-01 对抗：向 backend 发"任务已分配给你"direct 事件后，tester 仍成功 claim | ✅ 事件永不授予所有权 |
| X-02 删除整个 events/ 后 claim 归属完整 | ✅ claim 文件即所有权 |
| X-03 删除 events/ 后任务池精确可发现（2000/2000 open） | ✅ 事件非任务 |
| H-08 跨实例伪造 claimId 调 complete | ✅ 拒绝 |
| Q-04 穿越矩阵：`../`×2、绝对路径、`a/../../` | ✅ 4/4 阻断，报错明确 |
| Q-04 `%2e%2e` URL 编码变体 | ✅ 包含性成立（落盘于黑板内字面目录，FS 路径不 URL 解码，零逃逸）——测试计划措辞已按此修正 |
| Q-04 符号链接指向界外目录 | ✅ 不可读 |
| D-5 | **P0** | 产品缺陷（宿主契约） | omp v18.1.10 传给 `registerCommand` handler 的 `args` 是**字符串**（诊断实测 `typeof=string json="hello world"`），交付物按 `string[]` 消费（`commands.ts:469` `const [sub, ...rest] = args` 解构字符串得字符）→ 任何 `/swarm <子命令>` 落入 default 仅显示 usage，**init/role/status/tasks/agents/recover/doctor 七个命令在真实 TUI 全部不可用**，`.pi/swarm/` 不会创建（用户实测 `/swarm init` 无效的根因） | 注册边界归一化：`typeof args === "string" ? args.trim().split(/\\s+/).filter(Boolean) : (args ?? [])`；`pi-api.ts` CommandHandler 类型与测试 FakePi 同步改为真实契约（字符串） |
| D-6 | P1 | 产品缺陷（宿主契约） | omp 对象形式 `appendEntry({type:"custom",customType,...})` 落盘后 `customType` 字段存储**整个对象**（实测 `"customType":{"type":"custom","customType":"dbg.marker.v1",...}`），而 `rebuildBindingFromSession` 按字符串 `entry.customType === "pi-swarm.binding.v1"` 匹配 → 永不命中 → **会话重启后角色绑定丢失**，README"自动重绑"承诺失效（FR-3） | 改用 omp 文档两参形式 `appendEntry("pi-swarm.binding.v1", {role})` 或读取端兼容对象形 customType；补 Z-02 真实宿主往返回归 |
## 7. 缺陷与建议清单

| ID | 级别 | 类型 | 摘要 | 修复建议 |
|---|---|---|---|---|
| D-1 | P1 | 测试基建 | `FakeTimerPort.fireAll()` 用 `await sleep(25)` 等真实 fs I/O（fakes.ts:596），冷启动满负载下断言先于轮询完成 → 套件偶发失败（观测 1/4+）。违反测试计划 §7 确定性要求 | 跟踪 guard 内 in-flight Promise 并 await，或改 `waitFor(predicate)` |
| D-2 | P2 | 性能（PRD §12 SHOULD） | 任务列表无 mtime/size 元数据缓存，每次全量重解析：2000 任务热态 p95=345ms，超出评测约定 300ms；F-06/W-06 未达成 | task-store 增加文件 stat 缓存 + 失效判断（PRD 明示此路径安全） |
| D-3 | P3 | 性能（PRD §12 MAY） | 空闲轮询退避未实现 | 可选：idle 时周期 ≥2× 递增，有事件即恢复 |
| D-4 | — | 测试计划修订 | Q-04 编码变体期望由"拒绝"修正为"包含不逃逸"（本次实测定性） | 已同步 `pi-swarm-1.0-test-plan.md` |

## 8. Release 清单核销（PRD §16，22 项）

| # | 项 | 证据 | 状态 |
|---|---|---|---|
| 1 | 扩展安装加载 | 真实 omp `-e` 加载 ✓ | ✅ |
| 2 | /swarm init 可用 | commands-init 单测（布局+7 模板+幂等+上级目录采纳） | ✅（适配层） |
| 3 | 六 manifests 有效 | B-04 等价单测 + 冒烟 manifests validate | ✅ |
| 4 | 自定义 manifests | C-05 等价单测（零代码加载/绑定/行权） | ✅ |
| 5 | 绑定与 presence 跨会话 | binding 单测（重复活跃阻塞/陈旧接管/替换重绑） | ✅（适配层）|
| 6 | 创建/列表/获取 | 单测+集成+冒烟 | ✅ |
| 7 | 多进程原子 claim | concurrent-claim 真实子进程 | ✅ |
| 8 | 生命周期校验 | task-lifecycle 单测 + 冒烟 + 抽检 | ✅ |
| 9 | 中断 claim 修复 | 冒烟 reconcile 漂移修复 + recovery 单测 | ✅ |
| 10 | 孤儿恢复（单机） | recovery-service 单测（活 PID 不回收/死亡双条件） | ✅ |
| 11 | 每实例 JSONL | event-store 单测（单写者/残行/损坏行）+ 冒烟 | ✅ |

## 11. 复检补充（2026-09-12）

用户在真实窗口执行 `/swarm init` 未创建工作区 → 触发复检。验收人以独立诊断扩展 + PTY 驱动真实 omp TUI 实证：

1. `/dbg hello world` → handler 收到 `typeof=string json="hello world"`（args 为字符串，非数组）
2. PTY 会话中 `/swarm init`、`/swarm doctor` 均只渲染 usage 面板、`.pi/` 从未创建 —— 与用户现象一致，D-5 定性
3. 对象形式 appendEntry 落盘形状异常（customType 被整体对象占据）—— D-6 定性

**根因归类**：两缺陷同源——扩展适配层（pi-api.ts + FakePi）按"设想的宿主契约"编写并自测通过，未与真实 omp 契约对账。验收报告 G3 的 ⚠️"命令面待交互确认"正是此风险敞口，现确认为失败。

**复检后 Release 清单变化**：#2（init 真实宿主）❌、#20（status/recover/doctor 真实宿主）❌、#5（绑定重绑持久化）❌ D-6；其余维持。修复 D-5/D-6 后须重跑：七命令真实 TUI 冒烟（TS-Z 新组）+ 绑定重启往返（Z-02）。

### 新增评测组 TS-Z — 宿主契约一致性（真实 omp，修复后必须全绿）

| ID | 用例 | 步骤/条件 | 通过判定 | 追溯 |
|---|---|---|---|---|
| Z-01 | 命令 args 字符串契约 | 真实 TUI（PTY 驱动）依次执行 `/swarm init`、`/swarm role backend`、`/swarm status`、`/swarm doctor` | 各命令执行对应动作：init 落盘 `.pi/swarm/`；role 生成 presence；status/doctor 有各自输出而非 usage | FR-1、D-5 回归 |
| Z-02 | 绑定持久化往返 | `/swarm role backend` 后重启会话（同 session resume） | 重绑成功：presence 新实例、工具可用；binding marker 以真实宿主可回读形状落盘 | FR-3、D-6 回归 |
| Z-03 | 扩展宿主契约对账 | 以诊断扩展记录 omp 真实契约（args 类型、appendEntry 落盘形状、sendMessage 选项接受集），与 pi-api.ts 声明逐项比对 | 声明与真实契约零漂移（或差异已在适配层归一化并有测试） | Inv-6 边界 |
| 13 | broadcast 订阅路由 | 同上 + 12k 扇出消费 | ✅ |
| 14 | cursor 重启重放 | cursor-store/event-stream 集成 + 12k 重放 | ✅ |
| 15 | inbox 批处理无放大 | inbox/runtime-loop 测试（1 batch/flush、静默抑制） | ✅ |
| 16 | 空闲会话原生唤醒 | wake 单测（idle+actionable→aside+triggerTurn） | ⚠️ 单测级，待真实窗口确认 |
| 17 | context hook 有界 | index 单测（仅留最新 inbox+contract） | ✅（适配层） |
| 18 | 黑板权限强制 | 抽检 Q-04/Q-06 + blackboard-store 单测 | ✅ |
| 19 | 工件发布 | artifact-store 单测 + 抽检 R-02/R-03（digest 实算） | ✅ |
| 20 | status/recover/doctor | doctor 单测（十项/分级/只读） | ✅（适配层） |
| 21 | e2e 四角色剧本 | 冒烟（域级全链）通过；真实 OMP 四会话剧本 | ⚠️ 待交互式执行（§9 剧本已备） |
| 22 | 杀+重启不丢 durable 状态 | recovery/reconcile 测试 + X-02 抽检 | ✅ |

核销结论：**19/22 全证据通过；3 项（#5/#16/#21 相关的真实宿主部分）待交互式窗口确认。**

## 9. 遗留：交互式窗口验收剧本（发布前必做）

按测试计划 TS-Y，在 4+ 个真实 Pi 窗口执行（工作区任选）：

1. 窗口 A：`/swarm init` → `/swarm role coordinator`；窗口 B/C/D 分别 `role researcher` / `role backend` / `role tester`（验证重复绑定拦截：再开一窗绑 backend 应被拒）
2. coordinator 建 3 任务（research/impl/verify，impl dependsOn research）
3. researcher 认领→写 findings 黑板→complete；确认 backend 侧依赖解锁且收到广播
4. backend 认领→`swarm_artifact_publish`→complete；tester 认领 verify→广播 review
5. 中途 kill -9 backend 窗口进程 → `/swarm recover` → 任务 reopen
6. 任一窗口空闲时由他窗创建任务，观察空闲窗口被自动唤醒（triggerTurn）
7. 全程 `ls tasks/ claims/ events/ blackboard/ artifacts/` 留证

通过判据：每步文件级证据齐全，全程零手工文件编辑。

## 10. 验收方法注记（披露）

- 验收期两次探测误报已自查纠正：(a) omp 会话超时源于 print 模式命令不路由 + 提示词被内部模型消费；(b) "目录消失/加载失败"源于验收人将用户名 `leewbl` 误写为 `lewb` 的绝对路径。两者均不构成被验收物缺陷，特此披露以保证报告可追溯。
- 性能数据为单机单轮实测（Apple M1），p95 基于 20 次采样，符合评测约定阈值口径。
