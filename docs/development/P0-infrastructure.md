# P0 环境底座 · 开发过程记录

> 阶段：Phase 0（环境底座与容器编排）
> 日期：2026-10-30
> 状态：**已通过（2026-10-30；tag `gate/p0-passed`）**
> 依据：[master-plan.md](../architecture/master-plan.md) §1.3 / §3 / §4 / §8.1

---

## 1. 结论摘要

| 交付项 | 状态 | 说明 |
|---|---|---|
| `docker/docker-compose.yml`（6 个服务） | 已完成 | web / caddy / migrate / postgres / minio / minio-init |
| 自建 PostgreSQL 16 镜像（pgvector + pg_bigm + pg_trgm） | 已完成（未实构建） | 多阶段构建，扩展版本已锁定 |
| Caddy 反向代理 + JSON 访问日志 | 已完成 | 默认 `:80`，可按环境变量切域名 / TLS |
| migrate 一次性迁移容器（drizzle + policies） | 已完成 | 幂等，失败退出码 1 |
| MinIO + 桶初始化 | 已完成 | 控制台 / API 仅绑定回环地址 |
| `.env.example` 环境变量模板 | 已完成 | 含 fail-closed 说明与逐项注释 |
| `/health` 页面 + 全局错误页 + 健康接口 | 已完成 | 本地构建与冒烟已通过 |
| 验证脚本 `scripts/verify-p0.sh` | 已完成 | 覆盖空卷启动、健康检查、幂等性 |
| **`docker compose up` 实跑 + 幂等性实测** | **已通过** | Docker Desktop 29.9.2（linux）/ Compose v5.6.1，见 §4.3 |
| `docs/development/P0-infrastructure.md` | 已完成 | 本文件 |
| 人工闸门 | 已通过 | tag `gate/p0-passed`，见 [P0-gate.md](../gates/P0-gate.md) |

**结论**：`docker compose up -d --build` 在空数据卷上一次性拉起 6 个服务，postgres / minio / web / caddy 全部 healthy；迁移容器与桶初始化容器退出码 0；经 Caddy 访问 `/api/health` 返回 200；二次 `up -d` 容器 ID 与 `StartedAt` 完全不变，迁移记录仍为 1 条。**「空库可启动、up 幂等」已实测达成**，P0 闸门已通过并打 tag。

---

## 2. 架构落地现状

### 2.1 容器拓扑

```
                        ┌─────────────────────────────┐
  浏览器 / 外部客户端 → │ caddy :80/:443              │  edge 网络
                        │ 反向代理 + TLS + JSON 日志  │
                        └──────────────┬──────────────┘
                                       │ reverse_proxy web:3000
                        ┌──────────────▼──────────────┐
                        │ web  Next.js standalone     │  edge + internal
                        │ 唯一对外业务入口             │
                        └───┬──────────┬──────────┬───┘
                            │          │          │
              ┌─────────────▼──┐  ┌────▼─────┐  ┌─▼────────────┐
              │ postgres       │  │ minio    │  │ migrate      │
              │ 自建镜像        │  │ 对象存储 │  │ 一次性迁移    │
              │ pgvector/bigm  │  │ + 桶初始化│  │ drizzle+policies│
              └────────────────┘  └──────────┘  └──────────────┘
                       internal 网络（不对宿主机公网暴露）
```

### 2.2 容器职责与依赖

| 服务 | 镜像 | 职责 | 网络 | 对外端口 | 重启策略 | 依赖（严格） |
|---|---|---|---|---|---|---|
| `postgres` | 本地构建 `jxf-ai/postgres:16-p0` | 关系数据、RLS、向量/中文检索扩展 | internal | `127.0.0.1:5432`（排障） | unless-stopped | — |
| `migrate` | 本地构建 `jxf-ai/migrate:0.1.0` | drizzle 迁移 + `db/policies/*.sql` | internal | 无 | `no`（一次性） | postgres(healthy) |
| `minio` | `bitnamilegacy/minio:2024.12.18` | 原件 / 导出包对象存储 | internal | `127.0.0.1:9000/9001` | unless-stopped | — |
| `minio-init` | `bitnamilegacy/minio:2024.12.18`（内置 mc） | 幂等创建桶、设为私有 | internal | 无 | `no`（一次性） | minio(healthy) |
| `web` | 本地构建 `jxf-ai/web:0.1.0` | Next.js 15 唯一业务入口、健康检查 | edge + internal | 仅 `expose 3000` | unless-stopped | postgres(healthy)、migrate(completed)、minio(healthy)、minio-init(completed) |
| `caddy` | `caddy:2.8.4-alpine` | 反向代理、TLS、JSON 访问日志 | edge | `80` / `443` | unless-stopped | web(healthy) |

依赖链（启动顺序）：

```
postgres(healthy)
   ├── migrate(service_completed_successfully) ──┐
minio(healthy)                                    ├── web(healthy) ── caddy
   └── minio-init(service_completed_successfully)─┘
```

> Master Plan §1.3 要求的 `web depends_on migrate(service_completed_successfully) + postgres(healthy)` 已显式满足；额外加入 MinIO 两项依赖，避免 web 在桶未就绪时被判定为 ready。

### 2.3 网络与数据卷

| 名称 | 类型 | 用途 | 说明 |
|---|---|---|---|
| `edge` | bridge | caddy ↔ web | 只有反代与应用入口 |
| `internal` | bridge | web / postgres / minio / migrate | 数据面全部隔离，不接入 edge |
| `pgdata` | volume | PostgreSQL 数据目录 | 空卷即触发 initdb |
| `miniodata` | volume | 对象存储数据 | |
| `caddy_data` / `caddy_config` | volume | Caddy 证书与配置状态 | TLS 时保留 |

**端口暴露原则**：只有 Caddy 的 80/443 面向宿主机；PostgreSQL / MinIO 端口绑定 `127.0.0.1` 仅作运维排障，业务流量全部走容器网络。

---

## 3. 核心配置文件

### 3.1 目录结构（已落地）

```
JXF-AI/
├── docker/
│   ├── docker-compose.yml        # 6 服务编排
│   ├── Dockerfile.postgres       # PG16 + pgvector + pg_bigm（多阶段）
│   ├── Dockerfile.web            # Next.js standalone 运行镜像
│   ├── Dockerfile.migrate        # 一次性迁移镜像
│   ├── Caddyfile                 # 反代 + JSON 日志 + 安全响应头
│   ├── postgres/00-init.sh       # initdb：扩展 + 角色 + 收权
│   ├── postgres/healthcheck.sh   # 实例可连 + 三扩展齐全
│   └── migrate/entrypoint.mjs    # drizzle migrate + policies 执行器
├── db/
│   ├── migrations/               # drizzle SQL 迁移（含 P0 基线）
│   │   ├── 0000_p0_baseline.sql
│   │   └── meta/_journal.json
│   ├── policies/                 # RLS / 函数 / 视图（P1 起填充，幂等 SQL）
│   └── schema/                   # Drizzle 表定义（P1 起填充）
├── src/
│   ├── app/                      # /health 页面、/api/health、全局错误页
│   ├── lib/db/pool.ts            # pg 连接池（仅业务角色）
│   ├── lib/env.ts                # 启动期 fail-closed 校验
│   ├── lib/logger.ts             # 单行 JSON 日志
│   ├── lib/health.ts             # 就绪检查
│   ├── instrumentation.ts        # 启动校验 + service_start 日志
│   └── middleware.ts             # request_id 生成与注入
├── scripts/verify-p0.sh          # P0 验收脚本
├── .env.example
├── drizzle.config.ts
├── package.json / package-lock.json
└── docs/development/P0-infrastructure.md
```

### 3.2 `docker/docker-compose.yml`

| 配置 | 取值 | 目的 |
|---|---|---|
| `name` | `${COMPOSE_PROJECT_NAME:-jxf-ai}` | 固定项目名，卷与网络可预测 |
| 构建上下文 | `..`（仓库根目录） | Dockerfile 在 `docker/`，源码在根目录 |
| 日志驱动 | `json-file`，`max-size=20m`，`max-file=5` | 防止私有化现场磁盘被日志打满 |
| 必填变量 | `${VAR:?消息}` | 缺变量时 Compose 直接失败，不生成半配置 |
| 一次性容器 | `restart: "no"` | 迁移 / 桶初始化失败时不无限重启 |
| 健康检查 | 全部为 `CMD` / `CMD-SHELL`，含 `start_period` | 区分「启动中」与「不健康」 |

健康检查参数：

| 服务 | 检查命令 | interval / timeout / retries / start_period |
|---|---|---|
| postgres | `/usr/local/bin/pg-healthcheck.sh` | 10s / 5s / 10 / 30s |
| minio | `curl -fsS http://127.0.0.1:9000/minio/health/live` | 10s / 5s / 10 / 20s |
| web | `wget -q -O /dev/null http://127.0.0.1:3000/api/health` | 15s / 5s / 5 / 30s |
| caddy | `wget -q -O /dev/null http://127.0.0.1:2019/config/` | 15s / 5s / 5 / 15s |

### 3.3 自建 PostgreSQL 镜像

- 基础镜像：`postgres:16-bookworm`
  - 选择 Debian 而非 Alpine：`pg_bigm` 在 musl 上缺少上游兼容保证；Debian 与 pgvector 官方构建路径一致。
- 扩展版本（锁定 tag，不使用 latest）：
  - `pgvector v0.8.7`
  - `pg_bigm v1.2-20250903`（上游 tag 形如 `v1.2-YYYYMMDD`，**不存在 `1.2` 这个 tag**，已修正）
  - `pg_trgm`：官方 contrib，随基础镜像自带
- 构建方式：builder 阶段编译安装，运行阶段只 `COPY` 扩展 `.so` / `.control` / `.sql`，不带编译工具链。

`00-init.sh` 仅在**数据目录为空**时执行，职责：

1. `CREATE EXTENSION IF NOT EXISTS vector / pg_bigm / pg_trgm`
2. 创建两个角色（已存在则跳过创建，随后强制收权）
3. 库归属迁移角色，撤销 `PUBLIC` 的库权限，只授予必要连接与 schema usage
4. 为迁移角色设置默认权限，后续建表自动给业务角色 DML 权限（RLS 仍逐行生效）

| 角色 | 用途 | 权限约束 |
|---|---|---|
| `postgres` | 超级用户，仅 initdb / 运维 | 不进入任何连接串 |
| `jxf_owner` | migrate 容器、表结构 owner | `NOSUPERUSER / NOCREATEDB / NOCREATEROLE / NOBYPASSRLS` |
| `jxf_app` | web 运行时 | 同上，且只有 `CONNECT` + `USAGE public` |

> 这对应 Master Plan §3.1 红线 1：应用连接禁止使用 owner / superuser。

`healthcheck.sh` 除 `pg_isready` 外，还校验三个扩展计数必须为 3，避免「PG 健康但中文检索能力缺失」被误判为可用。

### 3.4 migrate 容器（幂等关键）

`docker/migrate/entrypoint.mjs` 执行顺序：

1. 以 `MIGRATION_DATABASE_URL`（`jxf_owner`）连接，最多重试 10 次（2s 间隔）
2. 若存在 `db/migrations/meta/_journal.json`，执行 `drizzle migrate`
3. 按文件名排序逐个执行 `db/policies/*.sql`，**每个文件一个事务**，失败立即 ROLLBACK 并退出 1
4. 断言 `vector / pg_bigm / pg_trgm` 三个扩展存在，否则退出 1
5. 输出 `migrate_completed` JSON，退出 0

幂等机制：

| 层 | 机制 |
|---|---|
| drizzle 迁移 | `drizzle.__drizzle_migrations` 记录已应用条目，重复执行只跳过 |
| policies | 约定 SQL 自身幂等（`CREATE OR REPLACE` / `DROP ... IF EXISTS`），每次 up 全量重放 |
| 桶初始化 | `mc mb --ignore-existing` + `mc anonymous set none` |
| 一次性容器 | `restart: "no"`，每次 `up` 重新执行但结果不变 |

P0 基线迁移 `0000_p0_baseline.sql` 不建业务表，只断言三个扩展存在——这样「迁移链路真实跑通」与「空库可启动」可以同时验证。

### 3.5 web 容器

- Next.js 15.5.28，`output: "standalone"`；运行镜像只含 standalone 产物、静态资源与 `public/`
- 非 root 用户 `nextjs:nodejs`（uid/gid 1001）
- `instrumentation.ts` 在进程启动时校验环境变量；**Next 会吞掉 instrumentation 异常并继续监听端口**，因此校验失败时显式 `process.exit(1)`，确保容器退出
- 健康接口语义：
  - `/api/health/live`：存活探针，不依赖 DB / 对象存储，恒 200
  - `/api/health`：就绪探针，检查 DB 连接 + 三扩展 + MinIO，任一失败返回 503
  - `/health`：可视化页面，展示版本、运行时长、依赖明细
- `middleware.ts` 为每个请求生成/透传 `x-request-id`，并以 JSON 记录 `http_request`

### 3.6 Caddy

- 站点地址由 `JXF_SITE_ADDRESS` 控制，默认 `:80`；生产填域名后按注释启用 `tls internal` 或 ACME
- 访问日志 `format json` 输出到 stdout，交给 Docker 日志驱动
- 安全响应头：`nosniff`、`SAMEORIGIN`、`strict-origin-when-cross-origin`、`Permissions-Policy`，并移除 `Server`
- `reverse_proxy` 启用主动健康检查（`/api/health/live`，15s）

### 3.7 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `COMPOSE_PROJECT_NAME` | 否 | `jxf-ai` | Compose 项目名 |
| `JXF_ENV` | 否 | `production` | 展示在健康页 |
| `JXF_LOG_LEVEL` | 否 | `info` | `debug / info / warn / error`，非法值拒绝启动 |
| `JXF_VERSION` | 否 | `0.1.0-p0` | 健康页版本 |
| `NPM_REGISTRY` | 否 | `https://registry.npmjs.org` | 构建期 npm 源（内网 / 国内镜像可替换） |
| `JXF_SITE_ADDRESS` | 否 | `:80` | Caddy 站点地址 |
| `JXF_HTTP_PORT` / `JXF_HTTPS_PORT` | 否 | `80` / `443` | 宿主机映射端口 |
| `JXF_AUTH_SECRET` | **是** | — | ≥32 字符，弱值黑名单拒绝启动 |
| `JXF_DATA_ENCRYPTION_KEY` | 否 | — | 设置面密文专用密钥；留空回退到 `JXF_AUTH_SECRET` 派生（`v1` 密文），配置后新密文为 `v2` |
| `POSTGRES_DB` | **是** | — | 库名 |
| `POSTGRES_USER` | **是** | — | 超级用户（仅 initdb/运维） |
| `POSTGRES_PASSWORD` | **是** | — | 超级用户口令 |
| `POSTGRES_PORT` | 否 | `5432` | 回环映射端口 |
| `JXF_OWNER_USER` / `JXF_OWNER_PASSWORD` | **是** | — | 迁移角色 |
| `JXF_APP_USER` / `JXF_APP_PASSWORD` | **是** | — | 运行时业务角色 |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | **是** | — | MinIO 管理员 |
| `MINIO_BUCKET` | **是** | — | 桶名（同时用于 S3_BUCKET） |
| `MINIO_API_PORT` / `MINIO_CONSOLE_PORT` | 否 | `9000` / `9001` | 回环映射端口 |
| `S3_REGION` | 否 | `us-east-1` | MinIO region |

> 口令会拼进 `postgresql://` 连接串，请只使用 `[A-Za-z0-9]`；模板中已注明。

### 3.8 日志格式

| 组件 | 格式 | 示例关键字段 |
|---|---|---|
| web / migrate | 单行 JSON | `ts / level / service / msg / request_id` |
| caddy | JSON（`format json`） | `level / ts / logger / msg / request` |
| postgres | stderr 文本（PG16 无 JSON 日志） | `log_line_prefix=%m [%p] %q%u@%d/%a`，慢查询 ≥500ms |

---

## 4. 验证与执行结果

### 4.1 执行环境

| 项 | 值 |
|---|---|
| OS | Windows 11 企业版 22631 |
| Docker Desktop | 29.9.2（Linux 引擎，安装目录 `D:\Docker`） |
| Docker Compose | v5.6.1 |
| WSL | 2.7.3.0，内核 6.6.114.1-1 |
| Node.js / npm | v22.23.4 / 10.9.9 |

### 4.2 代码级验证（容器实跑前）

| # | 命令 / 操作 | 结果 |
|---|---|---|
| 1 | `npm install` | 成功，安装 60 个直接/传递包 |
| 2 | `npm run build` | 成功；路由：`/`（静态）、`/health`（动态）、`/api/health`（动态）、`/api/health/live`（动态） |
| 3 | `npm run typecheck` | `tsc --noEmit` 通过 |
| 4 | `node --check docker/migrate/entrypoint.mjs` | 语法通过 |
| 5 | `npx yaml-lint docker/docker-compose.yml` | YAML 语法通过 |
| 6 | 缺失环境变量启动 | **exit 1**，日志：`env_validation_failed`，`环境变量 S3_BUCKET 缺失，拒绝启动（fail-closed）` |
| 7 | 弱密钥启动（`change-me-...`） | **exit 1**，日志：`环境变量 JXF_AUTH_SECRET 命中弱值黑名单，拒绝启动` |
| 8 | `/api/health/live` | `200`，返回 `{"status":"ok","service":"web",...}` |
| 9 | `/api/health`（无依赖的负向验证） | `503`，两项检查均为 `error`：`connect ECONNREFUSED 127.0.0.1:5432`、`fetch failed` |
| 10 | `/health` 页面（无依赖） | `200`，渲染 DEGRADED 与检查明细 |

> 第 6–10 项证明：依赖缺失时进程可以存活，但就绪态明确失败；环境变量缺失/弱值时拒绝启动。

### 4.3 容器实跑：空库启动 + 幂等

执行命令（仓库根目录，Git Bash）：

```bash
bash scripts/verify-p0.sh
```

脚本退出码 **0**，逐项结果（原始日志：[verify-p0-run.log](computer://e:\JXF-AI\verify-p0-run.log)）：

```text
[P0][PASS] compose 配置合法
[P0][PASS] postgres healthy
[P0][PASS] minio healthy
[P0][PASS] web healthy
[P0][PASS] caddy healthy
[P0][PASS] 三个扩展全部安装
[P0][PASS] 基线迁移已应用且仅一条
[P0][PASS] 迁移角色非超级用户
[P0][PASS] 业务角色非超级用户且不绕过 RLS
[P0][PASS] 桶初始化幂等
[P0][PASS] caddy → web /api/health 200
[P0][PASS] 二次执行后迁移记录仍为 1 条
[P0][PASS] 二次 up 幂等（容器 ID 与 StartedAt 均未变化）
[P0] 全部通过。
```

运行态（`docker compose ps`，一次性容器状态略）：

| 服务 | 镜像 | 状态 | 端口 |
|---|---|---|---|
| caddy | `caddy:2.8.4-alpine` | Up (healthy) | `0.0.0.0:80->80`、`443->443` |
| minio | `bitnamilegacy/minio:2024.12.18` | Up (healthy) | `127.0.0.1:9000-9001` |
| postgres | `jxf-ai/postgres:16-p0` | Up (healthy) | `127.0.0.1:5432` |
| web | `jxf-ai/web:0.1.0` | Up (healthy) | `3000/tcp`（仅容器网络） |
| migrate / minio-init | 本地构建 / Bitnami | Exited (0) | — |

健康接口实测（经 Caddy，HTTP 200）：

```json
{"status":"ok","service":"web","version":"0.1.0-p0","app_env":"production","uptime_s":43,
 "checks":[
   {"name":"postgres","status":"ok","latency_ms":1,"detail":"vector@0.8.7 · pg_bigm@1.2 · pg_trgm@1.6"},
   {"name":"object-storage","status":"ok","latency_ms":2,"detail":"bucket=jxf-assets"}
 ],
 "request_id":"cbd2ca12-7bfc-4232-9750-debf406a8f60"}
```

数据面实测：

```text
 extname | extversion        rolname  | rolsuper | rolbypassrls
---------+------------       ----------+----------+--------------
 pg_bigm | 1.2               jxf_app   | f        | f
 pg_trgm | 1.6               jxf_owner | f        | f
 vector  | 0.8.7

 drizzle_rows = 1
 minio bucket dir = jxf-assets
```

幂等性实测（第三次 `up -d` 前后对比）：

```text
--- before ---
/jxf-ai-web-1       2026-10-30T07:47:42.706086742Z
/jxf-ai-caddy-1     2026-10-30T07:47:48.452793162Z
/jxf-ai-minio-1     2026-10-30T07:47:35.998613366Z
/jxf-ai-postgres-1  2026-10-30T07:47:36.203966939Z
--- after ---
（四个容器的 StartedAt 完全一致）
IDsEqual=True   StartedAtEqual=True
```

### 4.4 日志格式实测

迁移容器（JSON，重复执行仍是 `applied_migrations: 1`，未重复应用）：

```json
{"ts":"2026-10-30T07:47:42.439Z","level":"info","service":"migrate","msg":"migrate_completed","applied_migrations":1,"applied_policies":0,"extensions":{"vector":"0.8.7","pg_bigm":"1.2","pg_trgm":"1.6"},"duration_ms":40}
{"ts":"2026-10-30T07:48:01.069Z","level":"info","service":"migrate","msg":"migrate_completed","applied_migrations":1,"applied_policies":0,"extensions":{"vector":"0.8.7","pg_bigm":"1.2","pg_trgm":"1.6"},"duration_ms":18}
```

Web（JSON，`request_id` 贯穿中间件与路由）：

```json
{"ts":"2026-10-30T07:48:26.723Z","level":"info","service":"web","msg":"http_request","request_id":"cbd2ca12-7bfc-4232-9750-debf406a8f60","method":"GET","path":"/api/health"}
{"ts":"2026-10-30T07:48:26.727Z","level":"info","service":"web","msg":"health_check","request_id":"cbd2ca12-7bfc-4232-9750-debf406a8f60","status":"ok","duration_ms":2,"failed_checks":[]}
```

Caddy（JSON 访问日志，透传 `X-Request-Id`）：

```json
{"level":"info","logger":"http.log.access.log0","msg":"handled request","request":{"method":"GET","host":"127.0.0.1","uri":"/api/health"},"status":200,"size":378,"duration":0.0066}
```

PostgreSQL（stderr + 结构化前缀，PG16 无 JSON 日志）：

```text
2026-10-30 07:47:37.638 UTC [1] LOG:  starting PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2) ...
2026-10-30 07:47:37.661 UTC [1] LOG:  database system is ready to accept connections
```

### 4.5 幂等性判定口径与结果

| 判定项 | 通过标准 | 实测结果 |
|---|---|---|
| 容器 | 二次 `up -d` 后 ID 与 `StartedAt` 不变 | ID 集合一致，`StartedAt` 一致 |
| 迁移 | `drizzle.__drizzle_migrations` 两次都为 1 | 1 → 1 |
| 策略 | `db/policies/*.sql` 重放不报错 | 0 个文件，无报错 |
| 桶 | 重复初始化退出 0 | `桶初始化幂等` PASS |
| 数据 | 不带 `-v` 的 up/down 不丢数据 | 空库验证，卷保留 |

### 4.6 fail-closed 实测

- 缺少 `.env` / 必填变量时，`docker compose config --quiet` 直接失败（exit 1），报错示例：

```text
required variable JXF_AUTH_SECRET is missing a value: JXF_AUTH_SECRET 不能为空
required variable MINIO_BUCKET is missing a value: MINIO_BUCKET 不能为空
required variable POSTGRES_DB is missing a value: POSTGRES_DB 不能为空
```

- 应用层：缺失 / 弱 `JXF_AUTH_SECRET` 均 `process.exit(1)`（§4.2 第 6、7 项）。

### 4.7 实跑中遇到的问题与处置

| 问题 | 现象 | 处置 |
|---|---|---|
| MinIO 官方镜像不可用 | Docker Hub `minio/minio` 仓库不存在，`quay.io` 返回 401 | 改用 `bitnamilegacy/minio:2024.12.18`（同版本 MinIO，自带 mc / curl） |
| BuildKit 前端拉取超时 | `# syntax=docker/dockerfile:1` 解析 `auth.docker.io` 超时 | 移除外部前端，改用 Docker 内置 Dockerfile 解析器 |
| 容器内 `npm ci` ECONNRESET | 大包下载中途断连 | 增加 `NPM_REGISTRY` 构建参数 + 5 次重试 / 600s 超时 |
| WSL2 未启用 | Docker 引擎启动报 500 | 启用 WSL / VirtualMachinePlatform 并安装 WSL 2.7.3，重启后生效（环境准备，不涉及仓库代码） |


---

## 5. 避坑与注意事项

### 5.1 PostgreSQL 镜像

1. **扩展只在 initdb 时创建**。已有 `pgdata` 卷不会重跑 `00-init.sh`；新增扩展或角色变更必须写新迁移或显式执行 SQL，不能指望重启容器。
2. **改 `.env` 里的数据库口令不会自动生效**。initdb 只执行一次；需进入容器 `ALTER ROLE ... PASSWORD ...`，或按升级流程重建。
3. `pg_bigm` 上游 tag 是 `v1.2-YYYYMMDD`，不是 `1.2`；升级时先核对 tag。
4. 首次构建需要联网克隆 GitHub 源码；私有化离线交付时需预构建镜像并导入（P5 补充）。
5. 镜像 tag 已锁定，但未锁定 digest；正式交付前建议补 digest 固定。

### 5.2 角色与安全

1. 不要在 `APP_DATABASE_URL` 使用 `jxf_owner` 或 `postgres`，否则 RLS 静默失效（红线 1）。
2. `jxf_app` 已强制 `NOSUPERUSER / NOBYPASSRLS`；P1 建表后需确认 owner 是 `jxf_owner`，否则默认权限不生效。
3. 默认权限只覆盖 `jxf_owner` 新建的表 / 序列；若用其他角色建表，需补授权或统一由迁移角色创建。
4. 口令只允许 URL 安全字符，否则连接串解析失败。

### 5.3 迁移

1. `db/policies/*.sql` 每次 `up` 都会重放，**任何非幂等 SQL 都会导致后续启动失败**。
2. 迁移失败容器退出 1，`web` 不会启动；这是预期行为，先修迁移再重启。
3. 不要手工改 `drizzle.__drizzle_migrations`；需要回滚时用新迁移，不做破坏性回退。
4. P1 用 `drizzle-kit generate` 生成迁移后，仍由同一入口执行，保持「迁移 + 策略」一条链路。

### 5.4 Web

1. Next 的 instrumentation 异常不会自动结束进程，本项目已显式 `process.exit(1)`；后续改动不要去掉。
2. `.env.example` 中的 `CHANGE_ME` 密文会被弱值校验拒绝，这是设计行为，不是 bug。
3. 就绪探针失败会让 `web` 变 unhealthy，进而阻塞 `caddy` 启动；排障顺序应先看 `postgres` / `minio`。
4. standalone 镜像必须同时拷贝 `.next/static` 与 `public`，否则页面无样式 / 静态资源 404。

### 5.5 Compose / 运维

1. 统一使用 `docker compose -f docker/docker-compose.yml --env-file .env ...`；不要依赖默认 `.env` 查找路径（项目目录是 `docker/`）。
2. 一次性容器显示 `Exited (0)` 属于正常状态，不代表编排失败。
3. PostgreSQL / MinIO 端口只绑定 `127.0.0.1`，远程排障请用 SSH 隧道，不要改绑 `0.0.0.0`。
4. 生产前确认宿主机 80/443 未被占用；冲突时用 `JXF_HTTP_PORT` / `JXF_HTTPS_PORT` 调整。
5. `down -v` 会删除数据卷，禁止在生产使用。
6. 构建期 npm 网络不稳定时，在 `.env` 设置 `NPM_REGISTRY`（如 `https://registry.npmmirror.com`）后重跑 `up --build`；镜像内已加 5 次重试与 600s 超时。
7. Dockerfile 不依赖 `# syntax=docker/dockerfile:1` 外部前端，私有化 / 离线环境只需预置基础镜像。

### 5.6 Caddy / MinIO

1. 默认 `:80` 为 HTTP；私有化交付应设置域名并启用 `tls internal`（客户需信任内置 CA）或 ACME。
2. Caddy 的 JSON 访问日志不含业务 `request_id`，跨层排障以 web 日志的 `x-request-id` 为准（Caddy 会透传该头）。
3. P0 阶段 web 使用 MinIO root 凭据；P1/P2 应创建仅限单桶读写的服务账号，并替换 `S3_ACCESS_KEY / S3_SECRET_KEY`。
4. MinIO 控制台仅回环可访问，交付时通过跳板机访问。
5. MinIO 官方镜像已从 Docker Hub 下架、quay.io 需鉴权，当前锁定 `bitnamilegacy/minio:2024.12.18` 归档镜像；P5 交付前必须镜像到客户内网 registry 并固定 digest（归档仓库不作为长期来源）。

---

## 6. P1 接手事项

### 6.1 已为 P1 预置的能力

| 能力 | 现状 | P1 用法 |
|---|---|---|
| 应用 / 迁移角色隔离 | `jxf_app`、`jxf_owner` 已建好并收权 | `SET LOCAL app.user_id / tenant_id / access_level / department_ids` 在 `jxf_app` 事务内注入 |
| 默认权限 | `jxf_owner` 建表自动授权 `jxf_app` | 建表统一走迁移角色，避免漏授权 |
| 迁移链路 | `db/migrations` + `db/policies` 已接通 | 表结构走 drizzle-kit；RLS / 函数 / 视图写入 `db/policies` |
| 扩展 | `vector`、`pg_bigm`、`pg_trgm` 已纳入健康检查 | `doc_chunks` 建 `vector` 列与 `tsv`，检索先用 `pg_bigm` 验证中文召回 |
| 日志 | `request_id` 中间件 + JSON 日志 | 在 DB 事务与 run 上下文中继续透传 `request_id` / `run_id` |
| 健康检查 | live / ready 分离 | ready 可作为后续迁移与冒烟脚本的通用闸门 |

### 6.2 P1 必须补的缺口

1. **RLS 未落地**：P0 没有业务表，因此「未注入身份返回 0 行」尚未实现；P1 必须按 §5.1 十条逐条验收。
2. **连接池与事务封装**：当前 `src/lib/db/pool.ts` 只有连接池；P1 需增加「每请求一个事务 + `SET LOCAL`」的统一入口，禁止裸 `pool.query` 写业务表。
3. **认证**：`JXF_AUTH_SECRET` 目前只做启动校验，尚未签发会话；P1 接入成熟 Auth 库（Better Auth / Auth.js v5），禁止自研票据。
4. **request_id → DB**：需要把中间件生成的 ID 写入审计 / 运行态表，保证跨层可追踪。
5. **备份与升级**：P0 未包含备份脚本与版本表，按 Master Plan 属 M5，但 P1 起就要避免破坏性迁移。

### 6.3 明确不在 P0 范围

- Redis、PgBouncer（当前单机直连；后续上 PgBouncer 必须 Transaction Pooling）
- TLS 证书自动化、客户品牌换肤
- 备份 / 恢复演练、一键升级与回滚
- Python worker（`profile: media`，P2 后再引入）
- 任何业务表、RLS 策略、会话实现

---

## 7. 交付物与闸门

### 7.1 交付物清单

| 文件 | 说明 |
|---|---|
| `docker/docker-compose.yml` | 6 服务编排、依赖条件、健康检查、JSON 日志 |
| `docker/Dockerfile.postgres` | PG16 + pgvector v0.8.7 + pg_bigm v1.2-20250903 |
| `docker/Dockerfile.web` | Next.js standalone 运行镜像（非 root） |
| `docker/Dockerfile.migrate` | 一次性迁移镜像 |
| `docker/postgres/00-init.sh` | 扩展、角色、收权 |
| `docker/postgres/healthcheck.sh` | 扩展齐全性健康检查 |
| `docker/migrate/entrypoint.mjs` | 迁移执行器（幂等、fail-closed） |
| `docker/Caddyfile` | 反代、JSON 日志、安全头 |
| `db/migrations/0000_p0_baseline.sql` + `meta/_journal.json` | P0 基线迁移 |
| `src/**` | `/health`、健康接口、全局错误页、日志、env 校验 |
| `.env.example` | 环境变量模板 |
| `scripts/verify-p0.sh` | 空库启动 + 幂等性验收脚本 |
| `docs/development/P0-infrastructure.md` | 本文件 |
| `docs/gates/P0-gate.md` | 人工闸门清单 |

### 7.2 闸门状态

**已通过（2026-10-30）。**

- 自动化：`scripts/verify-p0.sh` 退出码 0；空库启动、4 个常驻服务 healthy、扩展 3/3、迁移 1 条、二次 `up` 容器 ID 与 `StartedAt` 不变（§4.3 / §4.5）。
- 人工：用户确认并指令打 tag；已打 `gate/p0-passed`。
- 进入 P1 的条件已满足。
