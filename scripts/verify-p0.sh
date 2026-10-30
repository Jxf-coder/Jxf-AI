#!/usr/bin/env bash
# =============================================================================
# Phase 0 验收脚本（在具备 Docker 的 Linux 宿主机 / WSL 中执行）
#
# 覆盖：
#   1. compose 配置校验
#   2. 首次 up --build（空卷启动）
#   3. 健康检查全部 healthy
#   4. 扩展 / 角色 / 迁移记录 / 桶 校验
#   5. 重复 up 幂等（容器 ID 不变、迁移记录不增长）
#
# 用法：
#   bash scripts/verify-p0.sh
# 前置：docker + docker compose v2.20+；首次运行会自动生成 .env（随机密钥）
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE=(docker compose -f docker/docker-compose.yml)

fail() {
  echo "[P0][FAIL] $*" >&2
  exit 1
}

pass() {
  echo "[P0][PASS] $*"
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

bootstrap_env() {
  if [[ -f .env ]]; then
    return
  fi

  echo "[P0] 未找到 .env，基于 .env.example 生成随机密钥"
  cp .env.example .env

  local replacements=(
    "JXF_AUTH_SECRET"
    "POSTGRES_PASSWORD"
    "JXF_OWNER_PASSWORD"
    "JXF_APP_PASSWORD"
    "MINIO_ROOT_PASSWORD"
  )
  local key
  for key in "${replacements[@]}"; do
    sed -i "s|^${key}=.*|${key}=$(random_hex)|" .env
  done
}

service_id() {
  "${COMPOSE[@]}" ps -q "$1"
}

running_snapshot() {
  "${COMPOSE[@]}" --env-file .env ps -q \
    | sort \
    | xargs -r docker inspect --format '{{.Name}} {{.State.StartedAt}}' \
    | sort
}

wait_healthy() {
  local service="$1"
  local deadline=$((SECONDS + 240))
  local status="unknown"

  while (( SECONDS < deadline )); do
    local id
    id="$(service_id "${service}")"
    if [[ -n "${id}" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${id}" 2>/dev/null || echo unknown)"
      if [[ "${status}" == "healthy" ]]; then
        pass "${service} healthy"
        return
      fi
    fi
    sleep 3
  done

  fail "${service} 未在 240s 内变为 healthy（最后状态：${status}）"
}

assert_sql() {
  local label="$1"
  local sql="$2"
  local result
  result="$("${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc "${sql}")"
  [[ "${result}" == "1" ]] || fail "${label} 校验失败（结果：${result}）"
  pass "${label}"
}

bootstrap_env
set -a
# shellcheck disable=SC1091
source .env
set +a

echo "[P0] 1/5 compose 配置校验"
"${COMPOSE[@]}" --env-file .env config --quiet
pass "compose 配置合法"

echo "[P0] 2/5 首次 up --build（空库启动）"
"${COMPOSE[@]}" --env-file .env up -d --build

echo "[P0] 3/5 等待健康检查"
wait_healthy postgres
wait_healthy minio
wait_healthy web
wait_healthy caddy

FIRST_IDS="$("${COMPOSE[@]}" --env-file .env ps -q | sort | tr '\n' ' ')"
FIRST_STARTED="$(running_snapshot)"

echo "[P0] 4/5 数据面校验"
assert_sql "三个扩展全部安装" \
  "select case when count(*) = 3 then 1 else 0 end from pg_extension where extname in ('vector','pg_bigm','pg_trgm')"
assert_sql "基线迁移已应用且仅一条" \
  "select case when count(*) = 1 then 1 else 0 end from drizzle.\"__drizzle_migrations\""
assert_sql "迁移角色非超级用户" \
  "select case when count(*) = 1 then 1 else 0 end from pg_roles where rolname = '${JXF_OWNER_USER}' and rolsuper = false and rolbypassrls = false"
assert_sql "业务角色非超级用户且不绕过 RLS" \
  "select case when count(*) = 1 then 1 else 0 end from pg_roles where rolname = '${JXF_APP_USER}' and rolsuper = false and rolbypassrls = false"

"${COMPOSE[@]}" --env-file .env run --rm minio-init >/dev/null
pass "桶初始化幂等"

HEALTH_CODE="$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${JXF_HTTP_PORT}/api/health")"
[[ "${HEALTH_CODE}" == "200" ]] || fail "经 caddy 访问 /api/health 返回 ${HEALTH_CODE}"
pass "caddy → web /api/health 200"

echo "[P0] 5/5 二次 up 幂等校验"
"${COMPOSE[@]}" --env-file .env up -d
SECOND_IDS="$("${COMPOSE[@]}" --env-file .env ps -q | sort | tr '\n' ' ')"
SECOND_STARTED="$(running_snapshot)"
[[ "${FIRST_IDS}" == "${SECOND_IDS}" ]] || fail "二次 up 发生容器重建（非幂等）"
[[ "${FIRST_STARTED}" == "${SECOND_STARTED}" ]] || fail "二次 up 容器 StartedAt 变化（发生重启，非幂等）"
assert_sql "二次执行后迁移记录仍为 1 条" \
  "select case when count(*) = 1 then 1 else 0 end from drizzle.\"__drizzle_migrations\""
pass "二次 up 幂等（容器 ID 与 StartedAt 均未变化）"

echo
echo "[P0] 全部通过。健康检查日志："
"${COMPOSE[@]}" --env-file .env logs --tail 20 migrate
