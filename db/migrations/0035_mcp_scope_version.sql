-- 工具集版本：迁移执行前已存在的令牌一律 v1；
-- 新签发由应用显式写入 MCP_SCOPE_VERSION（v2），不依赖列默认值。
alter table "mcp_tokens" add column if not exists "scope_version" integer default 1 not null;
