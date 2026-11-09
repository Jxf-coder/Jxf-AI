-- ============================================================================
-- jxf_auth 平滑切换（人工执行；migrate 只读取 db/policies，不会自动运行本文件）
--
-- 目标：Auth.js 使用独立受限角色；业务角色 jxf_app 不再持有
--       accounts / sessions / verification_tokens 的 DML，也读不到 users.password_hash。
--
-- 顺序不能颠倒：
--   1) 超级用户创建角色（本节）
--   2) 部署新代码，配置 AUTH_DATABASE_URL 并重启 web
--   3) 执行 db/policies/034_auth_role.sql（随 migrate 自动执行，也可手工执行）
--   4) 验证登录
--   5) 收权（本节最后一段）
--
-- 第 1 步：以超级用户（POSTGRES_USER）连接执行，替换密码与库名
-- ----------------------------------------------------------------------------
-- create role jxf_auth login password 'REPLACE_WITH_RANDOM_PASSWORD'
--   nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
-- grant connect on database jxf to jxf_auth;
-- grant usage on schema public to jxf_auth;
--
-- 第 5 步：确认 AUTH_DATABASE_URL 已生效且登录正常后，以 jxf_owner 执行（可重复）
-- ----------------------------------------------------------------------------

-- Auth.js 三张会话/账号表从此只允许 jxf_auth 访问
revoke select, insert, update, delete
   on accounts, sessions, verification_tokens
   from jxf_app;

-- users 保留业务读，但去掉口令哈希列：表级 SELECT 收回后按列重建
revoke select on users from jxf_app;
grant select (id, name, email, email_verified, image, created_at, phone, status, birthday)
   on users to jxf_app;
