# P3 人工闸门（Hard Gate）

> 阶段：Phase 3 · AI 运行时与对话
> 修订：2026-11-07（按当前对话与运行态实现重写）
> 验收主体：用户本人；AI 自评不算通过

## 交付物

- 运行态表：`threads` / `runs` / `run_steps` / `run_events` / `tool_calls` / `token_usages`
- 队列：`queued | running | interrupted | done | failed | cancelled` 状态机；租约、心跳续租、超时收口（interrupted 而非 failed）
- 事件流：`run_events.seq` 单调递增；断线按 `after=seq` 补发；partial_text 快照
- 对话页：`/chat`；流式输出、思考过程、工具调用、中止、历史会话
- AI 员工：`/ai-employees` 目录、派活、执行跟踪与人工验收（`work_items` waiting_review）
- 测试：`test:runtime`、`test:ai-employees`

## 自动化证据（2026-11-07 收官复跑）

```text
npm run test:runtime → passed=48 failed=0
  覆盖：幂等受理 / 并发只产生一个 run / 跨部门隔离 / 事件 seq /
        300 次 delta 不落事件 / 用量账本 / 租约回收 / SKIP LOCKED /
        取消请求 / interrupted 续跑 / 心跳超时收口 / 索引命中
npm run test:ai-employees → passed=30 failed=0
  覆盖：Fail-Closed 可见性 / 授权与撤回 / 离职即时生效 / 审计留痕
npm run verify:delivery → 6/6
```

## 验收步骤（可照着点的路径）

### A. 对话主链路

- [ ] 1. `/chat` 提问：看到「正在思考」→ 增量输出 → 完成；刷新后可看到历史
- [ ] 2. 追问同一会话：上下文连续，不新建会话
- [ ] 3. 触发知识库问答：回答带引用编号，可跳转证据

### B. 中断与恢复

- [ ] 4. 生成过程中点「中止」：状态变为 cancelled，不再继续输出
- [ ] 5. 生成过程中断网 30 秒再恢复：页面自动重连，按 seq 补齐内容，不重复不丢失
- [ ] 6. 关闭页面后重新进入同一会话：能看到最终结果与事件记录

### C. 工具调用与用量

- [ ] 7. 配置了 MCP 连接器时，对话触发工具：展示「调用工具」步骤与结果
- [ ] 8. 工具调用失败时：模型收到错误文本并给出可读说明，不整轮崩溃
- [ ] 9. 每次模型调用在 `token_usages` 恰好一行，`runs` 冗余用量与账本累加一致

### D. AI 员工派活与验收

- [ ] 10. `/ai-employees` 新建 AI 员工（L1）→ 授权给部门 → 普通成员可见
- [ ] 11. 派活：生成 `work_items`，状态从进行中到 `waiting_review`
- [ ] 12. 人工验收：通过 / 退回，状态与交付物留档；顶栏「待验收」数字同步
- [ ] 13. 未授权部门成员在列表与派活入口完全不可见（Fail-Closed）

### E. 运行态边界

- [ ] 14. L3 读兄弟部门 run / thread / run_events：0 行；写 run 被拒绝
- [ ] 15. worker 角色不能创建 run、不能写业务表；只能消费队列与回填运行态数据

## 不通过项

- （待填写）

## 结论：待人工确认（2026-11-07）

> 完成上述 15 步后打 tag `gate/p3-passed`；未通过时只修复本文件列出的未通过项。
