-- MCP 连接器节点化：区分接入 / 接出方向，并加入角色限制
--
-- 目的：
--   - 接入 / 接出 都是「连接器节点」，用同一套基础字段维护；
--   - 细粒度令牌与审批不再混入节点创建，统一收口到全局权限矩阵与独立令牌抽屉；
--   - 节点只保留 roles 角色限制（空 = 全角色）。

alter table "mcp_servers" add column if not exists "direction" text not null default 'inbound';
--> statement-breakpoint
alter table "mcp_servers" add column if not exists "node_key" text;
--> statement-breakpoint
alter table "mcp_servers" add column if not exists "roles" text[] default '{}'::text[] not null;
--> statement-breakpoint
update "mcp_servers"
   set "node_key" = coalesce(
         nullif(regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'), ''),
         "id"::text
       )
 where "node_key" is null;
--> statement-breakpoint
alter table "mcp_servers" alter column "node_key" set not null;
--> statement-breakpoint
alter table "mcp_servers" drop constraint if exists "mcp_servers_direction_valid";
--> statement-breakpoint
alter table "mcp_servers" add constraint "mcp_servers_direction_valid"
  check ("direction" in ('inbound', 'outbound'));
--> statement-breakpoint
alter table "mcp_servers" drop constraint if exists "mcp_servers_node_key_shape";
--> statement-breakpoint
alter table "mcp_servers" add constraint "mcp_servers_node_key_shape"
  check ("node_key" ~ '^[a-z0-9][a-z0-9-]{1,63}$');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_direction_key_unique"
  ON "mcp_servers" ("tenant_id", "direction", "node_key");
