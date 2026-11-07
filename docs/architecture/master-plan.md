# Jxf-AI 工作台 · 工程架构与落地路线图（Master Plan）

> 版本：v1.0
> 适用范围：从零搭建 / 私有化交付
> 依据：原项目（`e:\原项目\Jxf-AI`）四线只读审计 + 架构选型三步对练结论
> 关联文档：[Milestone1-岗位与授权数据模型.md](Milestone1-岗位与授权数据模型.md)、[Milestone2-知识库数据模型.md](Milestone2-知识库数据模型.md)
> 本文件是**唯一实施基准**。与任何对话记录冲突时，以本文件为准。

---

## 0. 一页纸摘要

| 问题 | 结论 |
|---|---|
| 交付形态 | **Docker Compose 单机私有化交付**，不依赖任何云端 SaaS，不做 Serverless |
| 主语言 | TypeScript（Next.js 15 全栈，唯一对外入口） |
| 数据层 | PostgreSQL 16 + pgvector + RLS（自建镜像，含中文分词扩展） |
| Python | **仅离线工具**（OCR / 音视频），不持数据库凭据、不写业务表、不进主请求链路 |
| 用户态 | PG 表存事件日志做真源，单机用进程内 channel 做 fan-out，横向扩展时才上 NOTIFY/Redis |
| 队列 | 先 PG（`FOR UPDATE SKIP LOCKED` + 租约），不预置 Redis |
| 协议 | 官方 `@modelcontextprotocol/sdk`，**治理层自研**（scope / token / channel） |
| 明确不做 | NestJS 双后端、云端 Supabase、自研 JSON-RPC、自研会话认证、DAG 编排画布、文件系统当库 |

**三条不可让渡的底线**

1. 所有写库动作必须发生在持有用户身份的上下文里（不得用 service_role / owner 写业务表）
2. 数据库是授权唯一权威，中间件只做快速失败
3. 任何身份缺失都 fail-closed，不允许降级放行

---

## 1. 计算机语言与技术栈选型矩阵

### 1.1 选型表

| 层 | 选型 | 职责 | 边界铁律 |
|---|---|---|---|
| 应用全栈 | **TypeScript / Node.js 22+ / Next.js 15 App Router / React 19** | UI、API、会话、Agent 主循环、MCP 接入接出、SQL 检索编排 | 唯一对外入口；所有写库动作在此完成 |
| 数据与治理 | **SQL / PostgreSQL 16 / PL-pgSQL / pgvector** | 关系数据、RLS 策略、向量检索、全文检索、轻量队列 | 授权与隔离在此强制；应用层不得绕过 |
| ORM / 迁移 | **Drizzle ORM + drizzle-kit** | 表定义、迁移生成 | 不用 Prisma（vector 支持残缺、与 `SET LOCAL` 冲突）；RLS 走原生 SQL 迁移 |
| 离线算力 | **Python 3.11+（按需容器，profile 隔离）** | 仅 OCR、复杂版式还原、音视频/ASR/自建模型推理 | 不连数据库、不持凭据、只读对象存储、输出 JSON |
| 运维编排 | **Bash / Docker Compose / Caddy** | 一键启动、迁移、健康检查、反向代理与 TLS | 所有环境同一套 compose，不搞"本地一套生产一套" |
| 认证 | **成熟可自托管 Auth 库（Better Auth 组织插件 / Auth.js v5 + adapter）** | 会话签发、用户表、API Key | **禁止手写会话票据**（原项目 10 年 TTL、无吊销是反面教材） |

### 1.2 明确不采用（及原因）

| 不采用 | 原因 |
|---|---|
| NestJS 第二后端 | 与 Next.js BFF 抢职责，SSE 多跳一层；原项目单 Next 已撑住完整工作台 |
| 云端 Supabase | 与"私有化交付"直接冲突（数据必须留在客户机房） |
| 自研 MCP JSON-RPC | 缺 session/分页/通知，schema 靠猜，已造成 4 条工具永久不可调 |
| 自研 HMAC 会话 | 无吊销、双实现漂移、TTL 十年 |
| 文件系统当数据库 | 全量读 + 写放大 + 无跨进程锁 |
| Redis（初期） | 无负载证据就引入等于多维护一个组件；PG 队列已验证够用 |
| DAG 编排画布 | 原项目从未使用，靠"线性工作流 + 队列"跑业务；属无底洞 |
| service_role 写业务表 | 直接架空 RLS，等于放弃刚建立的安全模型 |

### 1.3 容器拓扑

```
docker compose (单机)
├── web            Next.js standalone     ← 唯一对外（经 caddy 反代）
├── caddy          反向代理 + TLS
├── migrate        一次性：drizzle migrate → policies/*.sql（幂等）
├── postgres       自建镜像：pgvector + pg_bigm（+ pg_trgm）
├── minio          原件 / 导出包
└── worker         profile: media（默认不启动）OCR / 音视频
```

依赖关系：`web depends_on migrate (service_completed_successfully)` + `postgres(healthy)`。

---

## 2. 核心数据模型与演进里程碑

> 每个里程碑都遵循同一套 RLS 模式，不另立机制。DDL 细节见关联文档，此处只定边界与验收。
>
> **术语边界（勿混用）**：
> - **部门（department）** = 企业人员组织容器（root / child / group），承载人员任职与业务数据的可见边界，也是 RAG 隔离的物理边界。
> - **业务岗位（title）** = 成员的 `memberships.title` 自由文本（交付经理 / 架构师 / HRBP），不构成层级、不参与权限判定。
> - **AI 员工（ai_employee）** = 可复用的智能体定义，不属于组织架构、不占部门树、不计入岗位数，可被多个部门使用。
> - AI 员工**不携带自身数据权限**，运行时一律继承调用者的部门上下文。

### M1 组织治理与安全底座

**表**：`departments`（部门/小组树）、`department_closure`（子树闭包）、`memberships`（成员 + 业务岗位 title + L1/L2/L3）、`department_packs`（部门能力包，数组 + GIN）、`grants`（pack/channel 共享授权，可与 M5 合并）

**机制**：
- 读 = 自身 + 全部子部门；写 = 仅自身（原项目语义，已证明正确）
- `SECURITY DEFINER` 函数打破 `memberships` 的策略递归
- `department_closure` 替代递归 CTE
- 请求入口算一次 `app.department_ids` 写入 `SET LOCAL`，策略不 join

**关键认知**：私有化交付下 `tenant_id` 恒为单值，**隔离粒度是部门不是租户**。`tenant_id` 仅作未来 SaaS 预留列。

**验收**：见 §5.1（10 条越权测试）

### M2 知识治理与通用资产

**表**：`assets`（通用对象存储引用）、`documents`、`doc_chunks`（含 `embedding vector` + `tsv` + 页码/字符区间）、`knowledge_cards`、`card_evidence`、`ingest_runs / ingest_files`、`knowledge_gaps`、`qa_logs`、`regression_*`、`ai_employees`（AI 员工基础实体，供知识库绑定）、`ai_employee_grants`（AI 员工使用授权，岗位/人双粒度）

**机制**：
- 证据链：quote 逐字核对 + 页码 + 字符区间，`verified` 布尔
- 确认门槛：`v_confirmable_cards` 视图（人工改过或有已核对证据 + 无冲突 + 未过期）
- 批次血缘：`ingest_run_id` 贯穿，支持整批撤回（已确认的卡不回滚）
- 混合检索：`pgvector` + 全文本 + RRF(60)，**SQL 里显式 `department_id = any()` + RLS 兜底**
- 回答审计：`qa_logs.invalid_cites` / `unverified_numbers`
- **AI 员工可见性（Fail-Closed 绝对隔离）**：`ai_employees` 的列表与详情必须经 RLS；未在 `ai_employee_grants` 中被授权的部门/人，API 与 UI 上完全不可见，连名称与描述摘要都不返回；**不做"目录全员可见"**
- **授权双粒度**：`ai_employee_grants` 支持 `department_id`（主，按部门/子树）与 `user_id`（例外，按人），同一 AI 员工可授权给多个部门

**验收**：中文同义改写能召回（原项目 TF-IDF 的失败点）；引用编号必须真实存在；未授权岗位查询 AI 员工列表返回 0 行

### M3 AI 运行时（本里程碑原大纲缺失，补齐）

**表**：`threads`（会话）、`runs`（一次执行）、`run_events`（事件流，带 `seq`）、`tool_calls`（工具调用与耗时）、`token_usages`（用量与成本）；并补齐 `ai_employees` 运行态字段（人格/系统提示、技能包、工具范围、模型参数、状态）

**机制**：
- `run_events.seq` 单调递增 → 断线按 `after=seq` 补发
- `runs.status` 状态机：`queued | running | interrupted | done | failed | cancelled`
- 启动时把所有 `running` 收口为 `interrupted`（原项目 `markForeignTurnsInterrupted` 语义，值得照搬）
- 取消：显式状态位，SSE 断开 ≠ 取消执行
- 长任务入口：`FOR UPDATE SKIP LOCKED` + 租约（`lease_until`），过期回收
- **实时推送**：PG 存事件做真源；单机用进程内 channel fan-out；横向扩展才切 `LISTEN/NOTIFY`（payload ≤ 8000B，无投递保证）

**验收**：杀进程重启后 run 标 `interrupted`；重连按 `seq` 续上，不重复不丢

> 详细规格：[Milestone3-运行态数据模型.md](Milestone3-运行态数据模型.md)
> 进程模型：**web 只受理，worker 执行**（同镜像不同 command），长任务绝不挂在请求生命周期上。

### M3.5 AI 员工派活（运行时的业务化）

> **边界**：AI 员工是执行体，不是聊天对象。对话属于 Agent 工作台；AI 员工接受工作、后台执行、产出可验收的交付物。

**表**：`work_items`（工作项：标题 / 说明 / 指派 AI 员工 / 派发人 / 优先级 / 截止 / 状态 / 当前 run / 交付物 / 验收）

**机制**：
- 一次派发 = `work_items` + `runs(kind='task')`；重做产生新 run，历史保留；
- 状态机：`queued → running → waiting_review → done / returned`（失败 / 取消如实落库）；
- 派发仅 L1 / 部门负责人；
- 验收方式按员工配置：人工验收（默认）或自动验收（字数门槛 + 无「待确认 / 待补充 / 无法确定」等未决标记）；
  派发时把验收门槛快照进 `work_items.input.review`，之后改员工配置不影响已发出的活；
- 自动验收未达标时仍转人工，并在验收备注里写明原因；
- 执行、事件、用量全部复用 M3（`runs / run_events / token_usages`），不另建执行引擎；
- AI 员工仍不携带数据权限，运行时继承派发者部门上下文。

**验收**：派活后 worker 能产出交付物并进入待验收；退回保留交付物；非 L1/部门负责人无法派活；越权部门读不到工作项；自动验收配置生效且被未决标记正确拦截。

### M4 MCP Hub 与工具治理

> **切片 1（已落地）**：JXF 作为 MCP Server 对外提供工具。`mcp_tokens` 绑定任用、只存 sha256；端点 `/api/mcp`（Streamable HTTP · JSON 响应 · 无会话）；工具 `knowledge.search / workitem.list / employee.list / workitem.assign`；`tools/list` 与 `tools/call` 双重 scope 校验；每次调用（含越权）写 `audit_events`；`/settings/mcp`（左侧导航 Agent 下方）签发 / 停用令牌（仅 L1，走 `token:issue` / `token:revoke`）。
>
> **切片 2（已落地）**：JXF 作为 MCP 客户端消费外部工具。`mcp_servers` + `mcp_server_calls`；http 连接器强制 SSRF 校验（域名解析后拦内网 / 回环 / 保留段，内网主机须显式列入 `MCP_TRUSTED_HOSTS`，禁止跟随重定向）；stdio 只允许 `MCP_STDIO_ALLOWED_COMMANDS` 白名单内的可执行文件且不使用 shell；支持工具探测与缓存、`tools/call` 测试调用、连接器工具白名单、超时与每分钟限流（以调用账本计数）；每次调用写审计。

**机制**：
- 官方 `@modelcontextprotocol/sdk` 做传输层（Streamable HTTP + stdio），管理端探测与 worker 运行时共用同一客户端封装
- 自研治理层：**六维 scope**（技能 / 产线 / 动作 / 直写 / 审批 / 客户端通道），六维全部可判定
- 令牌只存 sha256 + 常数时间比对 + 轮换
- **令牌绑定任用，离岗自动失效**（比过期更强）
- 连接器：白名单 + 复用 SSRF 防护 + 管理员闸门（原项目此接口可 spawn 任意命令，属高危）
- **工具 id 单段命名，禁止 `.`，不做 `.` ↔ `_` 往返**

> **切片 3（已落地）**：外部工具接入 AI 员工运行时。员工 `allowed_tools` 可勾选连接器工具（存 `mcp:<serverId>:<toolName>`，受理时快照进 `runs.input.employee`）；worker 在 `kind='task'` 执行中走工具对话（最多 4 轮 / 10 次调用），模型看到单段别名，调用结果回灌后产出交付物；每次调用同时写 `tool_calls`（运行审计，含参数脱敏）与 `mcp_server_calls`（连接器账本与限流）。

> **切片 4（已落地，M4 收官）**：官方 SDK 替换自研 JSON-RPC（`Client` + `StreamableHTTPClientTransport` / `StdioClientTransport`），管理端与 worker 共用一条连接链路；六维 scope 全部落地——`skills` 能力域、`pipelines` 可派活的 AI 员工白名单、`tools` 精确工具白名单、`allowWrite` 直写、`approvalTools` 逐工具审批（`*` = 全部写类）、`channels` 客户端通道（`x-mcp-client` / User-Agent 首段）；命中审批维的写类工具不直接执行，落 `mcp_tool_approvals` 待审单，L1 在 `/settings/mcp` 批准后按**令牌绑定的任用身份**执行并留档；连接器新增每日调用配额（`mcp_servers.daily_quota`，0 = 不限），管理端与 worker 双路径统一校验。

**验收**：外部客户端能连、越权工具不可见、工具不可被改写调用；通道不符被 403 拒绝；审批维命中的写类工具不执行且可在管理页批准；每日配额用尽后调用被拒并记账

### M5 治理面与交付

> **切片 1（已落地）**：交付底座。`app_versions` 版本表由迁移容器写入（版本 / Git SHA / 迁移摘要），健康检查暴露 `db_version` 与 `schema` 检查；`npm run backup` 产出 PG 逻辑备份 + MinIO / uploads 卷归档 + manifest（校验和、关键表行数、版本），`--cold` 停应用做一致性快照；`npm run restore -- --verify` 做影子库恢复演练并比对行数，`--yes` 重建数据库 + 还原卷 + migrate + 健康检查；`npm run upgrade` 依次执行升级前备份、旧镜像打 `rollback-<stamp>` 标签、构建、migrate 门禁、拉起与健康检查，并写 `backups/upgrade-<stamp>.json`；`npm run rollback -- --state ... --yes` 用旧镜像 + 升级前备份完成回滚。

> **切片 2（已落地，M5 收官）**：交接包导出（`/api/handover/export`，JSON 附件，含成员、资产、工作项、MCP 令牌前缀、待审单与审计轨迹，导出动作写 `handover.exported`）；审计导出（`/api/audit/export`，JSONL / CSV，CSV 公式注入防护，保留 `audit.exported` 留痕）；审计留存清理（`npm run audit:prune`，默认 365 天，清理后写 `audit.retention_pruned`）；授权收口体检（`npm run audit:grants`：目录漂移、过期授权、孤立账号、未上线员工授权）；部署冒烟（`npm run smoke`）与一键验收（`npm run verify:delivery`）。

**后续（P5 设置面）**：

> **切片 1（已落地）**：`/settings` 平台设置（仅 L1，`platform:settings` 守卫）统一承载四块：品牌（站点名 / 副标题 / 四档品牌色入库；root layout 注入 CSS 变量与 metadata，登录页与侧栏同步，保存后下一次页面加载生效）、模型 Key（Base URL / 双模型 / 启用开关；Key 以 AES-256-GCM 加密入库，只显示末 4 位；Web 进程保存后热生效，Worker 重启加载）、审计与留存（事件总数、最早事件、留存天数入库；`audit:prune` 取值优先级 命令行 > 设置面 > 环境变量）、交付与备份（只读展示 `backups/` manifest 与升级状态，Web 容器只读挂载备份目录）。`app_settings` 单行表读写均限 L1；`app.public_branding()` 供登录页匿名读取，`app.runtime_settings()` 只返回密文；所有变更写 `settings.*` 审计。

> **切片 2（已落地）**：运维任务。`ops_tasks` 单表 + RLS（L1 可发起/查看，业务角色不能改状态）；Web 不持有 docker 权限，设置页只落单 `backup` / `restore_verify`（参数仅 `cold`），宿主机 `npm run ops:runner`（常驻或 `--once` 交给 cron）用 owner 连接领取（`FOR UPDATE SKIP LOCKED`），执行白名单脚本并把 `result` / `error` 回写；设置页 5 秒自动刷新任务状态。runner 启动时把中断的 running 任务收口为 failed，避免假运行。

> **切片 3（已落地）**：连接器批量心跳与降级。`mcp_servers` 新增 `health_status`（unknown / healthy / degraded / down）、`health_checked_at`、`health_latency_ms`、`health_consecutive_failures`、`health_last_error`；`src/lib/mcp/health.ts` 统一探测链路（复用 `listTools`），连续失败 1–2 次降级、≥3 次熔断，状态迁移写 `mcp.connector_unhealthy` / `mcp.connector_recovered` 审计；worker 构建工具计划时排除 `down` 连接器（失败降级）；设置页 `/settings/mcp` 支持「批量体检」与异常横幅；宿主机 `ops:runner` 每 5 分钟自动体检（`MCP_HEALTH_INTERVAL_MS`），可选 `MCP_ALERT_WEBHOOK` 推送告警。

> **切片 4（已落地）：自动化产线（最小可用）**：`pipelines` + `pipeline_runs`；产线 = 有序派活步骤（最多 10 步），每一步创建 `work_item` + `kind='task'` 的 run，复用现有队列与人工验收；`/pipelines` 提供定义、运行与进度聚合，左侧导航「自动化」正式启用。

> **切片 5（已落地）：产线进阶**：运行只派第一步，之后由宿主机 `ops:runner`（`PIPELINE_TICK_MS`，默认 60 秒）在「上一步进入终态」后派下一步；步骤说明支持 `{{previous}}` 引用上一步交付文本（无交付时显式注明，不编造）；步骤可标记 `optional`，失败时跳过并继续，跳过清单记录在 `pipeline_runs.skipped_steps`；产线可设置 `schedule_interval_minutes`（5–10080），到点自动运行（`trigger_kind='schedule'`），同一时间窗不重复触发。

> **切片 6（已落地）：邮件通知**：新增 SMTP 配置（设置面优先，`SMTP_*` / `NOTIFICATION_EMAIL_TO` 环境变量兜底），口令与模型 Key 一样 AES-256-GCM 加密入库；`src/lib/notifications/mailer.ts` 基于 nodemailer 统一发送，未配置时安静跳过、发送失败只落日志；连接器 degraded / down 熔断与恢复、运维任务失败、产线失败自动发出含错误详情的邮件。设置页新增「邮件通知」区块与测试发送。

> **切片 7（已落地）：安装向导与可观测性**：`npm run setup` 从 `.env.example` 生成 `.env`（随机密钥/口令、占位值检查、覆盖前自动备份、Node/docker 前置检查）；`GET /api/metrics` 返回聚合指标（JSON / Prometheus 文本，可选 `METRICS_TOKEN`），数据来自 SECURITY DEFINER 的 `app.metrics_snapshot()`，只含计数不含明细；`docs/operations/observability.md` 给出探针、抓取与告警规则。

> **切片 8（已落地）：产线事件触发**：外部 Webhook `POST /api/webhooks/pipelines/:id`，每产线独立令牌（库内只存 SHA-256 哈希，恒定时间比较），以产线发起人上下文运行；内部事件总线 `pipeline_events` + `pipeline_event_subscriptions`，接入 `knowledge.ingest_done` / `mcp.connector_changed` / `work_item.finished` 三类事件，由 `ops:runner` 按订阅派发（最多重试 3 轮）；运行记录新增 `trigger_kind` 的 `webhook` / `event` 与 `trigger_ref` 追溯字段。使用说明见 `docs/operations/pipeline-triggers.md`。

> **后续切片**：通知渠道扩展（飞书/企微卡片）；产线条件分支与人工卡点。

---

## 3. 生产环境工程硬红线

### 3.1 数据库与权限

| # | 红线 | 违反后果 |
|---|---|---|
| 1 | 应用连接**禁止使用 owner / superuser**，必须用受限业务角色 | RLS 对 owner 默认不生效，整套隔离静默失效 |
| 2 | PgBouncer 只能 **Transaction Pooling** | Session Pooling 会把上一个用户身份泄漏给下一个请求 |
| 3 | 每个请求一个事务，事务内 `SET LOCAL app.user_id / tenant_id / access_level / department_ids` | 未注入 → 应 0 行，不得报错降级 |
| 4 | 策略里禁止逐行 join `memberships` | 每行一次的 N+1，检索场景直接超时 |
| 5 | AI 员工可见性必须走 RLS，默认不可见；**禁止"目录全员可见"** | 未授权者可通过名称/描述探测 AI 员工，造成信息泄露 |

### 3.2 应用与部署

| # | 红线 | 说明 |
|---|---|---|
| 5 | Fail-closed 启动校验 | `JXF_AUTH_SECRET` 缺失/过短/弱值 → 拒绝启动（原项目 `auth.ts` 这点做对了，继承） |
| 6 | 迁移必须幂等 + 独立容器 | 否则"一键上线"不成立；`up` 重复执行不得产生变更 |
| 7 | 结构化日志 + `request_id` / `run_id` 贯穿 | 私有化现场排障唯一手段 |
| 8 | Python Worker 不持数据库凭据 | 只读对象存储、输出 JSON；入库由 TS 以用户身份完成 |
| 9 | 解析在 TS，OCR/媒体在 Python | 解析产物要写库（须走 RLS）；OCR 只产出文本 |
| 10 | 验证码、租约、幂等键一律落 PG | 原项目存进程内 Map，重启即丢 |

### 3.3 反模式清单（来自原项目真实事故）

- ❌ 靠中间件兜授权（原项目 2/3 API 无岗位校验）
- ❌ 用客户端可写的 header 当身份输入（`x-fde-tenant`）
- ❌ 回环地址免鉴权后门
- ❌ 仓库内工具表快照当对外真相源（会过期）
- ❌ 把内部密钥写进 `/tmp` 供进程 `cat`
- ❌ 令牌放 URL query（进日志/Referer）

---

## 4. 推进流程（Phase 0–5）

> 与原大纲的差异：**认证前移至 P1**（否则越权测试无法在真实身份下验证）、**MCP 后移至 P4**（工具最终在运行时里被调用与审计）、**新增 P3 运行态**。

### Phase 0 · 环境底座
- 自建 PG 镜像（pgvector + pg_bigm）、compose（web / caddy / migrate / postgres / minio）、健康检查、日志格式
- **出口**：空库可启动，`up` 幂等

### Phase 1 · 组织治理 + 身份链路
- departments / department_closure / memberships / department_packs
- 用户表 + 会话签发 + `SET LOCAL` 注入链路
- RLS 策略 + `SECURITY DEFINER` 函数 + `v_*` 视图
- **出口**：§5.1 十条全绿

### Phase 2 · 知识治理
- assets / documents / chunks / cards / evidence / ingest / regression
- 混合检索 + 引用校验 + 确认门槛
- **出口**：§5.2 通过

### Phase 3 · AI 运行时
- threads / runs / run_events / tool_calls / token_usages
- 断线续流、重启收口、取消、租约队列
- **出口**：§5.3 通过

### Phase 4 · MCP Hub
- 官方 SDK 双端、令牌 scope、连接器白名单/SSRF、presence
- **出口**：§5.4 通过

### Phase 5 · 治理面与交付
- audit_events、grants、交接包、备份/升级/回滚
- **出口**：§5.5 通过

### 4.1 UI 交付策略（垂直切片，非独立阶段）

UI 不做独立阶段，而是**在每个 Phase 内先行**，顺序固定为：

```
① 页面骨架 + 假数据（确认界面成立）
② 写后端（表 + API，此时才动手）
③ 接真数据 + 补边界（空态 / 错误 / 慢）
④ 人工闸门
```

理由：原项目"后端全做完再拼 UI"，接口形状被 UI 需求反复倒逼；而"完全 UI 先行到极致"又会在没有数据约束时过度设计。所以是**交替推进**，不是任一方向走到底。

| Phase | UI 交付物 | 必要性 |
|---|---|---|
| P0 | `/health` 页面 + 全局错误页 | 健康检查与冒烟的落点 |
| **P1** | 登录页 + 岗位树管理 + 「我的权限」调试页 | 越权测试可视化；比 psql 手工 `SET LOCAL` 更接近真实链路 |
| P2 | 上传/解析进度 + 卡片确认（pending→confirmed）+ 缺口列表 + 证据高亮到页码 | 「人工确认」是核心交互；只给 API 等于没做 |
| P3 | 对话页：流式输出、思考过程、工具调用、断线重连、中止、历史 | 原项目 `chat-sse.ts` 归约函数可直接搬 |
| P4 | MCP 连接器管理 + 令牌签发向导（六维 scope）+ 在线状态 | 六维 scope 无可视化必然签错 |
| P5 | 审计视图 + 交接导出 + 设置（品牌 / 模型 Key） | 合规与交付面 |

**三条 UI 原则**

1. **UI 不做权限判断**：只渲染数据库已授权返回的数据；前端 `canRead` 分支不得作为安全手段。
2. **UI 不持有业务规则**：确认门槛在 `v_confirmable_cards` 视图内，UI 只调用 action。
3. **骨架先出，页面后填**：P1 建好 layout / 导航 / 加载态 / 错误边界，后续里程碑只填页面。

**信息架构（一级导航，按使用频次排序）**

| 一级 | 装什么 | 对应 Phase |
|---|---|---|
| 工作台 | 通用 Agent 对话、run 历史、执行事件、中止与重连 | P3 |
| 知识库 | 文档、卡片（待确认 / 已确认）、缺口、回归 | P2 |
| 组织与岗位 | 部门树、成员名片（等级 + 姓名 · 业务岗位）、部门包 | P1 |
| AI 员工 | 目录、使用授权（岗位/人）、派活、执行跟踪与人工验收 | P2 Schema / P3 运行态 / M3.5 派活 |
| 自动化 | 产线定义（有序派活步骤）、定时/链式推进、可选步骤与进度聚合 | P5 |
| MCP 连接 | 对外令牌、外部连接器、调用审计与限流（左侧导航位于 Agent 下方） | M4 |
| 技能 | 原子能力目录、工具包、MCP 工具可见性 | P4 |
| 设置 | 品牌、模型 Key、审计、备份 | P5 |

**三条约束（否则 5 项会退化成原项目那样"找不到东西"）**

1. **每项只承载一个明确动作**。「组织与岗位」承载岗位树、成员与角色包，页内 Tab 默认落「岗位树」；「AI 员工」是独立一级项，承载 AI 员工目录、使用授权与派活验收，**不得混入岗位树**。
2. **每项必须挂待办数字**：知识库「待确认 N」、AI 员工「待审批 N」、工作台「失败 run N」。否则确认流程无人发现。
3. **「我的权限」不进导航**，放顶栏用户菜单；它是 P1 的验收入口，不是日常功能。

**明确不设一级入口**：运行历史（归入工作台）、令牌签发（归入 MCP 连接）、用量与成本（归入设置或员工详情）、图谱（M4 后作为知识库内的局部视图）。

**UI 全量重做约定（不复用原项目组件与样式）**

| 项 | 决定 |
|---|---|
| 组件 | 全部重建，不移植原项目 `components/` 下任何组件 |
| 样式 | 不参考 `lx.css` / `theme.css` / `portal.css`；以 Tailwind v4 + design token 重建 |
| 唯一可借鉴的 | `chat-sse` 的**事件归约思路**（纯函数语义）与权限相关数据形状，作为参考而非代码 |
| 原因 | 原 UI 与旧 API 形状（全量树、十几类 SSE 事件）强耦合，移植等于把旧信息架构一起搬过来 |

**重做必须避开的 5 个旧问题**

1. 单页面巨石（原 `workbench/page.tsx` 数千行）→ 按 route segment 拆，数据获取下沉到 Server Component
2. 前端算权限 → 后端返回"已授权结果"，前端只渲染
3. 一次拉全量树 / 全量图谱 → 服务端分页 + 懒加载 + 虚拟滚动
4. 前端持有业务规则（如"能否确认"）→ 由视图与 action 决定
5. 品牌色硬编码 → 全部走 `--brand-*` CSS 变量（私有化交付需按客户换肤）

### 4.2 防「后端先行」返工机制

**事故复盘**：原项目先做后台半个月，接 UI 时发现无法继续。四个机制性原因——

1. API 形状按后端方便设计（全量树 / 全量聚合 JSON / 十几类 SSE 事件），界面需要的游标分页、单条详情、增量更新都不存在
2. 业务规则前后端各写一份（确认门槛、权限、能否 ship），两边漂移
3. 没有 run / step 状态机，界面只能从事件流反推进度
4. 单页面巨石 + 无组件基线，改 A 坏 B

**六条硬机制（可检查，不停留在原则）**

| # | 机制 | 落地形式 |
|---|---|---|
| 1 | **无 UI 消费者的接口不写** | 每个后端能力必须指明对应页面；3 个里程碑内无消费者的不做 |
| 2 | **假数据先行（P0.5 Spike）** | 登录 / 组织树 / 对话 / 卡片确认四屏，用 mock 走完整点击路径，2–3 天，失败可丢弃 |
| 3 | **API 形状由界面定义** | 只允许 **游标列表 / 单条详情 / 命令动作** 三类；禁止全量树与全量聚合；必须带分页、字段裁剪、空态语义 |
| 4 | **状态机驱动 UI** | 进度直接映射 `runs.status` 与 `run_steps`；前端禁止自行推导状态 |
| 5 | **组件基线与文件上限** | 先定 10 个基础组件，页面不得自定义样式；单页 ≤ 300 行，超出必拆 |
| 6 | **2 天规则** | UI 需要新数据形状 → 立刻改后端，不允许"先绕过"。绕过一次必然成为常态——这是原项目卡死的直接原因 |

**P0.5 · UI 骨架与最小闭环 Spike（新增，位于 P0 与 P1 之间）**

- 用假数据打通四屏：登录、岗位树、对话、卡片确认
- 目的：在写任何业务后端之前，先验证信息架构与交互是否成立
- 出口：能连续点击走完「登录 → 选员工 → 提问 → 看证据 → 确认卡片」，无需数据库

**阶段出口一律改为「可演示」**

| Phase | 出口（由非开发者验证） |
|---|---|
| P0 | 浏览器可打开 health 页与错误页 |
| P0.5 | 四屏假数据原型点通 |
| P1 | 登录 → 建岗位 → 切身份 → 亲眼看到读不到数据 |
| P2 | 上传 PDF → 看到卡片 → 确认 → 提问得到带页码的答案 |
| P3 | 对话中断网 30 秒 → 重连继续，不丢内容 |
| P4 | 外部客户端连上，但看不到越权工具 |
| P5 | 一键升级 + 回滚演练通过；设置面保存品牌 / 模型 Key 后刷新即生效；备份与恢复演练可从设置页发起并看到状态 |

### 4.3 阶段准入、版本管理与 Token 纪律

#### 4.3.1 人工闸门（Hard Gate）

**任何阶段未通过人工检测，不得开始下一阶段的任何代码。**

| 规则 | 说明 |
|---|---|
| 验收主体 | 用户本人在浏览器中逐条操作确认，**不接受"AI 自评通过"** |
| 验收载体 | `docs/gates/P{n}-gate.md`：交付物清单、操作步骤、逐条勾选、不通过项、日期 |
| 通过动作 | 打 tag `gate/p{n}-passed` 并 push（见 4.3.2） |
| 不通过处理 | 只修复闸门文件里的"未通过项"，**不扩大范围**（防止范围蔓延） |
| 阶段起点 | 进入新阶段前工作区必须干净（已 commit），避免与上一阶段混改 |

闸门文件只需四块内容，不写长文：

```
## 交付物
## 验收步骤（可照着点的路径）
- [ ] 步骤 1 …
## 不通过项
## 结论：通过 / 不通过（日期）
```

#### 4.3.2 Git 策略

| 事件 | 动作 |
|---|---|
| 阶段内的小改 | **本地 commit，不 push**（`git add <具体文件>`，不用 `-A`） |
| 阶段出口通过人工闸门 | 打 tag `gate/p{n}-passed` → push 分支 + tag |
| 阶段内修 bug | 本地 commit |
| 已通过阶段的线上问题 | 单独分支修复，修完补 tag 递补，不改历史 |
| 提交粒度 | 一个可回滚的改动 = 一个 commit；message 说"为什么"，不说"改了什么" |

**仓库红线**（原项目教训）：

- 禁止提交 `.env*`、数据卷、上传原件、`node_modules`、构建产物
- 禁止在 `main` 上直接开发；`main` 只接受合并
- 推送前必须确认没有把密钥带进 diff

**tag 的作用**：任何时刻都能回到"最后一个经人工验收可用"的状态。

#### 4.3.3 Token 纪律

| # | 规则 | 做法 |
|---|---|---|
| 1 | **一次只推进一个阶段的一个子任务** | 不跨阶段混合提问；大任务先拆再问 |
| 2 | **定点读取，不整文件通读** | 先 `grep` 定位行号，再读片段；已知路径直接读，不先搜索 |
| 3 | **不贴长日志/长源码** | 报错只给关键行 + 前后 20 行；结论优先于过程 |
| 4 | **需求一次说清** | 模板：目标 / 范围 / 明确不做 / 验收方式 |
| 5 | **两次失败即换方法** | 同一命令或同一假设失败 2 次，停止重试，改假设 |
| 6 | **先方案后动手** | 复杂改动先出 3–5 行方案确认，再写代码（一轮确认省三轮返工） |
| 7 | **结论落盘，不靠对话记忆** | 每个阶段结束把结论写进 `docs/`，新会话不必重述背景 |
| 8 | **不重写大文件** | 用定向替换，禁止让 AI 整文件重写 |
| 9 | **文档最小化** | 每个里程碑只保留：一份规格 + 一份闸门记录，不产出过程稿 |
| 10 | **不生成演示用假数据文档** | 假数据写进代码或脚本，不写进 md |

> 判断标准：**一次会话应当能在一屏内说清"这次要做什么、做完是什么样"**。说不清就说明任务没拆够。

#### 4.3.4 推进授权（不得私自推进）

**没有用户明确同意，一律不推进项目。** 本条规定优先于任何"看起来明显该做"的判断。

| 禁止（未获同意时） | 允许（无需同意） |
|---|---|
| 创建/修改任何源码、配置、迁移文件 | 只读阅读代码 |
| 执行 `docker`、`npm/pnpm install`、`git add/commit/push` 等写操作 | 只读查询（ls/grep/read） |
| 开始任何 Phase 的任何一个步骤 | 分析、评审、回答问题 |
| 顺手"补全"缺失文件或脚手架 | 在你指定的路径写你要求的文档 |

**UI 提醒（强制前置）**

进入任何 UI 工作（P0.5 与每阶段的「① 页面骨架 + 假数据」）之前，必须先发出提醒并等待确认：

```
【UI 提醒 · P{n}】
要做的页面：
假数据范围：
产出文件：
验收方式：
—— 等你确认后再动手
```

规则：

1. 同一阶段内，若中途发现需要新增/改动页面，**同样要先提醒**，不能"顺手加一页"。
2. 提醒中若包含范围变化（超出该阶段闸门清单），必须标注「范围变更」并单独确认。
3. 未收到明确肯定的回复（如"开始""可以"），视同未授权，保持只读。

---

## 5. 验收标准（Acceptance Criteria）

> 原则：**数据库为唯一权威**；中间件 403 只是体验优化，去掉中间件后行为必须一致。

### 5.1 安全隔离（M1 准入）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 兄弟部门成员互相读对方部门数据 | 0 行 |
| 2 | 上级部门（L1/L2）读自身及全部子部门 / 小组 | 可见 |
| 3 | L3 读未授权部门 | 0 行 |
| 4 | **离岗后同会话下一次请求** | 0 行（不依赖 token 过期） |
| 5 | L3 读审计 | 拒绝；L1 可读 |
| 6 | 显式传他人 `department_id`（IDOR） | 0 行，不泄露存在性 |
| 7 | 删除最后一个 L1 | 事务回滚 |
| 8 | **未注入 `app.user_id`** | 0 行，**不报 500、不放行** |
| 9 | 用 owner/superuser 连接 | 部署配置层面即不允许（`DATABASE_URL` 不含高权账号） |
| 10 | 去掉中间件后重跑 1–8 | 结果完全一致 |

### 5.2 知识治理（M2）

同义改写中文查询能召回；扫描件标 `needs_ocr` 不生成 chunk；AI 卡无证据不可确认；冲突卡不可确认；撤回批次不影响已确认卡；引用编号校验生效；换 chunk 策略后回归 `retained ≥ 0.9` 才允许合并。

### 5.3 运行时（M3）

杀进程重启 → `running` 收口为 `interrupted`；重连按 `seq` 续发，不重不漏；用户取消后不再产生新事件；租约过期任务被重新排队；每次模型调用都有 `token_usages` 记录。

### 5.4 MCP（M4）

外部客户端可完成 `initialize → tools/list → tools/call`；越权工具不可见；离岗后令牌立即失效；连接器不能指向内网/回环（SSRF）；工具 id 在任何传输层不被改写；六维 scope、每日配额与逐工具审批都在调用前判定。

### 5.5 交付（M5 / 总验收）

- **一键**：干净 Linux 宿主机执行 `docker compose up -d` → 全部 healthcheck 通过 → 冒烟脚本通过
- **幂等**：重复执行 `up` 不产生任何变更；迁移可重复执行
- **冒烟链路**：注册 → 登录 → 建岗位 → 上传 PDF → 提问命中并带页码 → 换岗位查询返回 0 行
- **升级**：版本表 + 迁移执行 + 失败回滚演练通过
- **备份**：数据卷与对象存储备份可恢复演练通过
- **一键验收**：`npm run verify:delivery`（守卫 + 类型 + 冒烟 + 授权体检）全绿

> 不写死"2 分钟"。干净机器光拉镜像就超时，时间不是可重复指标；以 healthcheck + 冒烟脚本为准。

---

## 6. 风险登记册

| 风险 | 触发信号 | 应对 |
|---|---|---|
| RLS 在索引后过滤导致召回下降 | 部门多时检索结果变少 | 显式 `department_id = any()` + 部门分区 / partial index |
| 中文分词扩展缺失 | 迁移后中文检索退化 | P0 就自建镜像验证，不等到 M2 |
| Python 边界重新膨胀 | 出现"Python 读写知识表"的需求 | 一律拒绝，改为纯函数 + TS 入库 |
| 升级把客户数据搞坏 | 出现手工改库 | 迁移只增不改，破坏性变更走两段式发布 |
| 运行时被塞进请求生命周期 | `void run()` 式脱钩 | 统一走 `runs` 表 + worker 拉取，请求只负责受理 |
| 静态工具目录与实现漂移 | 外部客户端看到过期工具 | 工具表运行期生成，不落仓库 |

---

## 7. 与原大纲的差异（可追溯）

| 项 | 原大纲 | 本文件 | 原因 |
|---|---|---|---|
| 里程碑 | M3 = 运行时 + MCP 合并 | 拆为 M3 运行时、M4 MCP | 合并后无可验收产物；MCP 依赖运行时 |
| 运行态表 | 未列 | 新增 threads/runs/run_events/tool_calls/token_usages | 断线续流、重启收口、成本核算的载体 |
| 认证阶段 | Phase 2 | 前移至 P1 | 真实身份下才能验证越权 |
| 迁移容器 | 未列 | P0 必含 | 否则一键上线不成立 |
| 对象存储 | 未列 | P0 必含 MinIO | 知识库原件无处可放 |
| PG 镜像 | "带 pgvector" | 自建（+ 中文分词） | 官方镜像无 zhparser/pg_bigm |
| 备份升级 | 未列 | M5 | 私有化交付的最大运维成本 |
| 验收表述 | "DB 或中间件拦截" | "DB 为唯一权威" | "或"会导致实施退化 |
| 验收表述 | "2 分钟内上线" | healthcheck + 冒烟 + 幂等 | 时间不是可重复指标 |
| 验收表述 | "不存在下划线 bug" | 工具 id 单段命名，杜绝该类问题 | 用设计消除，而非用测试证明不存在 |
| Python 职责 | 含"PDF/Word 解析" | 仅 OCR/音视频 | 解析要写库，必须走 RLS |
| 验证码存储 | 未明确 | 落 PG（TTL + 失败计数） | 原项目存内存，重启即丢 |

---

## 8. 附录

### 8.1 目录结构

```
jxf-ai/
├── docker/            compose、Dockerfile（web / pg / worker）、caddy
├── db/
│   ├── schema/        Drizzle 表定义
│   ├── policies/      RLS、函数、视图（原生 SQL，幂等）
│   └── seed/          dev 种子：最小岗位树 + 样例文档
├── src/
│   ├── app/           Next.js App Router（页面 + Route Handler）
│   ├── lib/db/        连接、事务、SET LOCAL 注入
│   ├── lib/auth/      会话（库封装，不自研）
│   ├── lib/knowledge/ 解析、切块、证据核对（移植原项目 A 级资产）
│   ├── lib/runtime/   runs、事件、租约
│   └── lib/mcp/       scope、token、channel（治理层）
├── scripts/           冒烟、备份、升级
└── docs/architecture/ 本文件与里程碑规格
```

### 8.2 从原项目直接移植的 A 级资产（零改造）

`scope.ts` / `scope-templates.ts`（六维授权）、`evidence.ts`（逐字核对）、`text-extract.ts`（格式分派 + 编码探测 + PDF 分页）、`kinds.ts` / `categories.ts` / `scout-rules.ts`、`graph-extract.ts`、`access-level.ts`（L1/L2/L3 + 保护区）、`chat-sse.ts` / `chat-history-merge.ts`（事件归约纯函数）、`sdk-config.ts`。

> 原则：**语义迁移，不是代码迁移**。原项目 90% 的价值在数据模型、业务规则与提示词纪律，10% 在代码。
