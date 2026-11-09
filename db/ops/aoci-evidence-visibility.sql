-- ============================================================================
-- AOCI Database Evidence 可见性（人工执行；migrate 不读取本文件）
--
-- 背景：AOCI 证据扫描使用受限业务角色连接，只能看到该角色拥有任意表权限的表。
-- security hardening 之后，accounts / sessions / verification_tokens 对 jxf_app
-- 已完全收权，department_closure 也只经 SECURITY DEFINER 函数访问，因此这四张表
-- 会从证据快照中消失，导致数据库认知缺表、check 进入 blocked。
--
-- REFERENCES 是唯一不授予读取、写入、删除数据的表级权限，只允许建立外键引用；
-- 业务角色没有 DDL 权限，因此该授权对运行时无效，仅用于让证据扫描看见表结构。
-- ============================================================================

grant references on department_closure, accounts, sessions, verification_tokens to jxf_app;
