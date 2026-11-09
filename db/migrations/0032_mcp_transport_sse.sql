alter table "mcp_servers" drop constraint if exists "mcp_servers_transport_check";--> statement-breakpoint
alter table "mcp_servers" add constraint "mcp_servers_transport_check" check ("transport" in ('http', 'stdio', 'sse'));
