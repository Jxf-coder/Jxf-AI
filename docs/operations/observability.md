# 可观测性（指标 / 日志 / 健康检查）

> 适用范围：私有化单机交付。指标只做聚合计数，不返回用户、文档或令牌明细。

## 1. 健康检查

| 端点 | 用途 | 说明 |
|---|---|---|
| `GET /api/health/live` | 存活探针 | 不依赖数据库，进程活着即 200 |
| `GET /api/health` | 就绪探针 | 校验数据库连接与版本表，返回 `status=ok` 与 `db_version` |

Docker Compose 已把 `/api/health` 配为 web 容器健康检查；Caddy 只在 web 健康后启动。

## 2. 指标端点

```bash
# JSON（默认）
curl -fsS http://127.0.0.1/api/metrics

# Prometheus 文本格式
curl -fsS "http://127.0.0.1/api/metrics?format=prometheus"
```

`METRICS_TOKEN` 由安装向导随机生成，调用时必须带 Bearer：

```bash
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1/api/metrics
```

`JXF_ENV=production`（默认）且 `METRICS_TOKEN` 为空时，端点固定返回 503 且不下发任何计数
（fail-closed），避免反向代理误绑 `0.0.0.0` 后泄露组织规模与队列积压；`npm run smoke`
会把这种情况记为 WARN。

指标来自 `app.metrics_snapshot()`（SECURITY DEFINER，只返回计数），因此不受应用角色
RLS 的部门范围影响，也不会泄露跨部门明细。

### 指标含义

| 指标 | 含义 |
|---|---|
| `jxf_runs{status}` | 运行时队列（对话 / 任务 / 入库）按状态计数 |
| `jxf_work_items{status}` | AI 员工工作项按状态计数（queued / running / waiting_review / done / failed…） |
| `jxf_ops_tasks{status}` | 运维任务（备份 / 恢复演练）按状态计数 |
| `jxf_connectors{health}` | MCP 连接器按健康状态计数（healthy / degraded / down / unknown） |
| `jxf_connectors_total` | 连接器总数 |
| `jxf_pipelines_total` / `jxf_pipelines_enabled` | 产线总数 / 启用数 |
| `jxf_pipeline_runs_open` | 尚未收口的产线运行数 |
| `jxf_audit_events_total` | 审计事件总数 |
| `jxf_users_total` | 用户总数 |
| `jxf_up` | 指标端点可用（固定 1） |

## 3. Prometheus 抓取示例

```yaml
scrape_configs:
  - job_name: jxf-ai
    metrics_path: /api/metrics
    params:
      format: ["prometheus"]
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/jxf-metrics-token
    static_configs:
      - targets: ["jxf.example.com"]
```

### 建议告警

```yaml
groups:
  - name: jxf-ai
    rules:
      - alert: JxfConnectorDown
        expr: jxf_connectors{health="down"} > 0
        for: 10m
        annotations:
          summary: "有 MCP 连接器被熔断，相关工具已从运行时跳过"
      - alert: JxfTaskBacklog
        expr: jxf_runs{status="queued"} > 50
        for: 15m
        annotations:
          summary: "运行时队列积压，检查 worker-app 是否存活"
      - alert: JxfOpsTaskFailed
        expr: jxf_ops_tasks{status="failed"} > 0
        for: 5m
        annotations:
          summary: "存在失败的备份/恢复演练任务"
      - alert: JxfPipelineStalled
        expr: jxf_pipeline_runs_open > 10
        for: 30m
        annotations:
          summary: "产线运行长期未收口，检查 ops:runner 是否在推进"
```

## 4. 日志

- 应用日志为单行 JSON：`ts` / `level` / `service` / `msg` + 事件字段（如 `request_id`、`user_id`、`permission`）。
- 关键事件：`permission_denied`、`runtime_run_failed`、`mcp_health_*`、`notification_*`、`pipeline_*`、`settings_*`。
- 容器日志由 Compose 的 `json-file` 驱动轮转（20MB × 5）。
- 宿主机 runner 日志：systemd → `journalctl -u jxf-ops-runner`；Windows → `backups\ops-runner.log`。

## 5. 与通知的关系

指标负责「趋势与告警阈值」，邮件负责「事件通知」：

- 连接器 degraded / down / 恢复 → 邮件（设置面 SMTP，见 `docs/operations/ops-runner.md`）
- 运维任务失败 / 产线失败 → 邮件
- 长期积压、磁盘、备份缺失等趋势问题 → Prometheus 规则

## 6. 手工核对

```bash
npm run smoke            # 容器、探针、指标端点、备份完整性
npm run test:metrics     # 指标函数返回结构与计数类型
npm run verify:delivery  # 一键门禁（含以上两项）
```
