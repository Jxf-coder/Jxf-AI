# P0 人工闸门（Hard Gate）

> 阶段：Phase 0 · 环境底座
> 验收主体：用户本人（不接受 AI 自评通过）
> 开发记录：[P0-infrastructure.md](../development/P0-infrastructure.md)

## 交付物

- `docker/`：compose、web / postgres / migrate Dockerfile、Caddyfile、PG 初始化与健康检查脚本、迁移入口
- 自建 PG 镜像经 healthcheck 校验 pgvector / pg_bigm / pg_trgm 三个扩展
- `db/`：drizzle 基线迁移、policies 目录
- `src/`：`/health` 页面、`/api/health`、`/api/health/live`、全局错误页、JSON 日志、env fail-closed
- `.env.example`
- `scripts/verify-p0.sh`
- `docs/development/P0-infrastructure.md`

## 验收步骤（可照着点的路径）

> 第 1–4、6–10 项已由 `scripts/verify-p0.sh` 自动执行并通过（2026-10-30）；
> 第 5 项已用 curl 确认返回 READY 与三个扩展版本，仍需用户本人在浏览器复核。

- [x] 1. `cp .env.example .env`，替换全部 `CHANGE_ME`；`JXF_AUTH_SECRET` 用 `openssl rand -hex 32`（脚本已自动生成随机密钥）
- [x] 2. `docker compose -f docker/docker-compose.yml --env-file .env config --quiet` 无报错
- [x] 3. `docker compose -f docker/docker-compose.yml --env-file .env up -d --build` 成功
- [x] 4. `docker compose ... ps` 中 postgres / minio / web / caddy 均为 `healthy`
- [x] 5. 浏览器打开 `http://localhost/health`：状态为 READY，postgres 明细含 `vector@0.8.7 · pg_bigm@1.2 · pg_trgm@1.6`
- [x] 6. `curl -i http://localhost/api/health` 返回 200，响应头含 `x-request-id`
- [x] 7. 再执行一次 `up -d`：容器 ID 与 `StartedAt` 均不变
- [x] 8. `docker compose logs migrate` 为 JSON，含 `migrate_completed`，`applied_migrations: 1`
- [x] 9. 二次执行后 `select count(*) from drizzle."__drizzle_migrations"` 仍为 1
- [x] 10. 缺少 `.env` / 必填变量时 compose 直接失败（exit 1），恢复后正常

## 证据

- 自动化脚本退出码：`0`，全部 `[P0][PASS]`
- 健康接口：`200`，`checks` 两项均为 `ok`
- 幂等：`IDsEqual=True`、`StartedAtEqual=True`
- 原始日志：[verify-p0-run.log](computer://e:\JXF-AI\verify-p0-run.log)

## 不通过项

- （无自动化失败项）

## 结论：通过（2026-10-30）

> 自动化验收全部通过，用户确认并指令打 tag `gate/p0-passed`，P1 已启动。
