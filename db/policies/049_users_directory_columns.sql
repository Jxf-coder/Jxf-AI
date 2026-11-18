-- ============================================================================
-- users 目录列：补充列级读授权
--
-- db/ops/auth-role-cutover.sql 会收回 jxf_app 对 users 的表级 SELECT，再按列重建，
-- 目的只是屏蔽 password_hash。此后 users 新增的列必须在这里显式补授权，否则任何
-- 引用该列的查询都会整条语句报 42501（permission denied for table users）。
--
-- W1-04 新增 users.manager_user_id 后遗漏了这一步，导致 /admin/organization
-- 的员工列表查询直接 500，现补齐。语句幂等，新库（未做收权）执行也无副作用。
-- ============================================================================

grant select (manager_user_id) on users to jxf_app;
