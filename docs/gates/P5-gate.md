# P5 人工闸门（Hard Gate）

> 阶段：Phase 5 · 治理面与交付（M5 + P5 设置面收官）
> 修订：2026-11-07（设置面、运维任务、连接器心跳全部落地）
> 验收主体：用户本人；AI 自评不算通过

## 交付物

- 交付底座（M5）：`app_versions` 版本表与 `app.current_app_version()`；`npm run backup` / `restore` / `upgrade` / `rollback`；`backups/<stamp>/manifest.json` 校验和与关键表行数
- 治理面（M5）：交接包导出（`/api/handover/export`）、审计导出（`/api/audit/export`，JSONL / CSV）、审计留存（`npm run audit:prune`）、授权收口体检（`npm run audit:grants`）
- 设置面（P5 切片 1）：`/settings` 品牌（站点名 / 副标题 / 四档品牌色）、模型 Key（AES-256-GCM 加密入库、末 4 位提示、连接测试、热生效）、审计留存、交付与备份只读视图
- 运维任务（P5 切片 2）：`ops_tasks` + 宿主机 `npm run ops:runner`；设置页可发起热备 / 冷备 / 恢复演练，5 秒自动刷新状态
- 连接器心跳（P5 切片 3）：`mcp_servers.health_*`；`/settings/mcp` 批量体检与异常横幅；连续失败 1–2 次降级、≥3 次熔断；worker 工具计划排除 `down`；状态迁移写审计，可选 `MCP_ALERT_WEBHOOK` 告警
- RLS：`db/policies/001–028`（`jxf_app` 非 owner / 非 superuser / 非 bypassrls；`app_settings` 与 `ops_tasks` 读写均限 L1，任务状态只能由 owner runner 回写）
- 测试：`verify:guards`、`test:settings`、`test:mcp-health`、`smoke`、`audit:grants`、`verify:delivery`
- 页面入口：`/settings`（我的菜单 → 设置）、`/settings/mcp`、`/health`

## 自动化证据（本次修订时通过）

```text
npm run verify:delivery
  [PASS] 权限守卫覆盖        entries=98 covered=86 whitelisted=12 uncovered=0
  [PASS] TypeScript 类型检查  0 Error
  [PASS] 部署冒烟            passed=15 warned=0 failed=0
  [PASS] 设置面校验          passed=25 failed=0（加密 / RLS / L1-L3 边界 / 运维任务）
  [PASS] 连接器心跳校验      passed=10 failed=0（degraded → down → recovered）
  [PASS] 授权收口体检        failed=0 warned=1（Marcus 未上线员工授权，数据提示）
  → 6/6 通过

migrate 容器：applied_migrations=25 / applied_policies=28 / extensions ok
真实演练记录：
  备份（热备）→ runner 2.7s 完成，manifest 与关键表行数一致
  恢复演练（影子库）→ runner 4.5s 完成，不触碰生产库
  升级 + 回滚 → 旧镜像回滚标签、迁移门禁、健康检查均通过（M5 切片 1）
浏览器实测：
  /settings 四区块渲染；品牌保存 → 侧栏与标题更新 → 还原成功
  运维任务：点击「发起备份」→ 5 秒内自动刷新为「已完成」
  连接器体检：坏连接器 3 次失败后显示「熔断」红标与异常横幅；点「批量体检」汇总正确
数据库回归全集（2026-11-07 收官复跑）：
  test:rls 33 / test:context 16 / test:permissions 155 / test:permission-core 40
  test:snapshot 17 / test:permission-admin-db 14 / test:handover 23
  test:knowledge 127 / test:ai-employees 30 / test:runtime 48  → 全部 0 失败
环境：postgres / minio / web healthy，worker-app 运行中；mcp_servers=0，测试用户残留=0
```

## 验收步骤（可照着点的路径）

> 入口固定为 `http://127.0.0.1`（`localhost` 会 308 跳转，避免会话跨主机名丢失）。
> 演示账号：`admin@jxf.local`；口令见 `.env` 的 `SEED_PASSWORD`。
> 宿主机需已 `npm install`；运维任务与心跳需要 `npm run ops:runner` 常驻。

### A. 交付底座

- [ ] 1. `docker compose --env-file .env -f docker/docker-compose.yml ps`：postgres / minio / web healthy，caddy 运行
- [ ] 2. 打开 `http://127.0.0.1/health`：status=READY，`schema` 检查显示版本表已写入
- [ ] 3. 宿主机执行 `npm run backup`：产出 `backups/backup-<stamp>/` 三个归档 + manifest
- [ ] 4. `npm run restore -- --from backups/<stamp> --verify`：影子库恢复成功且关键表行数一致（不覆盖生产库）

### B. 设置面

- [ ] 5. 右上角个人菜单 → 设置：进入 `/settings`，四区块齐全（品牌 / 模型 Key / 审计与留存 / 交付与备份）
- [ ] 6. 修改站点名称与品牌色 → 保存 → 侧栏 / 浏览器标题在下次页面加载后更新；再改回原值并保存
- [ ] 7. 模型 Key：保存后页面只显示末 4 位；点「测试当前连接」返回成功或明确错误；Worker 重启后同样生效
- [ ] 8. 审计与留存：保存留存天数后显示新值；导出 CSV / JSONL 可下载；审计条数随操作增长
- [ ] 9. 交付与备份：能看到最近备份清单（类型 / 时间 / DB 版本 / 大小）与最近升级状态

### C. 运维任务（隔离架构）

- [ ] 10. 宿主机执行 `npm run ops:runner`，日志出现「已启动」与「连接器体检完成」
- [ ] 11. `/settings` → 运维任务 → 发起备份（热备）：提示已排队，5 秒内状态变「已完成」，结果列显示新备份目录
- [ ] 12. 发起「最近备份恢复演练」：状态变「已完成」；`/settings` 交付清单同步出现新备份
- [ ] 13. 停止 runner 后再发起任务：任务停在「排队中」（证明 Web 无 docker 权限、不会越权执行）

### D. 连接器心跳与降级

- [ ] 14. `/settings/mcp` → 新建连接器（http 端点）→ 批量体检：状态显示「健康」，最近体检时间与延迟可见
- [ ] 15. 把端点改为不可达地址（或断开服务）→ 连续体检 3 次：依次显示「降级」→「熔断」，顶部出现异常横幅
- [ ] 16. 熔断后 AI 员工运行时会跳过该连接器（工具计划不包含其工具），其他连接器不受影响
- [ ] 17. 恢复端点后体检：状态回到「健康」，审计出现 `mcp.connector_recovered`
- [ ] 18. （可选）配置 `MCP_ALERT_WEBHOOK` 后重复 15：webhook 收到 `mcp.connector_unhealthy`；恢复后收到 `mcp.connector_recovered`

### E. 一键门禁

- [ ] 19. 宿主机执行 `npm run verify:delivery`：6/6 通过（guards / typecheck / smoke / settings / mcp-health / grants）
- [ ] 20. `git status` 干净，最近提交包含 M5 收官、P5 切片 1–3

## 不通过项

- 无

## 结论：已封包（2026-11-07）

> Tag：`gate/p5-passed` @ `3638db9`
> 自动化门禁 6/6 + 数据库回归全集全绿；人工验收步骤保留在本文件，后续改动如触及 P5 范围需重新走一遍。
