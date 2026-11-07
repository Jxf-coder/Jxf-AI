# 产线触发方式（Webhook / 内部事件）

> 产线每天最少需要宿主机 `npm run ops:runner` 在跑：它负责派发内部事件、定时触发与步骤推进。

## 1. 外部 Webhook

### 1.1 生成令牌

`/pipelines` → 目标产线 → 「生成令牌」。令牌只显示一次（64 位十六进制），库内只保存
SHA-256 哈希与末 4 位提示；「重置令牌」立即让旧令牌失效，「停用 Webhook」清空令牌。

### 1.2 调用

```bash
curl -X POST "https://jxf.example.com/api/webhooks/pipelines/<pipelineId>" \
  -H "X-JXF-Token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"event":"push","ref":"main"}'
```

也支持 `Authorization: Bearer <token>`。

| 状态码 | 含义 |
|---|---|
| 202 | 已触发，返回 `runId`（后续步骤由 runner 推进） |
| 400 | pipelineId 不是 UUID |
| 401 | 缺少令牌或令牌不匹配 |
| 404 | 产线不存在或未启用 Webhook |
| 409 | 产线已停用 / 产线发起人已无有效任用 / 首步派发失败 |
| 413 | 请求体超过 64KB |

### 1.3 安全边界

- 每产线独立令牌，比较使用 `timingSafeEqual`；
- 请求体只计算摘要（`trigger_ref = webhook:<sha256 前 16 位>`），不落第三方原始负载；
- 以产线发起人的用户上下文运行，沿用 `pipeline:use` / `skill:use` 与 RLS；
- 路由不读取用户会话，已列入权限守卫白名单并注明原因。

## 2. 内部事件

### 2.1 事件类型

| event_type | 产生时机 | 生产者 |
|---|---|---|
| `knowledge.ingest_done` | 知识库批次入库完成（status=done） | Web 入库流程 |
| `mcp.connector_changed` | 连接器 degraded / down / 恢复 | 宿主机 runner 心跳 |
| `work_item.finished` | AI 员工任务结束（done / waiting_review / failed / cancelled） | Worker |

### 2.2 订阅

`/pipelines` → 产线卡片 → 「事件订阅」勾选即可（需要管理产线权限）。订阅关系存在
`pipeline_event_subscriptions`，每个产线每类事件一条。

### 2.3 派发

- 事件先写入 `pipeline_events`（`app.publish_event()`，追加式）；
- runner 每 `PIPELINE_TICK_MS`（默认 60 秒）取 `pending` 事件，按订阅以产线发起人身份运行；
- 运行记录 `trigger_kind='event'`、`trigger_ref='event:<eventId>'`；
- 失败最多尝试 3 轮，之后标记 `failed` 并保留 `last_error`；成功标记 `processed`。

### 2.4 排查

```sql
-- 最近事件
select id, event_type, status, attempts, last_error, run_ids, created_at
  from pipeline_events order by created_at desc limit 20;

-- 某产线的订阅
select event_type, enabled from pipeline_event_subscriptions where pipeline_id = '<id>';
```

常见问题：

- 事件一直 `pending`：runner 未启动或已退出；
- `processed` 但 `triggered = 0`：没有产线订阅该事件，或订阅的产线已停用；
- `failed`：查看 `last_error`（多为发起人失活或 AI 员工下线）。

## 3. 与定时触发的关系

| 触发方式 | 入口 | trigger_kind |
|---|---|---|
| 手动 | `/pipelines` 运行按钮 | `manual` |
| 定时 | `schedule_interval_minutes` + runner | `schedule` |
| Webhook | `POST /api/webhooks/pipelines/:id` | `webhook` |
| 内部事件 | 订阅 + runner 派发 | `event` |

四种方式最终都调用同一个 `runPipeline()`，只派第一步，后续步骤由 runner 链式推进。

## 4. 验收

```bash
npm run test:pipelines      # 含 Webhook 鉴权与事件派发断言
npm run verify:delivery     # 一键 10/10 门禁
```
