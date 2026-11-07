# P4 人工闸门（Hard Gate）

> 阶段：Phase 4 · MCP Hub（对外令牌 + 外部连接器 + 运行时接入）
> 修订：2026-11-07（含六维 scope、逐工具审批、每日配额与心跳熔断）
> 验收主体：用户本人；AI 自评不算通过

## 交付物

- 对外令牌：`mcp_tokens`（只存 sha256、绑定任用、六维 scope）；`/settings/mcp` 签发 / 停用
- MCP 端点：`/api/mcp`（Streamable HTTP · JSON 响应 · 无会话）；`tools/list` 与 `tools/call` 双重 scope 校验
- 内置工具：`knowledge.search` / `workitem.list` / `employee.list` / `workitem.assign`
- 六维 scope：技能 / 产线 / 动作 / 直写 / 审批 / 客户端通道
- 逐工具审批：`mcp_tool_approvals`；命中审批维的写类工具不直接执行，L1 批准后按令牌任用身份执行
- 外部连接器：`mcp_servers` / `mcp_server_calls`；SSRF 白名单、stdio 命令白名单、每分钟限流、每日配额
- 运行时接入：员工 `allowed_tools = mcp:<serverId>:<toolName>`；worker 工具对话（最多 4 轮 / 10 次调用）
- 心跳与降级：`health_status`（unknown / healthy / degraded / down）；连续失败 ≥3 次熔断，worker 自动跳过
- 测试：`test:mcp-health`、`verify:guards`、`smoke`（`/api/mcp` 未认证 401）

## 自动化证据（2026-11-07 收官复跑）

```text
npm run test:mcp-health → passed=10 failed=0
  覆盖：degraded → down → recovered 状态机 / 熔断后 worker 排除 /
        状态迁移审计 / 恢复审计 / 告警回调
npm run verify:guards → entries=98 covered=86 whitelisted=12 uncovered=0
npm run smoke → /api/mcp 未认证 401；15/15
npm run test:permissions → passed=155 failed=0（scope 与目录不变量）
真实演练：坏连接器连续 3 次体检显示「熔断」，设置页异常横幅与批量体检汇总正确
```

## 验收步骤（可照着点的路径）

### A. 签发令牌

- [ ] 1. `/settings/mcp` → 签发 MCP 令牌：选择任用、填写名称
- [ ] 2. 技能维 / 产线维 / 动作维 / 审批维 / 客户端通道维按需勾选；不选表示不限
- [ ] 3. 签发后明文只显示一次；列表只显示前缀与 scope 摘要
- [ ] 4. 停用令牌后，外部客户端立即 401

### B. 外部客户端连接

- [ ] 5. 用 MCP 客户端（Claude Desktop / IDE / curl）配置 `http://<host>/api/mcp` + Bearer 令牌
- [ ] 6. `tools/list`：只返回 scope 内工具；未勾选的工具完全不出现（不是调用时报错）
- [ ] 7. `tools/call` 调用 `knowledge.search`：只返回令牌绑定任用可见范围的数据
- [ ] 8. 越权调用（scope 外工具 / 他人部门数据）：被拒绝且写审计

### C. 审批与配额

- [ ] 9. 令牌勾选写类工具审批维：调用写类工具不直接执行，生成待审单
- [ ] 10. L1 在 `/settings/mcp` → 逐工具审批：批准后按令牌任用身份执行，结果留档；驳回则不执行
- [ ] 11. 客户端通道不符（未在 channels 内）：403 拒绝
- [ ] 12. 连续调用超过每分钟上限 / 每日配额：被拒绝并计入 `mcp_server_calls`

### D. 外部连接器

- [ ] 13. 新建 http 连接器：公网地址通过；`127.0.0.1` / 内网地址被 SSRF 校验拒绝（除非加入 `MCP_TRUSTED_HOSTS`）
- [ ] 14. 「探测工具」拉取工具列表并缓存；「测试调用」返回结果
- [ ] 15. 连接器工具白名单生效：白名单外的工具调用被拒绝
- [ ] 16. stdio 连接器：仅允许 `MCP_STDIO_ALLOWED_COMMANDS` 内命令；未配置时禁用

### E. 心跳与降级

- [ ] 17. 「批量体检」：健康连接器显示健康徽章、最近体检时间与延迟
- [ ] 18. 让连接器不可达并连续体检 3 次：降级 → 熔断，顶部出现异常横幅
- [ ] 19. 熔断后 AI 员工运行时跳过该连接器，其他工具不受影响；恢复后体检回归健康
- [ ] 20. 宿主机 `npm run ops:runner -- --health-once` 可完成同样体检；配置 `MCP_ALERT_WEBHOOK` 时收到告警

### F. 任用绑定与失效

- [ ] 21. 令牌绑定成员发起离职交接 → 审批通过后令牌立即失效（401）
- [ ] 22. 令牌过期或被停用后，外部客户端无法继续调用

## 不通过项

- （待填写）

## 结论：待人工确认（2026-11-07）

> 完成上述 22 步后打 tag `gate/p4-passed`；未通过时只修复本文件列出的未通过项。
