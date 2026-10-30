#!/bin/sh
# PostgreSQL 容器健康检查：
#   1. 实例可接受连接
#   2. 三个必装扩展全部存在（中文检索能力缺失时不允许标记为 healthy）
set -eu

pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -q

count="$(psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc \
  "select count(*) from pg_extension where extname in ('vector','pg_bigm','pg_trgm')")"

if [ "${count}" != "3" ]; then
  echo "required extensions missing: ${count}/3" >&2
  exit 1
fi
