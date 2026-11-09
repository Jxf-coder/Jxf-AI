#!/bin/sh
# ---------------------------------------------------------------------------
# 仅在数据目录为空（首次初始化）时由官方 entrypoint 执行。
# 职责：
#   1. 创建 pgvector / pg_bigm / pg_trgm 扩展（需要超级用户，因此放在 initdb 阶段）
#   2. 创建两个受限角色：jxf_owner（迁移 owner）、jxf_app（运行时业务角色）
#   3. 收权：业务角色不得是 superuser / bypassrls；库归属迁移角色
# 注：密码轮换不会因为重启生效，需显式 ALTER ROLE（见 P0 文档「避坑」）。
# ---------------------------------------------------------------------------
set -eu

: "${JXF_OWNER_USER:?JXF_OWNER_USER is required}"
: "${JXF_OWNER_PASSWORD:?JXF_OWNER_PASSWORD is required}"
: "${JXF_APP_USER:?JXF_APP_USER is required}"
: "${JXF_APP_PASSWORD:?JXF_APP_PASSWORD is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

# M3：worker 专用受限角色；未配置密码时跳过（运行时队列不可用，业务功能不受影响）
# 角色名固定为 app_worker：RLS 策略按角色名判定，改名会静默失去队列权限
if [ "${JXF_WORKER_USER:-app_worker}" != "app_worker" ]; then
  echo "JXF_WORKER_USER 必须固定为 app_worker（RLS 策略按角色名判定）" >&2
  exit 1
fi
WORKER_USER="app_worker"
WORKER_PASSWORD="${JXF_WORKER_PASSWORD:-}"

# 认证专用角色：Auth.js 只持有 users/accounts/sessions/verification_tokens 的最小 DML。
# 未配置密码时跳过（登录回退到业务角色）；旧库切换见 db/ops/auth-role-cutover.sql
if [ "${JXF_AUTH_USER:-jxf_auth}" != "jxf_auth" ]; then
  echo "JXF_AUTH_USER 必须固定为 jxf_auth（授权按角色名下发）" >&2
  exit 1
fi
AUTH_USER="jxf_auth"
AUTH_PASSWORD="${JXF_AUTH_PASSWORD:-}"

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  -v owner_user="${JXF_OWNER_USER}" \
  -v owner_password="${JXF_OWNER_PASSWORD}" \
  -v app_user="${JXF_APP_USER}" \
  -v app_password="${JXF_APP_PASSWORD}" \
  -v worker_user="${WORKER_USER}" \
  -v worker_password="${WORKER_PASSWORD}" \
  -v auth_user="${AUTH_USER}" \
  -v auth_password="${AUTH_PASSWORD}" \
  -v db_name="${POSTGRES_DB}" <<'EOSQL'
-- 1. 扩展
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_bigm;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. 角色（已存在则跳过创建，随后强制收权）
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'owner_user', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner_user')
\gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'owner_user')
\gexec

SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'app_user')
\gexec

-- worker 角色：仅运行时队列（runs / run_events / run_steps / tool_calls / token_usages）
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'worker_user', :'worker_password')
WHERE :'worker_password' <> '' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'worker_user')
\gexec

SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'worker_user')
WHERE :'worker_password' <> ''
\gexec

-- 认证角色：只供 Auth.js 使用；表级授权由 db/policies/034_auth_role.sql 执行
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'auth_user', :'auth_password')
WHERE :'auth_password' <> '' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'auth_user')
\gexec

SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'auth_user')
WHERE :'auth_password' <> ''
\gexec

-- 3. 库归属与权限
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'owner_user')
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name')
\gexec

SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'db_name', :'owner_user')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'app_user')
\gexec

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'worker_user')
WHERE :'worker_password' <> ''
\gexec

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'worker_user')
WHERE :'worker_password' <> ''
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'auth_user')
WHERE :'auth_password' <> ''
\gexec

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'auth_user')
WHERE :'auth_password' <> ''
\gexec

-- 迁移角色后续建表 / 建序列时，自动授予业务角色 DML 权限（RLS 仍逐行生效）
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'owner_user', :'app_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'owner_user', :'app_user')
\gexec
EOSQL

echo "[00-init] extensions (vector, pg_bigm, pg_trgm) and roles (${JXF_OWNER_USER}, ${JXF_APP_USER}, ${AUTH_USER}) are ready"
