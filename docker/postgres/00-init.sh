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

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  -v owner_user="${JXF_OWNER_USER}" \
  -v owner_password="${JXF_OWNER_PASSWORD}" \
  -v app_user="${JXF_APP_USER}" \
  -v app_password="${JXF_APP_PASSWORD}" \
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

-- 迁移角色后续建表 / 建序列时，自动授予业务角色 DML 权限（RLS 仍逐行生效）
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'owner_user', :'app_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'owner_user', :'app_user')
\gexec
EOSQL

echo "[00-init] extensions (vector, pg_bigm, pg_trgm) and roles (${JXF_OWNER_USER}, ${JXF_APP_USER}) are ready"
