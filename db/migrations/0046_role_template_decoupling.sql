-- ============================================================================
-- W1-03 · 角色模板与等级解耦
--
-- 目的：让 Finance_Director 这类专用角色可以突破 L2 的等级上限，
--       但仍然不能触碰 protected:*（保护区不在目录，天然不可能被授予）。
--
-- 做法：
--   1. role_templates 增加 beyond_level_ceiling 标志（模板级，不是成员级）
--   2. memberships 增加 role_template_key（为空表示沿用等级默认模板）
--   3. 默认模板与 fd 模板的授权由 policies/010 在每次迁移时重放
-- ============================================================================

alter table role_templates add column if not exists beyond_level_ceiling boolean not null default false;
--> statement-breakpoint

alter table memberships add column if not exists role_template_key text;
--> statement-breakpoint

alter table memberships
  add constraint memberships_role_template_fk
  foreign key (role_template_key) references role_templates(id)
  on delete set null on update cascade;
