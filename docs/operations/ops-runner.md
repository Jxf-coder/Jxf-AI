# 运维 runner 部署（ops:runner）

> 适用范围：P5 切片 2/3。Web 容器不持有 docker 权限，备份、恢复演练与连接器心跳由宿主机 runner 执行。

## 职责

- 轮询 `ops_tasks`，执行白名单任务：`backup` / `restore_verify`
- 每 `MCP_HEALTH_INTERVAL_MS`（默认 5 分钟）体检启用中的 MCP 连接器：
  - 连续失败 1–2 次 → `degraded`；≥3 次 → `down`（worker 运行时自动跳过）
  - 状态迁移写审计：`mcp.connector_unhealthy` / `mcp.connector_recovered`
  - 配置 `MCP_ALERT_WEBHOOK` 时推送 JSON 告警
- 每 `PIPELINE_TICK_MS`（默认 60 秒）推进自动化产线：
  - 到点的定时产线发起一次运行（`trigger_kind = 'schedule'`）
  - 上一步完成后派下一步，`{{previous}}` 替换为上一步交付文本
  - 可选步骤失败则跳过并继续；非可选步骤失败则整条产线停止
- runner 启动时把上次异常退出遗留的 `running` 任务收口为 `failed`

## 前置条件

1. 仓库已 `npm install`（runner 通过 `tsx` 直接加载 `src/lib/mcp/health.ts`）
2. 仓库根目录存在 `.env`（runner 读取 owner 数据库连接与 `MCP_*` 配置）
3. 宿主机可执行 `docker compose`（与 `.env` 中 `COMPOSE_PROJECT_NAME` 一致）
4. 机器时区正确（任务与备份目录使用本地时间戳）

## Linux（systemd）

```bash
# 1. 放置 unit（按实际部署用户与目录修改 User / WorkingDirectory）
sudo cp deploy/systemd/jxf-ops-runner.service /etc/systemd/system/
sudo vi /etc/systemd/system/jxf-ops-runner.service

# 2. 启用
sudo systemctl daemon-reload
sudo systemctl enable --now jxf-ops-runner

# 3. 验证
systemctl status jxf-ops-runner
journalctl -u jxf-ops-runner -f
```

`Restart=always` + `RestartSec=10`：异常退出自动拉起；`SIGTERM` 会等待当前任务执行完再退出。

## Windows（计划任务）

```powershell
# 管理员 PowerShell；默认「当前用户登录时启动」（Docker Desktop 场景）
.\deploy\windows\install-ops-runner.ps1

# Windows Server + Docker Engine 服务：开机启动
.\deploy\windows\install-ops-runner.ps1 -AtStartup

# 立即启动 / 查看
Start-ScheduledTask -TaskName "JxfAI-OpsRunner"
Get-ScheduledTaskInfo -TaskName "JxfAI-OpsRunner"
```

日志：`backups\ops-runner.log`（启动器会在异常退出后 10 秒自动重启）。

## cron / 计划任务（不常驻）

```cron
# 每分钟处理一次运维任务
* * * * * cd /opt/jxf-ai && npm run ops:runner -- --once >> backups/ops-runner-tasks.log 2>&1
# 每 5 分钟一次连接器心跳
*/5 * * * * cd /opt/jxf-ai && npm run ops:runner -- --health-once >> backups/ops-runner-health.log 2>&1
# 每分钟推进一次产线（定时触发 + 上一步完成后的下一步）
* * * * * cd /opt/jxf-ai && npm run ops:runner -- --pipelines-once >> backups/ops-runner-pipelines.log 2>&1
```

注意：`--once` 只处理任务，不执行心跳与产线；心跳用 `--health-once`，产线用 `--pipelines-once`。

## 可用参数与环境变量

| 项 | 说明 |
|---|---|
| `npm run ops:runner` | 常驻：任务轮询 + 周期心跳 + 产线推进 |
| `--once` | 执行一轮任务后退出 |
| `--health-once` | 只做一次连接器体检后退出 |
| `--pipelines-once` | 只推进一轮产线后退出 |
| `--no-health` | 常驻但不做周期心跳 |
| `--no-pipelines` | 常驻但不推进产线 |
| `MCP_HEALTH_INTERVAL_MS` | 心跳间隔，默认 `300000`（5 分钟） |
| `PIPELINE_TICK_MS` | 产线推进间隔，默认 `60000`（60 秒） |
| `MCP_ALERT_WEBHOOK` | 告警 webhook（HTTP/HTTPS，POST JSON），留空只写审计 |

## 验证

1. `/settings` → 运维任务 → 发起热备：5 秒内自动变为「已完成」
2. 宿主机日志出现 `连接器体检完成 {"total":N,...}`
3. `/settings/mcp` → 批量体检：连接器显示健康徽章与最近体检时间
4. 人为让连接器不可达并体检 3 次：出现「降级 → 熔断」与异常横幅

## 故障排查

| 现象 | 排查 |
|---|---|
| 任务一直「排队中」 | runner 未启动 / 已退出；看 systemd 或 `backups\ops-runner.log` |
| `缺少数据库 owner 环境变量` | 未在仓库根目录执行，或 `.env` 缺少 `JXF_OWNER_USER/PASSWORD` |
| `Cannot find module 'tsx'` | 宿主机未执行 `npm install`（或只装了 `--omit=dev`） |
| docker 权限错误 | 运行用户需在 `docker` 组；Windows 需 Docker Desktop 正在运行 |
| 连接器体检总是失败 | 检查 `MCP_TRUSTED_HOSTS`、端点可达性与 SSRF 白名单策略 |

## 安全边界

- runner 只执行固定脚本与固定参数，不接受数据库中的任意命令或路径
- 恢复演练固定使用最近一次备份，永不覆盖生产库
- Web 容器始终不挂载 docker socket；runner 是唯一持有 docker 权限的运维进程
